import { type Page } from 'playwright';
import { between, chance, jitter, pause, rand, sleep } from './human';

export { sleep };

let globalCursorX = 960;
let globalCursorY = 540;

export function getGlobalCursorPos(): { x: number; y: number } {
  return { x: globalCursorX, y: globalCursorY };
}

export function setGlobalCursorPos(x: number, y: number): void {
  globalCursorX = x;
  globalCursorY = y;
}

/**
 * Where the cursor is when a take opens.
 *
 * Every clip used to start with it at the exact centre of the screen, which
 * is where no one's mouse ever is. Somewhere in the middle third, different
 * per take.
 */
export function restCursorSomewhere(): void {
  setGlobalCursorPos(Math.round(between(640, 1280)), Math.round(between(360, 720)));
}

async function paintCursor(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(`
    (function() {
      var c = document.getElementById('playwright-virtual-mouse');
      if (c) {
        c.style.left = "${x.toFixed(1)}px";
        c.style.top = "${y.toFixed(1)}px";
      }
    })()
  `);
  await page.mouse.move(x, y);
}

/** One Bézier arc from the current position to (targetX, targetY). */
async function arc(
  page: Page,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  steps: number,
  curveScale = 1,
): Promise<void> {
  const distance = Math.hypot(targetX - startX, targetY - startY);
  const midX = (startX + targetX) / 2;
  const midY = (startY + targetY) / 2;
  const normalX = -(targetY - startY) / (distance || 1);
  const normalY = (targetX - startX) / (distance || 1);

  // Subtle natural arc (5% to 15% curvature perpendicular to motion vector)
  const maxCurvature = Math.min(30, distance * 0.12);
  const arcDirection = chance(0.5) ? 1 : -1;
  const curvature = arcDirection * (8 + rand() * maxCurvature) * curveScale;

  const cp1X = startX + (midX - startX) * 0.45 + normalX * curvature;
  const cp1Y = startY + (midY - startY) * 0.45 + normalY * curvature;
  const cp2X = midX + (targetX - midX) * 0.55 + normalX * (curvature * 0.6);
  const cp2Y = midY + (targetY - midY) * 0.55 + normalY * (curvature * 0.6);

  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    // Smooth ease-out (fast start, natural deceleration at target)
    const t = 1 - Math.pow(1 - rawT, 2.5);
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    let cx = uuu * startX + 3 * uu * t * cp1X + 3 * u * tt * cp2X + ttt * targetX;
    let cy = uuu * startY + 3 * uu * t * cp1Y + 3 * u * tt * cp2Y + ttt * targetY;

    // Subtle microscopic hand tremor (±0.25px)
    if (i > 1 && i < steps) {
      cx += (rand() - 0.5) * 0.35;
      cy += (rand() - 0.5) * 0.35;
    }

    await paintCursor(page, cx, cy);
    // High refresh rate: 10ms - 14ms per frame (approx 60fps)
    await sleep(10 + Math.floor(rand() * 4));
  }
}

/**
 * Practiced human mouse glide:
 * - Natural cubic Bézier curves (smooth organic arcs, never robotic straight lines).
 * - Variable dynamic velocity (fast acceleration, smooth momentum, subtle target ease).
 * - High event density (dense 60fps stream of mousemove events for fluid video playback).
 * - Continuous unbroken trajectory across page navigations (zero teleportation).
 * - On a long travel, a slight overshoot past the target and a short settle
 *   back onto it. A hand aiming at a button from across the screen lands a
 *   few pixels long and corrects; a glide that stops dead on target every
 *   time reads as a machine.
 */
export async function humanGlide(
  page: Page,
  targetX: number,
  targetY: number,
  customSteps?: number,
): Promise<void> {
  const currentPos = (await page.evaluate(`
    (function() {
      var c = document.getElementById('playwright-virtual-mouse');
      if (c && c.style.left && c.style.top) {
        return { x: parseFloat(c.style.left) || ${globalCursorX}, y: parseFloat(c.style.top) || ${globalCursorY} };
      }
      return { x: ${globalCursorX}, y: ${globalCursorY} };
    })()
  `)) as { x: number; y: number };

  const startX = currentPos.x;
  const startY = currentPos.y;
  const distance = Math.hypot(targetX - startX, targetY - startY);

  if (distance < 2) {
    setGlobalCursorPos(targetX, targetY);
    return;
  }

  // Step count proportional to distance, tuned for 200ms - 350ms practiced speed
  const steps = customSteps ?? Math.min(26, Math.max(12, Math.floor(distance / 28)));

  const overshoots = distance > 260 && chance(0.55);
  if (overshoots) {
    // Past the target along the line of travel by 2-6% of the distance, then
    // a short, straighter settle back.
    const over = between(0.02, 0.06) * distance;
    const ux = (targetX - startX) / distance;
    const uy = (targetY - startY) / distance;
    const ox = targetX + ux * over + (rand() - 0.5) * 4;
    const oy = targetY + uy * over + (rand() - 0.5) * 4;
    await arc(page, startX, startY, ox, oy, steps);
    await sleep(between(30, 80));
    await arc(page, ox, oy, targetX, targetY, Math.max(4, Math.round(steps / 4)), 0.3);
  } else {
    await arc(page, startX, startY, targetX, targetY, steps);
  }

  // Exact target anchor
  await paintCursor(page, targetX, targetY);
  setGlobalCursorPos(targetX, targetY);
  await sleep(40);
}

