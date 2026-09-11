import { type PageRecordConfig } from './types';

/**
 * Compiles every demo route the run is about to film, before the camera rolls.
 *
 * A dev server builds each route on its first request. That first request
 * used to happen inside the take, so every clip opened on a few seconds of a
 * compiling page -- the recorder logged it as "Waiting for Next.js compilation
 * & React hydration to settle" and the viewer saw a blank pause. Hitting all of
 * the shard's routes at once here moves that cost off camera and pays it once,
 * in parallel, instead of once per page in series.
 *
 * Pages that boot their own dev server are skipped: nothing is listening yet.
 * Failures are ignored -- a route that will not compile fails properly, on
 * camera, in its own take.
 */
export async function prewarmDemoRoutes(
  pages: PageRecordConfig[],
  { timeoutMs = 120_000, log = console.log }: { timeoutMs?: number; log?: (s: string) => void } = {},
): Promise<void> {
  // `devServer` exists only on the recorders that film the CLI; elsewhere it is
  // simply absent and every page qualifies.
  const bootsItself = (p: PageRecordConfig): boolean => Boolean((p as { devServer?: unknown }).devServer);
  const urls = [...new Set(pages.filter((p) => !bootsItself(p) && p.demoUrl).map((p) => p.demoUrl))];
  if (urls.length === 0) return;

  log(`\n🔥 Pre-warming ${urls.length} demo route(s) so no take opens on a cold compile...`);
  const started = Date.now();
  const outcomes = await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        // Read the body so the dev server finishes rendering, not just the headers.
        await res.text().catch(() => {});
        return res.ok ? 'ok' : `HTTP ${res.status}`;
      } catch {
        return 'no answer';
      }
    }),
  );
  const cold = outcomes.filter((o) => o !== 'ok').length;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`   ${urls.length - cold}/${urls.length} warm in ${secs}s${cold ? ` (${cold} did not answer; their takes will show why)` : ''}`);
}
