#!/usr/bin/env node
/**
 * HTMLplay Pipeline — optimize-images.js
 *
 * Strategy:
 *   1. Convert all PNG/JPG thumbnails → WebP (lossy, quality 80)
 *   2. Generate 2 sizes: 240×180 (card) + 640×480 (featured)
 *   3. Add <picture> fallback for non-WebP browsers (rare in 2025)
 *   4. Output to /assets/thumbnails/*.webp
 *
 * Run: node pipeline/optimize-images.js
 * Requires: npm install sharp
 *
 * Rationale:
 *   WebP at q80 is ~35% smaller than JPEG at q90 for same quality.
 *   For 10,000 thumbnails at avg 40KB → saves ~140MB of CDN egress.
 *   Cloudflare Polish can also handle this automatically (Enterprise plan).
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// Try to import sharp (optional dep)
let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('⚠️  sharp not installed. Run: npm install sharp');
  console.log('   Skipping image optimisation.');
  process.exit(0);
}

const THUMB_IN  = path.join(ROOT, 'assets', 'thumbnails-raw');
const THUMB_OUT = path.join(ROOT, 'assets', 'thumbnails');
const FEAT_IN   = path.join(ROOT, 'assets', 'featured-raw');
const FEAT_OUT  = path.join(ROOT, 'assets', 'featured');

const SIZES = {
  thumbnail: { w: 240, h: 180, quality: 82 },
  featured:  { w: 800, h: 500, quality: 85 },
};

async function processDir(inputDir, outputDir, size) {
  if (!fs.existsSync(inputDir)) {
    console.log(`⏭️  Skipping ${inputDir} (not found)`);
    return { processed: 0, skipped: 0 };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs.readdirSync(inputDir).filter(f => /\.(png|jpg|jpeg|gif|bmp)$/i.test(f));

  let processed = 0, skipped = 0, totalSavedBytes = 0;

  for (const file of files) {
    const base    = path.basename(file, path.extname(file));
    const inPath  = path.join(inputDir, file);
    const outPath = path.join(outputDir, `${base}.webp`);

    // Skip if already processed and source hasn't changed
    if (fs.existsSync(outPath)) {
      const inStat  = fs.statSync(inPath);
      const outStat = fs.statSync(outPath);
      if (outStat.mtimeMs > inStat.mtimeMs) { skipped++; continue; }
    }

    try {
      const inSize = fs.statSync(inPath).size;
      await sharp(inPath)
        .resize(size.w, size.h, { fit: 'cover', position: 'center' })
        .webp({ quality: size.quality, effort: 4 })
        .toFile(outPath);

      const outSize = fs.statSync(outPath).size;
      const saved   = inSize - outSize;
      totalSavedBytes += saved;

      const saving = ((saved / inSize) * 100).toFixed(0);
      console.log(`  ✅ ${base}.webp — ${saving}% smaller (${(outSize/1024).toFixed(0)}KB)`);
      processed++;
    } catch (err) {
      console.warn(`  ⚠️  Failed: ${file} — ${err.message}`);
    }
  }

  console.log(`\n   Processed: ${processed}, Skipped (unchanged): ${skipped}`);
  console.log(`   Total space saved: ${(totalSavedBytes / 1024 / 1024).toFixed(1)}MB`);

  return { processed, skipped };
}

async function main() {
  console.log('\n🖼️  HTMLplay — Image Optimiser');
  console.log('─'.repeat(40));

  console.log('\n📷 Thumbnails (240×180):');
  await processDir(THUMB_IN, THUMB_OUT, SIZES.thumbnail);

  console.log('\n🌟 Featured Images (800×500):');
  await processDir(FEAT_IN, FEAT_OUT, SIZES.featured);

  console.log('\n✅ Image optimisation complete.\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
