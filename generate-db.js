#!/usr/bin/env node
/**
 * HTMLplay Pipeline — generate-db.js
 *
 * Usage:
 *   node pipeline/generate-db.js [--source ./games-raw] [--out ./data]
 *
 * What it does:
 *   1. Reads all game JSON/YAML files from source directory (one per game)
 *   2. Validates schema (required fields, slug format, thumbnail exists)
 *   3. Computes trendingScore for every game
 *   4. Splits into 50-game chunks → /data/chunks/chunk-000.json
 *   5. Generates a lightweight index → /data/games-index.json
 *   6. Generates category sub-indexes → /data/categories/<cat>.json
 *   7. Reports broken/missing thumbnails
 *
 * Run this in CI before each deploy:
 *   "build": "node pipeline/generate-db.js && node pipeline/generate-sitemap.js"
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const ARGS = process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc[a.slice(2)] = arr[i+1] || true;
  return acc;
}, {});

const SOURCE_DIR   = path.resolve(ROOT, ARGS.source || './games-raw');
const OUT_DIR      = path.resolve(ROOT, ARGS.out    || './data');
const CHUNKS_DIR   = path.join(OUT_DIR, 'chunks');
const CATS_DIR     = path.join(OUT_DIR, 'categories');
const CHUNK_SIZE   = parseInt(ARGS['chunk-size'] || '50', 10);

/* ── UTILITIES ──────────────────────────────────────────── */
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf-8');
  const kb = (fs.statSync(filePath).size / 1024).toFixed(1);
  console.log(`  ✅ ${path.relative(ROOT, filePath)} — ${kb}KB`);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ── TRENDING SCORE ─────────────────────────────────────── */
function computeTrendingScore(game) {
  const now       = Date.now();
  const added     = new Date(game.dateAdded || Date.now()).getTime();
  const daysSince = (now - added) / 86400000;

  const playScore   = Math.log10((game.playCount || 0) + 1) * 1000;
  const recency     = Math.exp(-daysSince / 30) * 500;
  // Bayesian average — prevents 1-vote 5-star manipulation
  const bayesRating = ((game.rating || 0) * (game.ratingCount || 0))
                    / ((game.ratingCount || 0) + 100);
  const ratingScore = bayesRating * 200;

  return Math.round(playScore + recency + ratingScore);
}

/* ── VALIDATION ─────────────────────────────────────────── */
const REQUIRED = ['id', 'slug', 'title', 'category', 'thumbnail', 'gameUrl'];

function validate(game, file) {
  const errors = [];
  for (const field of REQUIRED) {
    if (!game[field]) errors.push(`Missing required field: ${field}`);
  }
  if (game.slug && !/^[a-z0-9-]+$/.test(game.slug)) {
    errors.push(`Invalid slug format: "${game.slug}" (use lowercase-kebab-case)`);
  }
  if (game.rating && (game.rating < 0 || game.rating > 5)) {
    errors.push(`Rating out of range: ${game.rating}`);
  }
  if (errors.length) {
    console.warn(`⚠️  ${file}: ${errors.join('; ')}`);
    return false;
  }
  return true;
}

