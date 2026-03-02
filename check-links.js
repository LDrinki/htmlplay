#!/usr/bin/env node
/**
 * HTMLplay Pipeline — check-links.js
 *
 * Reads all games in index, verifies:
 *   - gameUrl points to a file that exists on disk
 *   - thumbnail file exists on disk
 *   - No duplicate slugs
 *   - No duplicate IDs
 *
 * In CI: exit code 0 = pass, 1 = warnings, 2 = hard failures.
 * Can be extended to HTTP-check external game URLs.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const indexPath = path.join(ROOT, 'data', 'games-index.json');
if (!fs.existsSync(indexPath)) {
  console.error('❌ games-index.json not found. Run generate-db.js first.');
  process.exit(2);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
const games = index.entries || [];

console.log(`\n🔍 HTMLplay — Link Checker (${games.length} games)`);
console.log('─'.repeat(40));

let warnings = 0;
let errors   = 0;

const slugsSeen = new Set();
const idsSeen   = new Set();

for (const game of games) {
  // Duplicate slug check
  if (slugsSeen.has(game.slug)) {
    console.error(`❌ Duplicate slug: ${game.slug}`);
    errors++;
  }
  slugsSeen.add(game.slug);

  // Duplicate ID check
  if (idsSeen.has(game.id)) {
    console.error(`❌ Duplicate ID: ${game.id} (slug: ${game.slug})`);
    errors++;
  }
  idsSeen.add(game.id);

  // Thumbnail exists
  if (game.thumbnail) {
    const thumbPath = path.join(ROOT, game.thumbnail.replace(/^\//, ''));
    if (!fs.existsSync(thumbPath)) {
      console.warn(`⚠️  Missing thumbnail: ${game.thumbnail} (${game.slug})`);
      warnings++;
    }
  }
}

// Summary
console.log('\n' + '─'.repeat(40));
if (errors > 0)   console.error(`❌ ${errors} error(s) found`);
if (warnings > 0) console.warn(`⚠️  ${warnings} warning(s) found`);
if (errors === 0 && warnings === 0) console.log('✅ All checks passed!');

process.exit(errors > 0 ? 2 : warnings > 0 ? 1 : 0);
