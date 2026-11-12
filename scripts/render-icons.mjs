#!/usr/bin/env node
/**
 * Renders the DashyHQ icon from its master SVG (native/ios/App/Icon/icon.svg) with the
 * pre-installed Chromium (Playwright):
 *   - native/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png        (1024², opaque)
 *   - native/ios/App/Assets.xcassets/AppIcon-Test.appiconset/AppIcon-Test-1024.png (+ yellow TEST band)
 *   - platform/web/public/favicon.svg and apple-touch-icon.png (180²)
 *
 *   node scripts/render-icons.mjs [--preview <dir>]   (--preview also writes 29/58/180 px samples there)
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const master = join(root, 'native/ios/App/Icon/icon.svg');
const svg = readFileSync(master, 'utf8');

/** The staging app's band: the same treatment as before (yellow, dark rule, bold TEST). */
const TEST_BAND = `
  <rect x="0" y="758" width="1024" height="266" fill="#ffc400"/>
  <rect x="0" y="758" width="1024" height="10" fill="#1a1735"/>
  <text x="512" y="950" text-anchor="middle" font-family="Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif" font-weight="800" font-size="190" fill="#1d1a48">TEST</text>`;
export const withTestBand = (source) => source.replace(/<\/svg>\s*$/, `${TEST_BAND}\n</svg>\n`);

async function render(page, source, size, file) {
  await page.setViewportSize({ width: size, height: size });
  const inline = source.replace(/<svg /, `<svg style="display:block;width:${size}px;height:${size}px" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${inline}</body></html>`);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`wrote ${file.replace(`${root}/`, '')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const assets = join(root, 'native/ios/App/Assets.xcassets');
  await render(page, svg, 1024, join(assets, 'AppIcon.appiconset/AppIcon-1024.png'));
  await render(page, withTestBand(svg), 1024, join(assets, 'AppIcon-Test.appiconset/AppIcon-Test-1024.png'));
  const web = join(root, 'platform/web/public');
  mkdirSync(web, { recursive: true });
  copyFileSync(master, join(web, 'favicon.svg'));
  console.log('wrote platform/web/public/favicon.svg');
  await render(page, svg, 180, join(web, 'apple-touch-icon.png'));
  const preview = process.argv.indexOf('--preview');
  if (preview > 0) {
    const dir = process.argv[preview + 1];
    for (const size of [29, 58, 180]) {
      await render(page, svg, size, join(dir, `icon-${size}.png`));
      await render(page, withTestBand(svg), size, join(dir, `icon-test-${size}.png`));
    }
  }
  await browser.close();
}
