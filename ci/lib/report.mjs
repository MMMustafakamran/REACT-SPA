/**
 * RUN_REPORT.md / RUN_REPORT.json — the artifact a run is judged by.
 *
 * The markdown is appended to the GitHub step summary by the workflow, so it
 * has to read well on its own, without the job log next to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TRACKS, VIDEOS_DIR } from './config.mjs';

/**
 * What each track actually resolved to.
 *
 * Recorded per track rather than once, because that is the whole question a
 * three-track run answers: the same source, three resolutions.
 */
/**
 * What actually ran -- not what package.json asks for.
 *
 * ci/automate.mjs re-resolves from the ranges by default, so a run tests the
 * newest versions those ranges allow. Reading `pkg.dependencies` reported the
 * FLOOR of a range rather than the version under test -- a run against
 * @copilotkit/react-core 1.69.3 reported "^1.69.2". Read the installed tree
 * instead, keeping the declared range alongside when the two differ.
 */
function resolveVersion(dir, pkg, name) {
  const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  let installed;
  try {
    const manifest = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch {
    // Not installed: a report written before install, or after a failed one.
  }
  if (!declared && !installed) return 'n/a';
  if (!installed) return `${declared} (not installed)`;
  if (!declared) return installed;
  return declared === installed ? installed : `${installed} (declared ${declared})`;
}

function trackVersions() {
  const out = {};
  for (const [name, t] of Object.entries(TRACKS)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(t.dir, 'package.json'), 'utf8'));
      out[name] = {
        '@copilotkit/react-core': resolveVersion(t.dir, pkg, '@copilotkit/react-core'),
        '@copilotkit/runtime': resolveVersion(t.dir, pkg, '@copilotkit/runtime'),
        react: resolveVersion(t.dir, pkg, 'react'),
        vite: pkg.devDependencies?.vite ?? 'n/a',
      };
    } catch {
      out[name] = null;
    }
  }
  return out;
}

function listVideos() {
  const videos = [];
  try {
    for (const f of fs.readdirSync(VIDEOS_DIR)) {
      if (!f.endsWith('.webm') || f.startsWith('temp_')) continue;
      const stats = fs.statSync(path.join(VIDEOS_DIR, f));
      videos.push({ filename: f, sizeMB: `${(stats.size / (1024 * 1024)).toFixed(2)} MB` });
    }
  } catch {
    // ignore
  }
  return videos.sort((a, b) => a.filename.localeCompare(b.filename));
}

export function generateReport(data) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  const videos = listVideos();
  const drift = data.driftResult;

  const report = {
    timestamp: new Date().toISOString(),
    status: data.success ? 'SUCCESS' : 'FAILED',
    tracks: data.selectedTracks ?? [],
    trackResults: data.tracks ?? {},
    refreshedDeps: Boolean(data.refreshed),
    args: data.args?.length ? data.args.join(' ') : 'all',
    docDrift: {
      checkedPages: drift?.total ?? 0,
      drifted: Boolean(drift?.drifted),
      gating: Boolean(drift?.gating),
      highestSeverity: drift?.highestSeverity ?? null,
      pages: (drift?.driftedPages ?? []).map((p) => ({
        docPath: p.docPath,
        severity: p.severity,
        reason: p.reason,
      })),
      fetchErrors: (drift?.errors ?? []).map((e) => ({ docPath: e.docPath, error: e.error })),
    },
    versions: trackVersions(),
    videos,
    error: data.error ?? null,
  };

  fs.writeFileSync(
    path.join(VIDEOS_DIR, 'RUN_REPORT.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  const md = [];
  md.push(`## ${data.success ? '✅' : '❌'} React SPA doc verification — ${report.status}`);
  md.push('');
  md.push(`Tracks: **${report.tracks.join(', ') || 'none'}** · ${report.timestamp}`);
  md.push('');

  // Drift first: on a red run it is the most likely reason.
  if (report.docDrift.drifted) {
    md.push(
      `### 📄 Doc drift — ${report.docDrift.pages.length}/${report.docDrift.checkedPages} pages moved` +
        `${report.docDrift.gating ? ' · **run halted**' : ' · prose only, recorded through'}`,
    );
    md.push('');
    md.push('| Page | Severity | What moved |');
    md.push('|---|---|---|');
    for (const p of report.docDrift.pages) {
      md.push(`| \`${p.docPath}\` | ${p.severity} | ${p.reason} |`);
    }
    md.push('');
  } else {
    md.push(`📄 Doc drift: none — all ${report.docDrift.checkedPages} tracked pages match.`);
    md.push('');
  }

  if (report.docDrift.fetchErrors.length > 0) {
    md.push('> Some pages could not be fetched, so drift is unknown for them:');
    for (const e of report.docDrift.fetchErrors) md.push(`> - \`${e.docPath}\`: ${e.error}`);
    md.push('');
  }

  const resolved = Object.entries(report.trackResults);
  if (resolved.length > 0) {
    md.push('### Tracks');
    md.push('');
    md.push('| Track | Runtime up | App up | Recorded | @copilotkit/react-core |');
    md.push('|---|---|---|---|---|');
    for (const [name, r] of resolved) {
      md.push(
        `| ${name} | ${r.health?.runtime ?? '—'}s | ${r.health?.frontend ?? '—'}s |` +
          ` ${r.recorded ? '✅' : '❌'} | ${report.versions[name]?.['@copilotkit/react-core'] ?? 'n/a'} |`,
      );
    }
    md.push('');
  }

  if (videos.length > 0) {
    md.push('### Recordings');
    md.push('');
    for (const v of videos) md.push(`- \`${v.filename}\` (${v.sizeMB})`);
    md.push('');
  }

  if (report.error) {
    md.push('### Failure');
    md.push('');
    md.push('```');
    md.push(report.error);
    md.push('```');
    md.push('');
  }

  md.push(
    report.refreshedDeps
      ? '_Dependencies were re-resolved from the ranges in package.json._'
      : '_Dependencies were installed from the committed lockfiles (`--use-lockfile`)._',
  );

  fs.writeFileSync(path.join(VIDEOS_DIR, 'RUN_REPORT.md'), `${md.join('\n')}\n`, 'utf8');
}
