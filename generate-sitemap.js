#!/usr/bin/env node
/**
 * HTMLplay Pipeline — generate-sitemap.js
 *
 * Generates:
 *   - /sitemap.xml         → sitemap index (links to all sub-sitemaps)
 *   - /sitemap-core.xml    → homepage + category pages
 *   - /sitemap-games.xml   → all individual game pages
 *
 * SEO rationale:
 *   Split sitemaps allow Google to crawl in priority order.
 *   lastmod = dateAdded (signals freshness to crawler).
 *   changefreq "weekly" for games, "daily" for homepage.
 *   Priority: homepage(1.0) → category(0.8) → game(0.6–0.9 based on trendingScore)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const BASE_URL  = process.env.SITE_URL || 'https://htmlplay.io';

function writeXml(filePath, xml) {
  fs.writeFileSync(filePath, xml.trim(), 'utf-8');
  const kb = (fs.statSync(filePath).size / 1024).toFixed(1);
  console.log(`  ✅ ${path.relative(ROOT, filePath)} — ${kb}KB`);
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>
    ${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

function sitemapDoc(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.join('\n')}
</urlset>`;
}

async function main() {
  console.log('\n🗺️  HTMLplay — Sitemap Generator');
  console.log('─'.repeat(40));

  // Load index
  const indexPath = path.join(ROOT, 'data', 'games-index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('❌ games-index.json not found. Run generate-db.js first.');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const games = index.entries || [];

  // Load categories from config
  let categories = ['action', 'arcade', 'puzzle', 'racing', 'sports', 'horror', 'idle', 'shooter', 'adventure', 'multiplayer'];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf-8'));
    categories = cfg.categories?.map(c => c.slug) || categories;
  } catch {}

  const today = new Date().toISOString().split('T')[0];

  // ── CORE SITEMAP ────────────────────────────────────────
  const coreEntries = [
    urlEntry(`${BASE_URL}/`, today, 'daily', '1.0'),
    urlEntry(`${BASE_URL}/trending`, today, 'daily', '0.9'),
    urlEntry(`${BASE_URL}/new`, today, 'daily', '0.9'),
    ...categories.map(cat =>
      urlEntry(`${BASE_URL}/category/${cat}`, today, 'weekly', '0.8')
    ),
  ];

  writeXml(path.join(ROOT, 'sitemap-core.xml'), sitemapDoc(coreEntries));

  // ── GAMES SITEMAP ───────────────────────────────────────
  // Priority = normalised trendingScore (0.6–0.9 range)
  const maxScore = Math.max(...games.map(g => g.trendingScore || 0), 1);

  const gameEntries = games.map(game => {
    const priority = (0.6 + 0.3 * ((game.trendingScore || 0) / maxScore)).toFixed(1);
    return urlEntry(
      `${BASE_URL}/game/${game.slug}`,
      today,
      'monthly',
      priority
    );
  });

  // Google allows max 50,000 URLs per sitemap file
  const BATCH = 50000;
  const gamesSitemaps = [];
  for (let i = 0; i < gameEntries.length; i += BATCH) {
    const batch = gameEntries.slice(i, i + BATCH);
    const filename = gameEntries.length > BATCH
      ? `sitemap-games-${Math.floor(i/BATCH)}.xml`
      : 'sitemap-games.xml';
    writeXml(path.join(ROOT, filename), sitemapDoc(batch));
    gamesSitemaps.push(filename);
  }

  // ── SITEMAP INDEX ───────────────────────────────────────
  const sitemapIndexFiles = ['sitemap-core.xml', ...gamesSitemaps];
  const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapIndexFiles.map(f => `  <sitemap>
    <loc>${BASE_URL}/${f}</loc>
    <lastmod>${today}</lastmod>
  </sitemap>`).join('\n')}
</sitemapindex>`;

  writeXml(path.join(ROOT, 'sitemap.xml'), indexXml);

  // ── ROBOTS.TXT ──────────────────────────────────────────
  const robotsTxt = `User-agent: *
Allow: /

# Disallow private/internal paths
Disallow: /pipeline/
Disallow: /data/chunks/    # Crawlers don't need raw data files
Disallow: /.git/

# Sitemaps
Sitemap: ${BASE_URL}/sitemap.xml

# Crawl delay for bots other than Googlebot
User-agent: Baiduspider
Crawl-delay: 10

User-agent: Yandexbot
Crawl-delay: 10
`;

  fs.writeFileSync(path.join(ROOT, 'robots.txt'), robotsTxt, 'utf-8');
  console.log('  ✅ robots.txt');

  console.log('\n' + '─'.repeat(40));
  console.log(`✅ Sitemaps generated: ${games.length} game URLs across ${gamesSitemaps.length} game sitemap(s).`);
  console.log('\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
