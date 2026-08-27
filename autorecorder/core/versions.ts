import fs from 'node:fs';
import path from 'node:path';

/**
 * CopilotKit versions, read from the project at record time.
 *
 * A version typed into a demo goes stale the moment the package is bumped —
 * the Readables note claimed 1.66.2 and listed packages this repo does not even
 * install. Reading it here means the recording always states what actually ran.
 *
 * The installed version under node_modules wins over the range in
 * package.json, because `^1.69.0` is not what the demo exercised.
 */

const FRONTEND_DIR = path.resolve(import.meta.dirname, '..', '..', 'frontend');

export type PackageVersion = { pkg: string; version: string };

function installedVersion(pkgName: string): string | null {
  try {
    const pkgPath = path.join(FRONTEND_DIR, 'node_modules', ...pkgName.split('/'), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Every `@copilotkit/*` dependency, with the version actually installed. */
export function readCopilotKitVersions(): PackageVersion[] {
  let deps: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'package.json'), 'utf8'));
    deps = { ...parsed.dependencies, ...parsed.devDependencies };
  } catch {
    return [];
  }

  return Object.keys(deps)
    .filter((name) => name.startsWith('@copilotkit/'))
    .sort()
    .map((name) => ({
      pkg: name.replace('@copilotkit/', ''),
      // Fall back to the declared range, stripped of its ^ or ~, if the package
      // is not installed (a checkout that has not run npm install yet).
      version: installedVersion(name) ?? deps[name].replace(/^[\^~]/, ''),
    }));
}

/**
 * One line naming the CopilotKit version, for a demo to display.
 *
 * `copilotkit 1.69.2 (react-core, runtime)` when the packages agree, and each
 * package listed separately when they do not. Returns an empty string if
 * nothing could be read, so a caller can drop the line rather than print
 * something wrong.
 */
export function formatCopilotKitVersionLine(): string {
  const versions = readCopilotKitVersions();
  if (versions.length === 0) return '';

  const distinct = [...new Set(versions.map((v) => v.version))];
  if (distinct.length === 1) {
    return `copilotkit ${distinct[0]} (${versions.map((v) => v.pkg).join(', ')})`;
  }
  return `copilotkit: ${versions.map((v) => `${v.pkg} ${v.version}`).join(', ')}`;
}
