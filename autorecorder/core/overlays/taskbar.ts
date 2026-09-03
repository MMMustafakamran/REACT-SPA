import { type Locator, type Page } from 'playwright';
import { getGlobalCursorPos, humanClick, humanGlide, sleep } from './cursor';

/**
 * Height of the simulated Windows 11 taskbar, in CSS pixels.
 *
 * The overlay is `position:fixed; bottom:0`, so in a 1080-tall viewport it owns
 * y >= 1032 and swallows pointer events there. Anything the recorder needs to
 * click must sit above that line -- see `ensureClearOfTaskbar`.
 */
export const TASKBAR_HEIGHT = 48;

/**
 * Scroll a control clear of the taskbar overlay before clicking it.
 *
 * A page whose input row sits at the bottom of the viewport ends up underneath
 * the taskbar, and the click lands on the overlay instead of the control. That
 * is a defect of the recorder's own furniture, not of the page being recorded,
 * so it is corrected here rather than by moving the element in the app.
 *
 * Two steps, because the first is not always enough:
 *  1. scroll the element up by however much of it is covered
 *  2. if the document cannot scroll any further, add matching bottom padding so
 *     that it can, then scroll again
 *
 * Padding is applied to `document.body` and left in place for the rest of the
 * take -- it keeps the page clear of the taskbar rather than shifting mid-shot.
 *
 * @param margin extra clearance above the taskbar, in pixels
 * @returns true if the element ended up fully clear
 */
export async function ensureClearOfTaskbar(
  page: Page,
  locator: Locator,
  margin = 16,
): Promise<boolean> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  const overlapOf = async (): Promise<number> => {
    const box = await locator.boundingBox();
    if (!box) return 0;
    const viewportHeight = page.viewportSize()?.height ?? 1080;
    const safeBottom = viewportHeight - TASKBAR_HEIGHT - margin;
    return Math.max(0, box.y + box.height - safeBottom);
  };

  let overlap = await overlapOf();
  if (overlap <= 0) return true;

  // 1. Try scrolling the page itself.
  await page.evaluate((delta) => window.scrollBy(0, delta), overlap);
  await sleep(250);

  overlap = await overlapOf();
  if (overlap <= 0) return true;

  // 2. Already at the bottom -- make room, then take up the slack.
  await page.evaluate(
    ({ pad }) => {
      const body = document.body;
      const current = parseFloat(body.style.paddingBottom || '0') || 0;
      body.style.paddingBottom = `${current + pad}px`;
    },
    { pad: overlap + margin },
  );
  await sleep(200);
  await page.evaluate((delta) => window.scrollBy(0, delta), overlap + margin);
  await sleep(250);

  return (await overlapOf()) <= 0;
}

/**
 * Waits until the page's framework has finished hydrating.
 *
 * Next.js App Router renders `<html>` itself, so React owns
 * `document.documentElement`. Anything appended to `<html>` before hydration
 * completes is an unexpected child, and React deletes it when it reconciles --
 * which is what silently removed the taskbar and the cursor partway through the
 * doc page, and reset the page's scroll back to the top along with them.
 *
 * Detected directly rather than guessed at: drop a sentinel into `<html>` and
 * wait for React to delete it. Measured at ~4.5s after DOMContentLoaded on
 * docs.copilotkit.ai, which is precisely when the overlays used to vanish.
 *
 * @returns true if hydration was observed, false on timeout (a page that never
 *   hydrates -- e.g. the static IDE view -- would always time out, so do not
 *   call this for one).
 */
export async function waitForHydration(
  page: Page,
  timeoutMs = 8000,
): Promise<boolean> {
  return page
    .evaluate(async (timeout) => {
      const probe = document.createElement('div');
      probe.id = '__autorecord_hydration_probe';
      probe.style.cssText =
        'position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;';
      document.documentElement.appendChild(probe);

      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (!probe.isConnected) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      probe.remove();
      return false;
    }, timeoutMs)
    .catch(() => false);
}

