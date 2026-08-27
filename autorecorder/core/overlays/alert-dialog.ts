import { type Page } from 'playwright';
import { humanClick, humanGlide, sleep } from './cursor';

/**
 * Native `window.alert` dialogs are browser chrome, not page content, so they
 * are invisible to Playwright's video capture -- and Playwright dismisses them
 * automatically anyway. A page whose whole point is "the handler ran in *this*
 * browser tab" therefore records as if nothing happened.
 *
 * This replaces `window.alert` with a DOM replica of Chrome's dialog, drawn
 * inside the page so the recorder can see it. Opt-in per action: nothing calls
 * this unless a page's action script does.
 */
export async function installAlertOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __autorecordAlertPatched?: boolean };
    if (w.__autorecordAlertPatched) return;
    w.__autorecordAlertPatched = true;

    window.alert = (message?: unknown) => {
      document.getElementById('__autorecord_alert')?.remove();

      // Measurements taken from Chrome 120+ on Windows 11: the sheet is
      // anchored under the toolbar, square on top, rounded at the bottom, and
      // its buttons are pills in Google Blue.
      const shell = document.createElement('div');
      shell.id = '__autorecord_alert';
      shell.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        'z-index:2147483646',
        'display:flex',
        'justify-content:center',
        'pointer-events:none',
        'font-family:"Segoe UI",system-ui,sans-serif',
        '-webkit-font-smoothing:antialiased',
      ].join(';');

      const box = document.createElement('div');
      box.style.cssText = [
        'box-sizing:border-box',
        'width:min(504px,52vw)',
        'background:#ffffff',
        'color:#1f1f1f',
        'border-radius:0 0 12px 12px',
        'box-shadow:0 6px 20px rgba(0,0,0,.20),0 1px 3px rgba(0,0,0,.14)',
        'padding:20px 24px 16px',
        'animation:__autorecordAlertIn .2s cubic-bezier(.2,0,0,1)',
      ].join(';');

      const title = document.createElement('div');
      title.textContent = `${location.host} says`;
      title.style.cssText =
        'font-size:13px;line-height:20px;font-weight:400;color:#1f1f1f;';

      const body = document.createElement('div');
      body.textContent = String(message ?? '');
      body.style.cssText = [
        'font-size:13px',
        'line-height:20px',
        'color:#1f1f1f',
        'margin-top:8px',
        'max-height:220px',
        'overflow:hidden',
        'white-space:pre-wrap',
        'word-break:break-word',
      ].join(';');

      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;justify-content:flex-end;gap:8px;margin-top:24px;';

      const ok = document.createElement('button');
      ok.id = '__autorecord_alert_ok';
      ok.textContent = 'OK';
      ok.style.cssText = [
        'font-family:inherit',
        'background:#0b57d0',
        'color:#ffffff',
        'border:0',
        'border-radius:100px',
        'min-width:72px',
        'height:32px',
        'padding:0 20px',
        'font-size:13px',
        'font-weight:500',
        'line-height:32px',
        'cursor:default',
        'outline:0',
      ].join(';');

      const style = document.createElement('style');
      style.textContent =
        '@keyframes __autorecordAlertIn{from{transform:translateY(-100%);opacity:.4}to{transform:none;opacity:1}}';

      row.appendChild(ok);
      box.append(title, body, row);
      shell.append(style, box);
      document.documentElement.appendChild(shell);
    };
  });
}

/**
 * Waits for the replica dialog, lets it sit long enough to read, then walks the
 * virtual cursor to OK and dismisses it. No-op if no dialog appeared.
 */
export async function dismissAlertOverlay(
  page: Page,
  { waitForMs = 15000, dwellMs = 2200 } = {},
): Promise<boolean> {
  const ok = page.locator('#__autorecord_alert_ok');
  try {
    await ok.waitFor({ state: 'visible', timeout: waitForMs });
  } catch {
    return false;
  }

  await sleep(dwellMs);

  const box = await ok.boundingBox();
  if (box) {
    await humanGlide(page, box.x + box.width / 2, box.y + box.height / 2);
    await humanClick(page);
  }
  await page.evaluate(() =>
    document.getElementById('__autorecord_alert')?.remove(),
  );
  await sleep(400);
  return true;
}
