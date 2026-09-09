import fs from 'node:fs';
import path from 'node:path';
import { PROJECT } from '../config/project.config';

/**
 * CopilotKit versions, read from the scaffold this run is recording.
 *
 * A version typed into a demo goes stale the moment the package is bumped —
 * the Readables note claimed 1.66.2 and listed packages this repo does not even
 * install. Reading it here means the recording always states what actually ran.
 *
 * Both numbers are kept, because PROJECT_GOAL rule 4 asks every finding to pin
 * *installed vs declared*: `^1.69.3` in package.json is a range, and the range
 * is not what the demo exercised. The IDE step shows the declared side by
 * opening package.json itself; this module supplies the installed side.
 *
 * The directory read is the track's scaffold — `Npm/my-copilot-app` and its
 * pnpm and yarn twins — not a fixed `frontend/`. This repo has no `frontend/`,
 * and the whole point of three tracks is that resolution can differ between
 * them even though the source is byte-identical.
 */

/** Repo root: this file is `<repo>/autorecorder/core/versions.ts`. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface PackageVersion {
  /** Full package name, e.g. `@copilotkit/react-core`. */
  name: string;
  /** Short name for a one-line summary, e.g. `react-core`. */
  pkg: string;
  /** The range as package.json writes it, verbatim: `^1.69.3`. */
  declared: string;
  /** What is actually under node_modules, or null when nothing is installed. */
  installed: string | null;
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param projectDir Repo-relative scaffold root, e.g. `Npm/my-copilot-app`.
 */
function installedVersion(projectDir: string, pkgName: string): string | null {
  const pkgPath = path.join(
    REPO_ROOT,
    projectDir,
    'node_modules',
    ...pkgName.split('/'),
    'package.json',
  );
  const parsed = readJson(pkgPath);
  return typeof parsed?.version === 'string' ? parsed.version : null;
}

/** Every `@copilotkit/*` dependency of the scaffold, declared and installed. */
export function readCopilotKitVersions(
  projectDir: string = PROJECT.projectDir,
): PackageVersion[] {
  const parsed = readJson(path.join(REPO_ROOT, projectDir, 'package.json'));
  if (!parsed) return [];
  const deps: Record<string, string> = {
    ...parsed.dependencies,
    ...parsed.devDependencies,
  };

  return Object.keys(deps)
    .filter((name) => name.startsWith('@copilotkit/'))
    .sort()
    .map((name) => ({
      name,
      pkg: name.replace('@copilotkit/', ''),
      declared: deps[name],
      installed: installedVersion(projectDir, name),
    }));
}

/** The declared range with its `^` or `~` removed, for a fallback display. */
function bareRange(range: string): string {
  return range.replace(/^[\^~]/, '');
}

/**
 * One line naming the CopilotKit version, for a demo to display.
 *
 * `copilotkit 1.69.3 (react-core, runtime)` when the packages agree, and each
 * package listed separately when they do not. Returns an empty string if
 * nothing could be read, so a caller can drop the line rather than print
 * something wrong.
 */
export function formatCopilotKitVersionLine(
  projectDir: string = PROJECT.projectDir,
): string {
  const versions = readCopilotKitVersions(projectDir);
  if (versions.length === 0) return '';

  // A checkout that has not installed yet still gets a line, from the range.
  const shown = versions.map((v) => v.installed ?? bareRange(v.declared));
  const distinct = [...new Set(shown)];
  if (distinct.length === 1) {
    return `copilotkit ${distinct[0]} (${versions.map((v) => v.pkg).join(', ')})`;
  }
  return `copilotkit: ${versions.map((v, i) => `${v.pkg} ${shown[i]}`).join(', ')}`;
}

/**
 * The versions block the tester writes down on camera, installed beside
 * declared, one package per line.
 *
 * Written to be *read off a screen* rather than parsed: the columns line up,
 * and a package that is declared but not installed says so in words instead of
 * quietly falling back to the range — that gap is itself a finding.
 *
 * Returns an empty string when the scaffold has no CopilotKit dependency at
 * all, so the caller can skip the note rather than type an empty heading.
 */
export function formatVersionNote(
  projectDir: string = PROJECT.projectDir,
  track: string = PROJECT.track,
): string {
  const versions = readCopilotKitVersions(projectDir);
  if (versions.length === 0) return '';

  const width = Math.max(...versions.map((v) => v.name.length));
  const rows = versions.map((v) => {
    const name = v.name.padEnd(width);
    return v.installed === null
      ? `${name}  declared ${v.declared}, NOT INSTALLED`
      : `${name}  ${v.installed}  (declared ${v.declared})`;
  });

  return [`${track} track — installed vs declared`, '', ...rows].join('\n');
}
