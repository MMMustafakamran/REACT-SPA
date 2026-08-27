import { type Page } from 'playwright';
import { humanClick, humanGlide, sleep } from './cursor';

/**
 * A Windows 11 Notepad window, drawn inside the page.
 *
 * Same trick as the taskbar: video capture only ever sees page content, so any
 * "other app" in a recording has to be DOM. Used by pages that report a defect
 * -- the tester opens Notepad from the taskbar and writes the issue down while
 * the bad response is still on screen behind it.
 */

const WINDOW_ID = '__autorecord_notepad';
const TEXT_ID = '__autorecord_notepad_text';
const CARET_ID = '__autorecord_notepad_caret';
const POS_ID = '__autorecord_notepad_pos';

/** Clicks Notepad on the simulated taskbar, then opens the window. */
export async function openNotepad(
  page: Page,
  fileName = 'Untitled',
): Promise<void> {
  const coords = await page.evaluate(() => {
    const el = document.getElementById('win11-taskbar-notepad');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (coords) {
    await humanGlide(page, coords.x, coords.y, 22);
    await sleep(180);
    await humanClick(page);
    await page.evaluate(() => {
      const tile = document.getElementById('win11-taskbar-notepad');
      const ind = document.getElementById('win11-notepad-indicator');
      if (tile) tile.style.backgroundColor = 'rgba(255,255,255,0.08)';
      if (ind) {
        ind.style.background = '#60a5fa';
        ind.style.width = '16px';
      }
    });
    await sleep(450);
  }

  await page.evaluate(
    (ids: { windowId: string; textId: string; posId: string; caretId: string; name: string }) => {
      document.getElementById(ids.windowId)?.remove();

      const win = document.createElement('div');
      win.id = ids.windowId;
      win.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:50%',
        'transform:translate(-50%,-50%) scale(.96)',
        'width:min(880px,62vw)',
        'height:min(540px,60vh)',
        'background:#ffffff',
        'border-radius:8px',
        'box-shadow:0 18px 60px rgba(0,0,0,.42),0 0 0 1px rgba(0,0,0,.16)',
        'z-index:2147483644',
        'display:flex',
        'flex-direction:column',
        'overflow:hidden',
        'font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif',
        'opacity:0',
        'transition:opacity .18s ease-out,transform .18s cubic-bezier(.2,0,0,1)',
        'pointer-events:none',
      ].join(';');

      const icon =
        '<svg width="15" height="15" viewBox="0 0 24 24"><rect width="20" height="20" x="2" y="2" rx="3" fill="#0284c7"/><path fill="#fff" d="M6 7h12v1.5H6V7zm0 4h12v1.5H6V11zm0 4h8v1.5H6V15z"/></svg>';

      win.innerHTML = [
        // Title bar with the Win11 tab strip
        '<div style="height:40px;background:#f3f3f3;display:flex;align-items:flex-end;border-bottom:1px solid #e5e5e5;">',
        '  <div style="display:flex;align-items:center;gap:8px;height:32px;margin-left:8px;padding:0 10px;background:#ffffff;border-radius:8px 8px 0 0;">',
        '    ' + icon,
        '    <span style="font-size:12.5px;color:#1a1a1a;">' + ids.name + '</span>',
        '    <span style="font-size:13px;color:#6b6b6b;margin-left:4px;">&#10005;</span>',
        '  </div>',
        '  <div style="font-size:16px;color:#6b6b6b;margin:0 0 6px 8px;">+</div>',
        '  <div style="margin-left:auto;display:flex;height:40px;">',
        '    <div style="width:46px;display:flex;align-items:center;justify-content:center;color:#1a1a1a;font-size:12px;">&#8212;</div>',
        '    <div style="width:46px;display:flex;align-items:center;justify-content:center;color:#1a1a1a;font-size:11px;">&#9633;</div>',
        '    <div style="width:46px;display:flex;align-items:center;justify-content:center;color:#1a1a1a;font-size:13px;">&#10005;</div>',
        '  </div>',
        '</div>',
        // Menu bar
        '<div style="height:34px;background:#ffffff;display:flex;align-items:center;gap:18px;padding:0 14px;font-size:12.5px;color:#1a1a1a;border-bottom:1px solid #ededed;">',
        '  <span>File</span><span>Edit</span><span>View</span>',
        '</div>',
        // Text area
        '<div id="' +
          ids.textId +
          '" style="flex:1;padding:14px 18px;font-family:Consolas,monospace;font-size:14.5px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;word-break:break-word;overflow:hidden;"></div>',
        // Status bar
        '<div style="height:26px;background:#f8f8f8;border-top:1px solid #ededed;display:flex;align-items:center;justify-content:flex-end;gap:18px;padding:0 14px;font-size:11.5px;color:#5f5f5f;">',
        '  <span id="' + ids.posId + '">Ln 1, Col 1</span><span>100%</span><span>Windows (CRLF)</span><span>UTF-8</span>',
        '</div>',
      ].join('');

      const caretStyle = document.createElement('style');
      caretStyle.textContent =
        '@keyframes __autorecordCaret{0%,49%{opacity:1}50%,100%{opacity:0}}' +
        '#' +
        ids.caretId +
        '{display:inline-block;width:1px;height:1.05em;background:#1a1a1a;vertical-align:text-bottom;animation:__autorecordCaret 1.06s step-end infinite;}';
      win.appendChild(caretStyle);

      document.documentElement.appendChild(win);
      requestAnimationFrame(() => {
        win.style.opacity = '1';
        win.style.transform = 'translate(-50%,-50%) scale(1)';
      });
    },
    { windowId: WINDOW_ID, textId: TEXT_ID, posId: POS_ID, caretId: CARET_ID, name: fileName },
  );

  await sleep(650);
}

export interface TypeOptions {
  /** Mean per-character delay. Ordinary typing sits around 60-90ms. */
  charDelayMs?: number;
  /** How far each keystroke strays from the mean, 0-1. */
  jitter?: number;
  /** Chance, per space, of pausing as if thinking. */
  thinkChance?: number;
}

/**
 * Types into the Notepad window one character at a time, with the uneven rhythm
 * a person has: jittered keystrokes, longer gaps after punctuation and line
 * breaks, and the occasional pause mid-sentence.
 */
export async function typeInNotepad(
  page: Page,
  text: string,
  opts: TypeOptions = {},
): Promise<void> {
  const { charDelayMs = 62, jitter = 0.55, thinkChance = 0.07 } = opts;

  await page.evaluate(
    (ids: { textId: string; caretId: string }) => {
      const el = document.getElementById(ids.textId);
      if (el) el.innerHTML = '<span id="' + ids.caretId + '"></span>';
    },
    { textId: TEXT_ID, caretId: CARET_ID },
  );

  let line = 1;
  let col = 1;

  for (const ch of text) {
    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }

    await page.evaluate(
      (a: { textId: string; caretId: string; posId: string; c: string; l: number; col: number }) => {
        const el = document.getElementById(a.textId);
        if (el) {
          const caret = document.getElementById(a.caretId);
          const node = document.createTextNode(a.c);
          if (caret) el.insertBefore(node, caret);
          else el.appendChild(node);
        }
        const pos = document.getElementById(a.posId);
        if (pos) pos.textContent = 'Ln ' + a.l + ', Col ' + a.col;
      },
      { textId: TEXT_ID, caretId: CARET_ID, posId: POS_ID, c: ch, l: line, col },
    );

    let delay = charDelayMs * (1 + (Math.random() * 2 - 1) * jitter);
    if (ch === ' ' && Math.random() < thinkChance) delay += 240 + Math.random() * 420;
    if ('.,:—-'.includes(ch)) delay += 120 + Math.random() * 170;
    if (ch === '\n') delay += 300 + Math.random() * 260;
    await sleep(Math.max(18, delay));
  }
}

/** Leaves the window up long enough to read, then closes it. */
export async function closeNotepad(page: Page, dwellMs = 2600): Promise<void> {
  await sleep(dwellMs);
  await page.evaluate(
    (ids: { windowId: string }) => {
      const win = document.getElementById(ids.windowId);
      if (!win) return;
      win.style.opacity = '0';
      win.style.transform = 'translate(-50%,-50%) scale(.97)';
      setTimeout(() => win.remove(), 220);
    },
    { windowId: WINDOW_ID },
  );
  await sleep(400);
}
