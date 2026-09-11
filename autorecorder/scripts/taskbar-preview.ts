/**
 * Paints the simulated Windows 11 taskbar over a blank page and screenshots
 * it, so an icon change can be checked without recording a take.
 *
 *   npx tsx scripts/taskbar-preview.ts [out.png] [chrome|vscode|terminal]
 */
import { chromium } from 'playwright';
import { ensureOverlays } from '../core/overlays/taskbar';

type TaskbarApp = Parameters<typeof ensureOverlays>[1];

const [out = 'taskbar-preview.png', app = 'vscode'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent('<html><body style="background:#1e1e1e;margin:0"></body></html>');
await ensureOverlays(page, app as TaskbarApp);
await page.waitForTimeout(300);
await page.screenshot({ path: out, clip: { x: 0, y: 1080 - 48, width: 1920, height: 48 } });
await browser.close();
console.log(`wrote ${out}`);