/* ── MAIN ───────────────────────────────────────────────── */
async function main() {
  console.log('\n🎮 HTMLplay — Database Generator');
  console.log('─'.repeat(40));

  ensureDir(CHUNKS_DIR);
  ensureDir(CATS_DIR);

  // Load source games (supports: single games.sample.json or dir of individual files)
  let allGames = [];
  let invalidCount = 0;

  if (fs.existsSync(SOURCE_DIR) && fs.statSync(SOURCE_DIR).isDirectory()) {
    const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.json'));
    console.log(`\n📂 Loading ${files.length} game files from ${SOURCE_DIR}`);
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf-8'));
        if (validate(data, file)) allGames.push(data);
        else invalidCount++;
      } catch (err) {
        console.error(`❌ Failed to parse ${file}: ${err.message}`);
        invalidCount++;
      }
    }
  } else {
    // Fall back to bundled sample
    const samplePath = path.join(OUT_DIR, 'games.sample.json');
    if (!fs.existsSync(samplePath)) {
      console.error('❌ No game source found. Create ./games-raw/ or provide games.sample.json');
      process.exit(1);
    }
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf-8'));
    allGames = sample.games || [];
    console.log(`📦 Loaded ${allGames.length} games from sample`);
  }

  console.log(`\n📊 Total valid games: ${allGames.length} (${invalidCount} invalid skipped)`);

  // Ensure slugs are unique
  const slugsSeen = new Set();
  allGames = allGames.filter(g => {
    if (slugsSeen.has(g.slug)) { console.warn(`⚠️  Duplicate slug skipped: ${g.slug}`); return false; }
    slugsSeen.add(g.slug);
    return true;
  });

  // Compute trendingScore
  for (const game of allGames) {
    game.trendingScore = computeTrendingScore(game);
    if (!game.slug && game.title) game.slug = slugify(game.title);
  }

  // Sort by trendingScore desc (chunks maintain natural sort order)
  allGames.sort((a, b) => b.trendingScore - a.trendingScore);

  // ── WRITE CHUNKS ───────────────────────────────────────
  console.log(`\n📦 Writing chunks (${CHUNK_SIZE} games each):`);
  const totalChunks = Math.ceil(allGames.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = allGames.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const key   = String(i).padStart(3, '0');
    writeJson(path.join(CHUNKS_DIR, `chunk-${key}.json`), {
      chunk: i,
      total: allGames.length,
      games: chunk,
    });
  }

  // ── WRITE LIGHTWEIGHT INDEX ────────────────────────────
  // Index only contains fields needed for search + routing — keeps index.json small
  console.log('\n📇 Writing index:');
  const indexEntries = allGames.map((g, idx) => ({
    id:         g.id,
    slug:       g.slug,
    title:      g.title,
    thumbnail:  g.thumbnail,
    category:   g.category,
    tags:       g.tags?.slice(0, 5) || [],   // max 5 tags in index to keep small
    trendingScore: g.trendingScore,
    chunk:      Math.floor(idx / CHUNK_SIZE),
  }));

  writeJson(path.join(OUT_DIR, 'games-index.json'), {
    generated:   new Date().toISOString(),
    total:       allGames.length,
    totalChunks,
    chunkSize:   CHUNK_SIZE,
    entries:     indexEntries,
  });

  // ── WRITE CATEGORY INDEXES ─────────────────────────────
  console.log('\n🗂️  Writing category indexes:');
  const byCategory = {};
  for (const [i, game] of allGames.entries()) {
    if (!byCategory[game.category]) byCategory[game.category] = [];
    byCategory[game.category].push({
      id: game.id, slug: game.slug, title: game.title,
      thumbnail: game.thumbnail, trendingScore: game.trendingScore,
      chunk: Math.floor(i / CHUNK_SIZE),
    });
  }

  for (const [cat, games] of Object.entries(byCategory)) {
    writeJson(path.join(CATS_DIR, `${cat}.json`), {
      category: cat,
      total: games.length,
      games,
    });
  }

  // ── THUMBNAIL AUDIT ────────────────────────────────────
  const ASSETS_DIR = path.join(ROOT, 'assets', 'thumbnails');
  if (fs.existsSync(ASSETS_DIR)) {
    console.log('\n🖼️  Auditing thumbnails:');
    let missing = 0;
    for (const game of allGames) {
      const thumbPath = path.join(ROOT, game.thumbnail.replace(/^\//, ''));
      if (!fs.existsSync(thumbPath)) {
        console.warn(`   ⚠️  Missing: ${game.thumbnail} (${game.slug})`);
        missing++;
      }
    }
    if (missing === 0) console.log('   ✅ All thumbnails present');
    else console.log(`   ❌ ${missing} missing thumbnails`);
  }

  // ── SUMMARY ────────────────────────────────────────────
  console.log('\n' + '─'.repeat(40));
  console.log(`✅ Done! ${allGames.length} games in ${totalChunks} chunks.`);
  console.log(`   Index size: ~${Math.round(allGames.length * 120 / 1024)}KB uncompressed`);
  console.log(`   Per-chunk:  ~${Math.round(CHUNK_SIZE * 2400 / 1024)}KB uncompressed`);
  console.log('\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
