import { type Page } from 'playwright';

let globalCursorX = 960;
let globalCursorY = 540;

export function getGlobalCursorPos(): { x: number; y: number } {
  return { x: globalCursorX, y: globalCursorY };
}

export function setGlobalCursorPos(x: number, y: number): void {
  globalCursorX = x;
  globalCursorY = y;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Practiced human mouse glide:
 * - Natural cubic Bézier curves (smooth organic arcs, never robotic straight lines).
 * - Variable dynamic velocity (fast acceleration, smooth momentum, subtle target ease).
 * - High event density (dense 60fps stream of mousemove events for fluid video playback).
 * - Continuous unbroken trajectory across page navigations (zero teleportation).
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

  // Compute organic curve control points
  const midX = (startX + targetX) / 2;
  const midY = (startY + targetY) / 2;
  const normalX = -(targetY - startY) / (distance || 1);
  const normalY = (targetX - startX) / (distance || 1);

  // Subtle natural arc (5% to 15% curvature perpendicular to motion vector)
  const maxCurvature = Math.min(30, distance * 0.12);
  const arcDirection = (targetX + targetY) % 2 === 0 ? 1 : -1;
  const curvature = arcDirection * (8 + Math.random() * maxCurvature);

  const cp1X = startX + (midX - startX) * 0.45 + normalX * curvature;
  const cp1Y = startY + (midY - startY) * 0.45 + normalY * curvature;
  const cp2X = midX + (targetX - midX) * 0.55 + normalX * (curvature * 0.6);
  const cp2Y = midY + (targetY - midY) * 0.55 + normalY * (curvature * 0.6);

  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;

    // Smooth cubic ease-out (fast start, natural deceleration at target)
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
      cx += (Math.random() - 0.5) * 0.35;
      cy += (Math.random() - 0.5) * 0.35;
    }

    await page.evaluate(`
      (function() {
        var c = document.getElementById('playwright-virtual-mouse');
        if (c) {
          c.style.left = "${cx.toFixed(1)}px";
          c.style.top = "${cy.toFixed(1)}px";
        }
      })()
    `);

    await page.mouse.move(cx, cy);

    // High refresh rate: 10ms - 14ms per frame (approx 60fps)
    await sleep(10 + Math.floor(Math.random() * 4));
  }

  // Exact target anchor
  await page.evaluate(`
    (function() {
      var c = document.getElementById('playwright-virtual-mouse');
      if (c) {
        c.style.left = "${targetX}px";
        c.style.top = "${targetY}px";
      }
    })()
  `);
  await page.mouse.move(targetX, targetY);
  setGlobalCursorPos(targetX, targetY);
  await sleep(40);
}

/** Practiced human click with crisp, snappy press & release */
export async function humanClick(page: Page): Promise<void> {
  await sleep(30);

  await page.evaluate(`
    (function() {
      var c = document.getElementById('playwright-virtual-mouse');
      if (c) c.style.transform = 'translate(-4px, -2px) scale(0.9)';
    })()
  `);
  await page.mouse.down();
  await sleep(55);

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
 * Smooth, natural human scroll down the documentation page.
 *
 * Drives exactly ONE scroller per tick. Sending a wheel event *and* nudging
 * `scrollTop` (as this used to) makes the page travel roughly twice the
 * requested distance, which is what forced the depth target so low.
 * Travel is clamped to 75% of the page so the glide never bottoms out into
 * the footer or an overscroll bounce.
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

  const steps = 50;
  const interval = Math.max(25, Math.floor(durationMs / steps));
  let previousProgress = 0;

  // Native wheel keeps the compositor's own smoothing, so it is preferred.
  // Some doc layouts swallow it; the first tick proves which applies.
  let useWheel = true;
  let wheelProven = false;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Smooth cubic ease-in-out
    const currentProgress =
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const deltaY = Math.round((currentProgress - previousProgress) * actualTarget);
    previousProgress = currentProgress;

    if (deltaY > 0) {
      if (useWheel) {
        const before = wheelProven ? 0 : await readPos();
        await page.mouse.wheel(0, deltaY);

        if (!wheelProven) {
          const after = await readPos();
          wheelProven = true;
          if (after <= before) {
            // Wheel did nothing — fall back to programmatic scrolling for the rest.
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
    }

    await sleep(interval);
  }

  await sleep(300);
}