/**
 * Practiced human click with crisp, snappy press & release.
 *
 * The beat before the press varies: a hand hovers for a moment before it
 * commits, and not for the same moment every time.
 */
export async function humanClick(page: Page): Promise<void> {
  await sleep(between(40, 160));

  await page.evaluate(`
    (function() {
      var c = document.getElementById('playwright-virtual-mouse');
      if (c) c.style.transform = 'translate(-4px, -2px) scale(0.9)';
    })()
  `);
  await page.mouse.down();
  await sleep(between(45, 90));

  await page.evaluate(`
    (function() {
      var c = document.getElementById('playwright-virtual-mouse');
      if (c) c.style.transform = 'translate(-4px, -2px) scale(1)';
    })()
  `);
  await page.mouse.up();
  await sleep(40);
}

/**
 * A small, unhurried movement while nothing else is happening.
 *
 * Called from long waits — a reply streaming for twenty seconds — during
 * which the cursor used to sit frozen on one pixel. A person reading drifts:
 * a few pixels, a pause, a few more. `driftY` biases the drift downward, for
 * following text as it arrives.
 */
export async function idleNudge(page: Page, driftY = 0): Promise<void> {
  const { x, y } = getGlobalCursorPos();
  const nx = Math.min(1900, Math.max(20, x + between(-14, 14)));
  const ny = Math.min(1020, Math.max(20, y + between(-8, 8) + driftY));
  await humanGlide(page, nx, ny, 6);
}

/**
 * Smooth, natural human scroll down the documentation page.
 *
 * In bursts, not one glide. A reader turns the wheel a few notches, stops to
 * read, turns it again — and sometimes goes back a little to re-read. One
 * continuous 3-second ease from top to target is the other thing, after
 * metronomic typing, that gives a recording away.
 *
 * Drives exactly ONE scroller per tick. Sending a wheel event *and* nudging
 * `scrollTop` (as this used to) makes the page travel roughly twice the
 * requested distance. Travel is clamped to 75% of the page so the glide never
 * bottoms out into the footer or an overscroll bounce.
 */
export async function humanScrollDown(
  page: Page,
  totalPixels: number = 1600,
  durationMs: number = 3200,
): Promise<void> {
  // Resolve the scroller once and stash it, so every tick moves the same element.
  const actualTarget = (await page
    .evaluate((requestedPixels) => {
      const candidates = [
        document.getElementById('nd-docs-layout'),
        document.querySelector('main'),
        document.querySelector('article'),
      ];
      const nested = candidates.find(
        (el) => el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 40,
      ) as HTMLElement | undefined;

      (window as any).__autorecordScroller = nested ?? null;

      const maxScroll = nested
        ? nested.scrollHeight - nested.clientHeight
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

      return Math.min(requestedPixels, Math.max(300, Math.floor(maxScroll * 0.75)));
    }, totalPixels)
    .catch(() => totalPixels)) as number;

  const readPos = (): Promise<number> =>
    page
      .evaluate(() => {
        const el = (window as any).__autorecordScroller as HTMLElement | null;
        return el ? el.scrollTop : window.scrollY;
      })
      .catch(() => 0);

  // Native wheel keeps the compositor's own smoothing, so it is preferred.
  // Some doc layouts swallow it; the first tick proves which applies.
  let useWheel = true;
  let wheelProven = false;

  const tick = async (deltaY: number): Promise<void> => {
    if (useWheel) {
      const before = wheelProven ? 0 : await readPos();
      await page.mouse.wheel(0, deltaY);
      if (!wheelProven) {
        const after = await readPos();
        wheelProven = true;
        if ((deltaY > 0 && after <= before) || (deltaY < 0 && after >= before)) {
          useWheel = false;
        }
      }
    }
    if (!useWheel) {
      await page
        .evaluate((dy) => {
          const el = (window as any).__autorecordScroller as HTMLElement | null;
          if (el) el.scrollTop += dy;
          else window.scrollBy(0, dy);
        }, deltaY)
        .catch(() => {});
    }
  };

  // 3-5 bursts, each a handful of wheel notches, with a reading pause between.
  const bursts = Math.max(3, Math.min(5, Math.round(actualTarget / 420)));
  const readPauseMs = Math.max(250, (durationMs - bursts * 380) / bursts);
  let travelled = 0;

  for (let b = 0; b < bursts; b++) {
    const remaining = actualTarget - travelled;
    const share = b === bursts - 1 ? remaining : Math.round((remaining / (bursts - b)) * between(0.75, 1.25));
    const notches = Math.max(2, Math.round(share / between(90, 130)));
    const perNotch = Math.round(share / notches);
    for (let n = 0; n < notches && perNotch > 0; n++) {
      await tick(perNotch);
      travelled += perNotch;
      await sleep(between(28, 70));
    }
    await pause(readPauseMs, 0.4);

    // Occasionally lose the line and go back for it.
    if (b > 0 && b < bursts - 1 && chance(0.25)) {
      const back = Math.round(between(60, 140));
      await tick(-back);
      travelled -= back;
      await pause(500, 0.4);
    }
  }

  await sleep(jitter(300));
}
