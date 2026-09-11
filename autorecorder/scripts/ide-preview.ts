/**
 * Renders the simulated IDE for one file and screenshots it, so a styling
 * change can be checked without recording a take.
 *
 *   npx tsx scripts/ide-preview.ts <file> <startLine> <endLine> [out.png] [extraFile]
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
// Run from autorecorder/: the repo root is one level up.
import { generateIdeHtml } from '../core/ide/generator';

const [file, start, end, out = 'ide-preview.png', extra] = process.argv.slice(2);
if (!file) {
  console.error('usage: tsx scripts/ide-preview.ts <file> <startLine> <endLine> [out.png] [extraFile]');
  process.exit(1);
}
const root = resolve(process.cwd(), '..');
const html = await generateIdeHtml(
  root,
  file,
  Number(start || 1),
  Number(end || 20),
  extra ? [{ filePath: extra, startLine: 1, endLine: 10 }] : [],
  0,
);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(html, { waitUntil: 'domcontentloaded' });
await page.evaluate(`window.selectIdeLines && window.selectIdeLines(0, ${Number(start || 1)}, ${Number(end || 20)})`);
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