/** Injects or re-attaches the Windows 11 Taskbar & Virtual Mouse overlay onto the current page */
export async function ensureOverlays(
  page: Page,
  activeApp: 'chrome' | 'vscode' = 'chrome',
): Promise<void> {
  const chromeInd = activeApp === 'chrome' ? '#60a5fa' : 'transparent';
  const vscodeInd = activeApp === 'vscode' ? '#60a5fa' : 'transparent';
  const { x: curX, y: curY } = getGlobalCursorPos();

  const code = `
    (function() {
      // 0. Ensure Next.js dev indicator sits cleanly above the 48px Windows 11 taskbar
      var elevateBadges = function() {
        var portals = document.querySelectorAll('nextjs-portal');
        for (var i = 0; i < portals.length; i++) {
          var p = portals[i];
          if (p.shadowRoot) {
            var ind = p.shadowRoot.querySelector('#devtools-indicator, [data-nextjs-toast]');
            if (ind) ind.style.bottom = '56px';
          }
        }
      };
      elevateBadges();
      setTimeout(elevateBadges, 500);
      setTimeout(elevateBadges, 1500);

      // 1. Hyper-Realistic Windows 11 Fluent Taskbar
      var bar = document.getElementById('win11-taskbar-overlay');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'win11-taskbar-overlay';
        bar.style.cssText = 'position:fixed!important;bottom:0!important;left:0!important;width:100vw!important;height:48px!important;background:rgba(28,28,32,0.85)!important;backdrop-filter:blur(36px) saturate(180%)!important;-webkit-backdrop-filter:blur(36px) saturate(180%)!important;border-top:1px solid rgba(255,255,255,0.08)!important;box-shadow:0 -1px 8px rgba(0,0,0,0.35)!important;z-index:2147483645!important;display:flex!important;align-items:center!important;justify-content:space-between!important;padding:0 8px 0 12px!important;box-sizing:border-box!important;font-family:"Segoe UI Variable Small","Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,sans-serif!important;user-select:none!important;pointer-events:auto!important;';

        var swallow = function(e) {
          if (e.stopPropagation) e.stopPropagation();
          if (e.preventDefault) e.preventDefault();
        };
        bar.addEventListener('mousedown', swallow, true);
        bar.addEventListener('mouseup', swallow, true);
        bar.addEventListener('click', swallow, true);

        bar.innerHTML = [
          // Left: Windows 11 Weather / Widgets Pill
          '<div style="display:flex;align-items:center;gap:8px;padding:3px 8px;border-radius:4px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.04);cursor:default;">',
          '  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">',
          '    <circle cx="12" cy="12" r="4.5" fill="#f59e0b"/>',
          '    <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round"/>',
          '  </svg>',
          '  <div style="display:flex;flex-direction:column;line-height:1.1;">',
          '    <span style="font-size:11.5px;font-weight:600;color:#f3f4f6;letter-spacing:0.2px;">76°F</span>',
          '    <span style="font-size:10px;color:#9ca3af;">Mostly Sunny</span>',
          '  </div>',
          '</div>',

          // Center: Windows 11 Centered App Icons
          '<div id="win11-taskbar-center-icons" style="display:flex;align-items:center;gap:3px;position:absolute;left:50%;transform:translateX(-50%);">',
          
          // Start Button (Fluent 4-Square)
          '  <div id="win11-taskbar-start" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:5px;transition:background 0.15s ease;">',
          '    <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#0078d4" d="M3 3.5A.5.5 0 0 1 3.5 3h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7zm10 0a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7zM3 13.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7zm10 0a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7z"/></svg>',
          '  </div>',

          // Search Button
          '  <div id="win11-taskbar-search" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:5px;transition:background 0.15s ease;">',
          '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
          '  </div>',

          // Task View (Virtual Desktops)
          '  <div id="win11-taskbar-taskview" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:5px;transition:background 0.15s ease;">',
          '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="10" height="12" rx="1.5" stroke="#e5e7eb" stroke-width="1.8"/><rect x="11" y="8" width="10" height="12" rx="1.5" fill="#ffffff" fill-opacity="0.2" stroke="#e5e7eb" stroke-width="1.8"/></svg>',
          '  </div>',

          // File Explorer (Fluent Yellow/Blue)
          '  <div id="win11-taskbar-explorer" style="width:40px;height:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:5px;position:relative;transition:background 0.15s ease;">',
          '    <svg width="22" height="22" viewBox="0 0 24 24"><path fill="#0284c7" d="M4 4h6l2 2h8a2 2 0 0 1 2 2v2H2V6a2 2 0 0 1 2-2z"/><path fill="#facc15" d="M2 9h20v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9z"/><path fill="#fde047" d="M2 11h20v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8z"/></svg>',
          '    <div style="position:absolute;bottom:2px;width:6px;height:3px;background:rgba(255,255,255,0.4);border-radius:2px;"></div>',
          '  </div>',

          // Google Chrome
          '  <div id="win11-taskbar-chrome" style="width:40px;height:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;border-radius:5px;transition:background 0.15s ease;${activeApp === 'chrome' ? 'background:rgba(255,255,255,0.08);' : ''}">',
          '    <svg width="23" height="23" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#ffffff"/><path fill="#ea4335" d="M12 2C6.48 2 2 6.48 2 12c0 .35.02.7.06 1.04l5.37-9.3C8.83 2.64 10.36 2 12 2z"/><path fill="#fbbc05" d="M22 12c0 5.52-4.48 10-10 10-1.64 0-3.17-.64-4.57-1.74l5.37-9.3c.34.04.69.06 1.04.06 4.5 0 8.16-3.66 8.16-8.16 0-.35-.02-.7-.06-1.04C21.98 11.3 22 11.65 22 12z"/><path fill="#34a853" d="M12 22C6.48 22 2 17.52 2 12c0-1.64.64-3.17 1.74-4.57l5.37 9.3c-.34-.04-.69-.06-1.04-.06 2.25 0 4.29.91 5.77 2.39L12 22z"/><circle cx="12" cy="12" r="4.3" fill="#ffffff"/><circle cx="12" cy="12" r="3.2" fill="#1a73e8"/></svg>',
          '    <div id="win11-chrome-indicator" style="position:absolute;bottom:2px;width:${activeApp === 'chrome' ? '16px' : '6px'};height:3px;background:${chromeInd || 'rgba(255,255,255,0.4)'};border-radius:2px;transition:all 0.2s ease;"></div>',
          '  </div>',

          // Visual Studio Code (Fluent Ribbon)
          '  <div id="win11-taskbar-vscode" style="width:40px;height:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;border-radius:5px;transition:background 0.15s ease;${activeApp === 'vscode' ? 'background:rgba(255,255,255,0.08);' : ''}">',
          '    <svg width="23" height="23" viewBox="0 0 24 24"><path fill="#0065a9" d="M18.7 2.3 12.3 8.2 7.2 4.3 3.6 5.8v12.4l3.6 1.5 5.1-3.9 6.4 5.9 3.7-1.8V4.1l-3.7-1.8z"/><path fill="#007acc" d="m18.7 2.3-6.4 5.9 3.6 3.8 4.8-3.7 1.7.9V4.1l-3.7-1.8z"/><path fill="#1f9cf0" d="M18.7 21.7 12.3 15.8l3.6-3.8 4.8 3.7 1.7-.9v6.1l-3.7 1.8z"/><path fill="#0065a9" d="M7.2 4.3 3.6 5.8v12.4l3.6 1.5 8.7-7.7L7.2 4.3z"/><path fill="#ffffff" fill-opacity="0.18" d="m15.9 12-8.7-7.7v15.4L15.9 12z"/></svg>',
          '    <div id="win11-vscode-indicator" style="position:absolute;bottom:2px;width:${activeApp === 'vscode' ? '16px' : '6px'};height:3px;background:${vscodeInd || 'rgba(255,255,255,0.4)'};border-radius:2px;transition:all 0.2s ease;"></div>',
          '  </div>',

          // Notepad
          '  <div id="win11-taskbar-notepad" style="width:40px;height:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;border-radius:5px;transition:background 0.15s ease;">',
          '    <svg width="22" height="22" viewBox="0 0 24 24"><rect width="20" height="20" x="2" y="2" rx="3" fill="#0284c7"/><path fill="#ffffff" d="M6 7h12v1.5H6V7zm0 4h12v1.5H6V11zm0 4h8v1.5H6V15z"/></svg>',
          '    <div id="win11-notepad-indicator" style="position:absolute;bottom:2px;width:6px;height:3px;background:transparent;border-radius:2px;"></div>',
          '  </div>',

          // Windows Terminal
          '  <div id="win11-taskbar-terminal" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:5px;transition:background 0.15s ease;">',
          '    <svg width="22" height="22" viewBox="0 0 24 24"><rect width="22" height="22" x="1" y="1" rx="4" fill="#18181b" stroke="rgba(255,255,255,0.1)" stroke-width="1"/><path d="m6 8 4 4-4 4" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="12" y1="16" x2="17" y2="16" stroke="#9ca3af" stroke-width="2" stroke-linecap="round"/></svg>',
          '  </div>',

          // Microsoft Copilot (Fluent Butterfly)
          '  <div id="win11-taskbar-copilot" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:5px;transition:background 0.15s ease;">',
          '    <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#0ea5e9" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
          '  </div>',
          '</div>',

          // Right: Windows 11 Action Center & System Tray
          '<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#f3f4f6;">',
          // Hidden icons chevron
          '  <div style="width:26px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:4px;cursor:default;">',
          '    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="2.2" stroke-linecap="round"><path d="m18 15-6-6-6 6"/></svg>',
          '  </div>',
          // Language selector
          '  <div style="padding:4px 6px;border-radius:4px;font-size:11px;font-weight:600;color:#e5e7eb;letter-spacing:0.3px;">ENG</div>',
          // System Status Pill (WiFi, Volume, Battery)
          '  <div style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.04);cursor:default;">',
          '    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg>',
          '    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
          '    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#e5e7eb" stroke-width="1.8"><rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2" stroke-linecap="round"/><rect x="4" y="9" width="13" height="6" fill="#10b981" stroke="none" rx="1"/></svg>',
          '  </div>',
          // Clock Pill (Time & Date)
          '  <div style="display:flex;flex-direction:column;align-items:flex-end;line-height:1.15;padding:3px 6px;border-radius:4px;cursor:default;">',
          '    <span id="win11-time" style="font-size:11.5px;font-weight:600;color:#f3f4f6;letter-spacing:0.2px;"></span>',
          '    <span id="win11-date" style="font-size:10px;color:#9ca3af;"></span>',
          '  </div>',
          // Notification Bell
          '  <div style="width:28px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:4px;cursor:default;">',
          '    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
          '  </div>',
          // Show Desktop Slivers
          '  <div style="width:3px;height:24px;border-left:1px solid rgba(255,255,255,0.15);margin-left:2px;"></div>',
          '</div>'
        ].join('');

        document.documentElement.appendChild(bar);

        var tick = function() {
          var now = new Date();
          var timeEl = document.getElementById('win11-time');
          var dateEl = document.getElementById('win11-date');
          if (timeEl) timeEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
          if (dateEl) dateEl.textContent = now.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' });
        };
        tick();
        setInterval(tick, 1000);
      } else {
        // Update indicators and tile backgrounds if already present
        var cTile = document.getElementById('win11-taskbar-chrome');
        var vTile = document.getElementById('win11-taskbar-vscode');
        var cInd = document.getElementById('win11-chrome-indicator');
        var vInd = document.getElementById('win11-vscode-indicator');
        if (cTile) cTile.style.backgroundColor = '${activeApp === 'chrome' ? 'rgba(255,255,255,0.08)' : 'transparent'}';
        if (vTile) vTile.style.backgroundColor = '${activeApp === 'vscode' ? 'rgba(255,255,255,0.08)' : 'transparent'}';
        if (cInd) {
          cInd.style.background = '${chromeInd || 'rgba(255,255,255,0.4)'}';
          cInd.style.width = '${activeApp === 'chrome' ? '16px' : '6px'}';
        }
        if (vInd) {
          vInd.style.background = '${vscodeInd || 'rgba(255,255,255,0.4)'}';
          vInd.style.width = '${activeApp === 'vscode' ? '16px' : '6px'}';
        }
      }

      // 1b. Keep both overlays attached across framework re-renders.
      //
      // React owns document.documentElement on any App Router page, so a render
      // pass will happily delete children it did not create. waitForHydration()
      // avoids the initial mount; this catches anything later, and costs nothing
      // when nothing removes them.
      if (!window.__autorecordOverlayGuard) {
        window.__autorecordOverlayGuard = new MutationObserver(function () {
          var b = document.getElementById('win11-taskbar-overlay') || window.__autorecordBar;
          var c = document.getElementById('playwright-virtual-mouse') || window.__autorecordCursor;
          if (b && !b.isConnected) document.documentElement.appendChild(b);
          if (c && !c.isConnected) document.documentElement.appendChild(c);
        });
        window.__autorecordOverlayGuard.observe(document.documentElement, {
          childList: true,
        });
      }
      window.__autorecordBar = bar;

      // 2. Virtual Mouse Cursor
      var cursor = document.getElementById('playwright-virtual-mouse');
      if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'playwright-virtual-mouse';
        cursor.style.cssText = 'position:fixed!important;top:${curY.toFixed(1)}px!important;left:${curX.toFixed(1)}px!important;width:24px!important;height:24px!important;z-index:2147483647!important;pointer-events:none!important;transform:translate(-4px,-2px)!important;transform-origin:4px 2px!important;transition:transform 0.04s ease-out!important;';
        cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,0.28));"><path d="M4 2 L4 19.1 L8.4 15.1 L11.2 21.2 L14 19.9 L11.3 14.1 L17.2 14.1 Z" fill="#ffffff" stroke="#2b2b2b" stroke-width="1" stroke-linejoin="round"/></svg>';
        document.documentElement.appendChild(cursor);
      }
      window.__autorecordCursor = cursor;
    })();
  `;

  await page.evaluate(code);
}

/** Glides virtual mouse down to Taskbar icon, clicks it, and illuminates active glow indicator */
export async function clickTaskbarApp(
  page: Page,
  targetApp: 'vscode' | 'chrome',
): Promise<void> {
  const targetId =
    targetApp === 'vscode' ? 'win11-taskbar-vscode' : 'win11-taskbar-chrome';

  // Get taskbar icon coordinates
  const coords = (await page.evaluate(`
    (function() {
      var el = document.getElementById('${targetId}');
      if (el) {
        var rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return {
        x: window.innerWidth / 2 + (${targetApp === 'vscode' ? 69 : 23}),
        y: window.innerHeight - 24,
      };
    })()
  `)) as { x: number; y: number };

  // Glide cursor down to taskbar icon
  await humanGlide(page, coords.x, coords.y, 22);

  // Hover visual effect
  await page.evaluate(`
    (function() {
      var el = document.getElementById('${targetId}');
      if (el) el.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
    })()
  `);
  await sleep(150);

  // Click taskbar icon
  await humanClick(page);

  // Illuminate active indicator bar and update tile styles
  await page.evaluate(`
    (function() {
      var cTile = document.getElementById('win11-taskbar-chrome');
      var vTile = document.getElementById('win11-taskbar-vscode');
      var cInd = document.getElementById('win11-chrome-indicator');
      var vInd = document.getElementById('win11-vscode-indicator');
      if ('${targetApp}' === 'vscode') {
        if (vTile) vTile.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
        if (cTile) cTile.style.backgroundColor = 'transparent';
        if (vInd) {
          vInd.style.background = '#60a5fa';
          vInd.style.width = '16px';
        }
        if (cInd) {
          cInd.style.background = 'rgba(255, 255, 255, 0.4)';
          cInd.style.width = '6px';
        }
      } else {
        if (cTile) cTile.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
        if (vTile) vTile.style.backgroundColor = 'transparent';
        if (cInd) {
          cInd.style.background = '#60a5fa';
          cInd.style.width = '16px';
        }
        if (vInd) {
          vInd.style.background = 'rgba(255, 255, 255, 0.4)';
          vInd.style.width = '6px';
        }
      }
    })()
  `);

  await sleep(400);
}
