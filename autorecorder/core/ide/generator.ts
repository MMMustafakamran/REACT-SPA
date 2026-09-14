import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHighlighter, type Highlighter } from 'shiki';

export interface IdeTabConfig {
  filePath: string;
  startLine: number;
  endLine: number;
  tabLabel?: string;
}

/**
 * One integrated-terminal session in the IDE panel.
 *
 * There is deliberately no `command` or `cwd` field. Everything the panel
 * shows — the prompt, the command line, the output under it — is read out of
 * the session file that `capture.ts` wrote while the service was actually
 * running. Nothing on that screen can be edited into saying something the
 * machine did not do.
 */
export interface TerminalSessionConfig {
  /** Tab label in the panel's session list, e.g. `vite`. */
  label: string;
  /** Repo-relative session file written by `capture.ts`. */
  logFile: string;
}

/** A parsed session file: its recorded header plus its recorded output. */
interface CapturedSession {
  cwd: string;
  command: string;
  lines: string[];
}

/**
 * Splits a session file into the header `capture.ts` wrote and the output the
 * process produced.
 *
 * A file without the header is rejected rather than displayed. It means the
 * service was started by hand instead of through the wrapper, so the one line
 * the panel cannot verify — the command — would have to be invented.
 */
function parseSession(raw: string, logFile: string): CapturedSession {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const cwdLine = lines[0] ?? '';
  const cmdLine = lines[1] ?? '';

  if (!cwdLine.startsWith('#cwd ') || !cmdLine.startsWith('#cmd ')) {
    throw new Error(
      `${logFile} has no capture header -- start the service with ` +
        `"npx tsx capture.ts <name> -- <command>" so the prompt line is recorded too`,
    );
  }

  // Trailing blank lines are the process still being alive, not content.
  const body = lines.slice(2);
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  while (body.length && body[0].trim() === '') body.shift();

  return {
    cwd: cwdLine.slice(5).trim(),
    command: cmdLine.slice(5).trim(),
    lines: body,
  };
}

/** Foreground colours for the SGR codes a dev server actually emits. */
const ANSI_COLORS: Record<string, string> = {
  '30': '#666666', '31': '#f14c4c', '32': '#23d18b', '33': '#f5f543',
  '34': '#3b8eea', '35': '#d670d6', '36': '#29b8db', '37': '#e5e5e5',
  '90': '#7f7f7f', '91': '#f14c4c', '92': '#23d18b', '93': '#f5f543',
  '94': '#3b8eea', '95': '#d670d6', '96': '#29b8db', '97': '#ffffff',
};

/**
 * ANSI SGR sequences to spans, everything else stripped.
 *
 * Vite and the runtime both colour their banners, and a terminal that renders
 * `[32m` as literal text reads as a screenshot of a broken shell. Only the
 * codes those two actually emit are honoured -- colour, bold, dim, reset --
 * and any other escape (cursor moves, erase-line from spinners) is dropped
 * rather than guessed at.
 */
function ansiToHtml(line: string): string {
  let html = '';
  let open = 0;
  let last = 0;
  const re = /\u001b\[([0-9;]*)m/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    html += escapeHtml(line.slice(last, m.index));
    last = m.index + m[0].length;

    for (const code of (m[1] || '0').split(';')) {
      if (code === '' || code === '0') {
        html += '</span>'.repeat(open);
        open = 0;
      } else if (code === '1') {
        html += '<span style="font-weight:600;">';
        open++;
      } else if (code === '2') {
        html += '<span style="opacity:0.65;">';
        open++;
      } else if (ANSI_COLORS[code]) {
        html += `<span style="color:${ANSI_COLORS[code]};">`;
        open++;
      }
    }
  }

  html += escapeHtml(line.slice(last));
  html += '</span>'.repeat(open);
  // Cursor moves, erase-line, and the rest of the escape zoo: not renderable
  // here and never meaningful in a captured log.
  return html.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Per-line syntax tokens from Shiki's real TextMate grammars.
 *
 * This replaced a hand-rolled regex highlighter. That version ran its keyword,
 * prop and number passes over markup it had already emitted, so a rule would
 * rewrite the `style` attribute of a span produced by an earlier rule --
 * `<span <span style="...">style</span>="color:...">` -- leaking raw CSS into
 * the rendered code pane on 642 lines across 16 of the 17 configured pages.
 *
 * Tokenizing first and escaping only token *content* makes that class of bug
 * structurally impossible: no pattern ever sees generated HTML.
 */
const SHIKI_THEME = 'dark-plus';

/** Grammars preloaded once; must cover every extension langFor() can return. */
const SHIKI_LANGS = ['tsx', 'typescript', 'javascript', 'json', 'python', 'markdown'] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [SHIKI_THEME],
    langs: [...SHIKI_LANGS],
  });
  return highlighterPromise;
}

function langFor(ext: string): (typeof SHIKI_LANGS)[number] | null {
  if (ext === 'tsx' || ext === 'jsx') return 'tsx';
  if (ext === 'ts') return 'typescript';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'json') return 'json';
  if (ext === 'py') return 'python';
  if (ext === 'md') return 'markdown';
  return null;
}

/** Shiki's fontStyle is a bitmask: 1 italic, 2 bold, 4 underline. */
function fontStyleCss(fontStyle: number | undefined): string {
  if (!fontStyle) return '';
  let css = '';
  if (fontStyle & 1) css += 'font-style:italic;';
  if (fontStyle & 2) css += 'font-weight:bold;';
  if (fontStyle & 4) css += 'text-decoration:underline;';
  return css;
}

/**
 * @returns One HTML string per source line, already escaped and safe to embed.
 *   Falls back to plain escaped text when the language has no grammar, so an
 *   unknown extension renders readable code rather than nothing.
 */
async function highlightLines(code: string, ext: string): Promise<string[]> {
  const rawLines = code.split('\n');
  const plain = (): string[] =>
    rawLines.map((l) => (l.trim() ? escapeHtml(l) : '&nbsp;'));

  const lang = langFor(ext);
  if (!lang) return plain();

  try {
    const highlighter = await getHighlighter();
    const { tokens } = highlighter.codeToTokens(code, {
      lang,
      theme: SHIKI_THEME,
    });

    return rawLines.map((raw, idx) => {
      if (!raw.trim()) return '&nbsp;';
      const lineTokens = tokens[idx];
      if (!lineTokens) return escapeHtml(raw);

      return lineTokens
        .map(
          (t) =>
            `<span style="color:${t.color ?? '#d4d4d4'};${fontStyleCss(
              t.fontStyle,
            )}">${escapeHtml(t.content)}</span>`,
        )
        .join('');
    });
  } catch {
    // Never let a highlighting failure blank out the IDE pane.
    return plain();
  }
}

function getFileIcon(ext: string): string {
  const isTsx = ext === 'tsx' || ext === 'ts' || ext === 'js' || ext === 'jsx';
  const isPython = ext === 'py';
  const isJson = ext === 'json';
  const isMd = ext === 'md';

  if (isPython) {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M11.9 2c-4.4 0-4.1 1.9-4.1 1.9l.01 2h4.2v.6H5.8S2 6.1 2 10.6s3.3 4.3 3.3 4.3h2v-2.8s-.1-3.3 3.3-3.3h5.7s3.2.1 3.2-3.1-3.2-3.7-7.6-3.7z" fill="#3776ab"/><path d="M12.1 22c4.4 0 4.1-1.9 4.1-1.9l-.01-2h-4.2v-.6h6.2s3.8.4 3.8-4.1-3.3-4.3-3.3-4.3h-2v2.8s.1 3.3-3.3 3.3H7.7s-3.2-.1-3.2 3.1 3.2 3.7 7.6 3.7z" fill="#ffd43b"/><circle cx="9.5" cy="4.5" r=".7" fill="#fff"/><circle cx="14.5" cy="19.5" r=".7" fill="#fff"/></svg>`;
  }
  if (ext === 'tsx' || ext === 'jsx') {
    // Seti's React atom, the icon VS Code shows for .tsx.
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#519aba" stroke-width="1.4"><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.6" fill="#519aba" stroke="none"/></svg>`;
  }
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return `<svg width="15" height="15" viewBox="0 0 24 24"><text x="2" y="18" fill="#cbcb41" font-family="Segoe UI, sans-serif" font-size="13" font-weight="bold">JS</text></svg>`;
  }
  if (isTsx) {
    return `<svg width="15" height="15" viewBox="0 0 24 24"><text x="2" y="18" fill="#519aba" font-family="Segoe UI, sans-serif" font-size="13" font-weight="bold">TS</text></svg>`;
  }
  if (isJson) {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="#cbcb41"><text x="3" y="17" fill="#cbcb41" font-family="Consolas, monospace" font-size="14" font-weight="bold">{ }</text></svg>`;
  }
  if (isMd) {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="#42a5f5"><rect width="24" height="24" rx="2" fill="none" stroke="#42a5f5" stroke-width="2"/><path d="M4 16V8l4 4 4-4v8M17 8v8m-3-3l3 3 3-3" fill="none" stroke="#42a5f5" stroke-width="2"/></svg>`;
  }
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="#858585"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="#90a4ae"/></svg>`;
}

function getLangLabel(ext: string): string {
  if (ext === 'py') return 'Python 3.12';
  if (ext === 'tsx' || ext === 'ts' || ext === 'jsx' || ext === 'js')
    return 'TypeScript JSX';
  if (ext === 'json') return 'JSON';
  if (ext === 'md') return 'Markdown';
  return 'Plain Text';
}

export async function generateIdeHtml(
  rootDir: string,
  primaryFilePath: string,
  startLine = 1,
  endLine = 30,
  extraTabs: IdeTabConfig[] = [],
  activeTabIdx = 0,
  terminals: TerminalSessionConfig[] = [],
): Promise<string> {
  const tabsList: IdeTabConfig[] = [
    { filePath: primaryFilePath, startLine, endLine },
    ...extraTabs,
  ];

  // Read and tokenize every tab up front; the render below stays synchronous.
  const tabSources = await Promise.all(
    tabsList.map(async (tab) => {
      const fullPath = join(rootDir, tab.filePath);
      const missing = !existsSync(fullPath);
      // Said out loud. A missing ideFile used to render one grey comment line
      // and nothing else, which films as an empty editor -- indistinguishable
      // from a short file. That is how every generated VERSIONS.md reached the
      // demos blank: gitignored, not written on the --skip-install path, and
      // no complaint from anywhere in the pipeline.
      if (missing) {
        console.warn(`   ⚠️  IDE file missing: ${tab.filePath} -- the clip will show an empty editor.`);
      }
      const raw = missing ? '// File not found' : readFileSync(fullPath, 'utf-8');
      // Normalize CRLF so a stray \r never lands inside a rendered code line.
      const code = raw.replace(/\r\n/g, '\n');
      const ext = basename(tab.filePath).split('.').pop() ?? '';
      return { code, ext, lines: await highlightLines(code, ext) };
    }),
  );

  // Terminal sessions, read from the captured logs.
  //
  // A missing or empty log throws rather than rendering an empty terminal: the
  // whole claim of this panel is that the output is real, and a silently blank
  // one would look like a service that started and printed nothing.
  const terminalSessions = terminals.map((term) => {
    const fullPath = join(rootDir, term.logFile);
    if (!existsSync(fullPath)) {
      throw new Error(
        `terminal "${term.label}": no captured session at ${term.logFile} -- ` +
          `start the service through capture.ts before recording`,
      );
    }
    const session = parseSession(readFileSync(fullPath, 'utf-8'), term.logFile);
    if (session.lines.length === 0) {
      throw new Error(`terminal "${term.label}": ${term.logFile} captured no output`);
    }
    return { ...term, ...session, html: session.lines.map(ansiToHtml) };
  });
  const hasTerminal = terminalSessions.length > 0;

  // Render tab headers
  const tabHeadersHtml = tabsList
    .map((tab, idx) => {
      const fileName = basename(tab.filePath);
      const ext = fileName.split('.').pop() ?? '';
      const icon = getFileIcon(ext);
      const isActive = idx === activeTabIdx;

      return `
        <div
          id="ide-tab-${idx}"
          class="tab ${isActive ? 'active' : ''}"
          onclick="window.switchIdeTab(${idx})"
          style="${
            isActive
              ? 'background:#1f1f1f;border-top:1px solid #0078d4;color:#ffffff;'
              : 'background:#181818;border-top:1px solid transparent;color:#9d9d9d;'
          }"
        >
          <span class="file-icon">${icon}</span>
          <span>${escapeHtml(fileName)}</span>
          <span class="close-btn">&#x2715;</span>
        </div>
      `;
    })
    .join('');

  // Render file viewports for all tabs
  const tabBodiesHtml = tabsList
    .map((tab, idx) => {
      const { code, ext, lines: highlightedLines } = tabSources[idx];

      const fileName = basename(tab.filePath);
      const normalizedPath = tab.filePath.replace(/\\/g, '/');
      const pathParts = normalizedPath.split('/');
      const codeLines = code.split('\n');

      const linesHtml = codeLines
        .map((line, lIdx) => {
          const lineNum = lIdx + 1;
          const isHighlighted =
            lineNum >= tab.startLine && lineNum <= tab.endLine;
          const isCaretLine = lineNum === tab.startLine;
          const highlightedContent = highlightedLines[lIdx] ?? '&nbsp;';

          // The snippet is marked, not yet highlighted: the recorder selects
          // it on camera by dragging the cursor down the lines, adding the
          // `highlighted` classes as it goes (window.selectIdeLines). A range
          // already painted when the window fades in read as a slide, not as
          // a person finding the code.
          const snippetAttr = isHighlighted ? ' data-snippet="1"' : '';
          const caretHtml = isCaretLine ? '<span class="vs-caret"></span>' : '';

          return `
            <div class="code-line" data-line="${lineNum}"${snippetAttr}>
              <div class="line-num">${lineNum}</div>
              <div class="line-content"><span>${highlightedContent}${caretHtml}</span></div>
            </div>
          `;

        })
        .join('');

      const minimapHtml = codeLines
        .slice(0, 100)
        .map((line, lIdx) => {
          const lineNum = lIdx + 1;
          const isHighlighted =
            lineNum >= tab.startLine && lineNum <= tab.endLine;
          const width = Math.min(
            Math.max((line.trim().length / 60) * 100, 10),
            90,
          );
          return `<div class="minimap-line ${
            isHighlighted ? 'active' : ''
          }" style="width:${width}%;"></div>`;
        })
        .join('');

      const breadcrumbsHtml = pathParts
        .map((part, pIdx) => {
          const isLast = pIdx === pathParts.length - 1;
          return `
            <span class="breadcrumb-item ${isLast ? 'active' : ''}">
              ${
                isLast
                  ? getFileIcon(ext)
                  : ''
              }
              <span>${escapeHtml(part)}</span>
            </span>
            ${!isLast ? '<span class="breadcrumb-sep">&rsaquo;</span>' : ''}
          `;
        })
        .join('');

      const isDisplayed = idx === activeTabIdx;

      return `
        <div id="ide-view-${idx}" class="editor-body-view" style="display:${
        isDisplayed ? 'flex' : 'none'
      };flex-direction:column;flex:1;overflow:hidden;">
          <div class="breadcrumbs-bar">
            ${breadcrumbsHtml}
          </div>
          <div class="editor-body">
            <div class="code-viewport">
              ${linesHtml}
            </div>
            <div class="minimap">
              ${minimapHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  // Build tree nodes for primary file + extra tabs
  const primaryParts = primaryFilePath.replace(/\\/g, '/').split('/');
  const treeNodes: string[] = [];

  for (let i = 0; i < primaryParts.length; i++) {
    const isFile = i === primaryParts.length - 1;
    const part = primaryParts[i];
    const indentClass = i === 0 ? '' : `pl-${Math.min(i, 4)}`;

    if (isFile) {
      const ext = part.split('.').pop() ?? '';
      treeNodes.push(`
        <div class="tree-node ${indentClass} file-node active-file" data-tab-idx="0" onclick="window.switchIdeTab(0)">
          <span class="file-icon">${getFileIcon(ext)}</span>
          <span class="file-label">${escapeHtml(part)}</span>
        </div>
      `);
    } else {
      treeNodes.push(`
        <div class="tree-node ${indentClass} folder-node">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#c5c5c5" stroke-width="1.3"><path d="m4 6 4 4 4-4"/></svg>
          <span class="folder-name">${escapeHtml(part)}</span>
        </div>
      `);
    }
  }

  // Extra files in tree
  extraTabs.forEach((extra, eIdx) => {
    const eParts = extra.filePath.replace(/\\/g, '/').split('/');
    const eName = eParts[eParts.length - 1];
    const eExt = eName.split('.').pop() ?? '';
    const eIndent = `pl-${Math.min(eParts.length - 1, 4)}`;

    treeNodes.push(`
      <div class="tree-node ${eIndent} file-node" data-tab-idx="${eIdx + 1}" onclick="window.switchIdeTab(${eIdx + 1})">
        <span class="file-icon">${getFileIcon(eExt)}</span>
        <span class="file-label">${escapeHtml(eName)}</span>
      </div>
    `);
  });

  const primaryExt = basename(primaryFilePath).split('.').pop() ?? '';
  const primaryLang = getLangLabel(primaryExt);
  const projectName = basename(rootDir) || 'workspace';

  // The status bar follows the active tab, the way the real one does. It used
  // to be computed once from the primary file, which went unnoticed while every
  // tab was TypeScript -- a package.json tab made it read "TypeScript JSX" over
  // a JSON file, and a status bar that lies about the pane above it undoes the
  // whole point of simulating the editor.
  const tabStatus = tabsList.map((tab) => ({
    lang: getLangLabel(basename(tab.filePath).split('.').pop() ?? ''),
    line: tab.startLine,
  }));
  const tabStatusJson = JSON.stringify(tabStatus);
  // The first frame is whichever tab opens active, not necessarily tab 0.
  const openStatus = tabStatus[activeTabIdx] ?? { lang: primaryLang, line: startLine };

  const terminalSessionsHtml = terminalSessions
    .map(
      (t, i) => `
        <div id="term-tab-${i}" class="term-session ${i === 0 ? 'active' : ''}" onclick="window.ideSwitchTerminal(${i})">
          <span class="term-session-icon">&gt;_</span>
          <span>${escapeHtml(t.label)}</span>
        </div>`,
    )
    .join('');

  const terminalBodiesHtml = terminalSessions
    .map(
      (t, i) => `
        <div id="term-body-${i}" class="term-body" style="display:${i === 0 ? 'block' : 'none'};">
          <div class="term-line">
            <span class="term-prompt">PS ${escapeHtml(t.cwd)}&gt;</span><span class="term-cmd">${escapeHtml(t.command)}</span>
          </div>
          <div class="term-out">${t.html
            .map((line) => `<div class="term-line-out">${line === '' ? '&nbsp;' : line}</div>`)
            .join('')}</div>
          <!--
            A bare caret, not a fresh prompt. These processes are still running
            when the frame is taken; printing "PS ...>" under their output would
            say the opposite, and be the one line on screen that misrepresents
            the machine.
          -->
          <div class="term-line term-live"><span class="term-caret"></span></div>
        </div>`,
    )
    .join('');

  const terminalPanelHtml = hasTerminal
    ? `
        <div id="ide-terminal-panel" class="terminal-panel" style="display:none;">
          <div class="terminal-header">
            <div class="terminal-header-tabs">
              <span>PROBLEMS</span>
              <span>OUTPUT</span>
              <span>DEBUG CONSOLE</span>
              <span class="active">TERMINAL</span>
              <span>PORTS</span>
            </div>
            <div class="terminal-header-actions">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM12 3v18"/></svg>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </div>
          </div>
          <div class="terminal-main">
            <div class="terminal-views">
              ${terminalBodiesHtml}
            </div>
            <div class="terminal-sessions">
              ${terminalSessionsHtml}
            </div>
          </div>
        </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(projectName)} - Visual Studio Code</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body, html {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background-color: #1f1f1f;
      color: #cccccc;
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .vscode-container {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      animation: win11Open 0.22s cubic-bezier(0.1, 0.9, 0.2, 1);
    }
    @keyframes win11Open {
      0% {
        opacity: 0.85;
        transform: scale(0.99) translateY(8px);
      }
      100% {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }
    /* Titlebar */
    .titlebar {
      height: 35px;
      background: #181818;
      border-bottom: 1px solid #2b2b2b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 12px;
      color: #9d9d9d;
    }
    .titlebar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .menubar {
      display: flex;
      gap: 10px;
      font-size: 12px;
      color: #cccccc;
    }
    .menubar span {
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .menubar span:hover {
      background: #2a2d2e;
    }
    /* Command Palette Search Box */
    .titlebar-center {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: 440px;
      height: 24px;
      background: #2a2a2a;
      border: 1px solid #3c3c3c;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 11px;
      color: #cccccc;
      cursor: pointer;
    }
    .titlebar-center .search-left {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .titlebar-center .keybadge {
      background: #383838;
      border: 1px solid #4a4a4a;
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 10px;
      color: #858585;
    }
    .titlebar-controls {
      display: flex;
      align-items: center;
      gap: 16px;
      color: #858585;
      font-size: 13px;
    }
    /* Main Layout */
    .main-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    /* Activity Bar */
    .activity-bar {
      width: 48px;
      background: #181818;
      border-right: 1px solid #2b2b2b;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      color: #858585;
    }
    .activity-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: center;
    }
    .activity-icon {
      width: 42px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      cursor: pointer;
    }
    .activity-icon.active {
      color: #ffffff;
    }
    .activity-icon.active::before {
      content: '';
      position: absolute;
      left: 0;
      top: 6px;
      bottom: 6px;
      width: 2px;
      background: #007acc;
    }
    .badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: #007acc;
      color: #ffffff;
      font-size: 9px;
      font-weight: bold;
      border-radius: 8px;
      padding: 1px 4px;
    }
    /* Sidebar */
    .sidebar {
      width: 250px;
      background: #181818;
      border-right: 1px solid #2b2b2b;
      display: flex;
      flex-direction: column;
      font-size: 12px;
    }
    .sidebar-header {
      padding: 10px 16px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #bbbbbb;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sidebar-project {
      padding: 6px 12px;
      font-weight: bold;
      font-size: 11px;
      color: #e1e1e1;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .file-tree {
      flex: 1;
      overflow-y: auto;
      padding: 2px 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      line-height: 22px;
    }
    .tree-node {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 6px;
      color: #cccccc;
      border-radius: 0;
      cursor: pointer;
      position: relative;
    }
    .tree-node.pl-1 { padding-left: 14px; }
    .tree-node.pl-2 { padding-left: 22px; }
    .tree-node.pl-3 { padding-left: 30px; }
    .tree-node.pl-4 { padding-left: 38px; }
    /* Files sit under the chevron column, the way the real tree indents them. */
    .tree-node.file-node { padding-left: 22px; }
    .tree-node.file-node.pl-1 { padding-left: 30px; }
    .tree-node.file-node.pl-2 { padding-left: 38px; }
    .tree-node.file-node.pl-3 { padding-left: 46px; }
    .tree-node.file-node.pl-4 { padding-left: 54px; }
    .tree-node.active-file {
      background: #04395e;
      outline: 1px solid #0078d4;
      outline-offset: -1px;
      color: #ffffff;
    }
    .folder-name { color: #cccccc; }
    .file-icon { display: flex; align-items: center; }
    /* Editor Area */
    .editor-pane {
      display: flex;
      flex-direction: column;
      flex: 1;
      background: #1f1f1f;
      overflow: hidden;
      position: relative;
    }
    .tabs-bar {
      height: 35px;
      background: #181818;
      border-bottom: 1px solid #2b2b2b;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tabs-left {
      display: flex;
      height: 100%;
    }
    .tab {
      height: 100%;
      border-right: 1px solid #2b2b2b;
      padding: 0 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .tab .close-btn {
      color: #858585;
      font-size: 12px;
      margin-left: 6px;
      border-radius: 3px;
      padding: 1px 3px;
    }
    .tab .close-btn:hover {
      background: #333;
      color: #fff;
    }
    .tabs-right-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-right: 12px;
      color: #858585;
    }
    .breadcrumbs-bar {
      height: 22px;
      background: #1f1f1f;
      border-bottom: 1px solid #2b2b2b;
      padding: 0 16px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      color: #858585;
    }
    .breadcrumb-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .breadcrumb-item.active {
      color: #cccccc;
    }
    .breadcrumb-sep {
      color: #6f6f6f;
      font-size: 14px;
      line-height: 1;
    }
    /* Code Viewer */
    .editor-body {
      display: flex;
      flex: 1;
      overflow: hidden;
      position: relative;
    }
    .code-viewport {
      flex: 1;
      overflow-y: auto;
      padding: 10px 0 60px 0;
      font-family: Consolas, 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'DejaVu Sans Mono', 'Liberation Mono', 'Droid Sans Mono', monospace;
      font-size: 14px;
      line-height: 22px;
      -webkit-font-smoothing: antialiased;
    }
    .code-line {
      display: flex;
      align-items: center;
      width: 100%;
      min-height: 22px;
    }
    /*
     * The range marker only. The fill itself belongs to the text, not the row
     * -- see .line-content.highlighted > span below.
     *
     * box-shadow rather than border-left: a border is part of the box, so it
     * pushed every highlighted line 3px right of the unhighlighted lines around
     * it, and the code visibly stepped in and out at the range edges.
     */
    .code-line.highlighted {
      /* A real selection has no gutter marker; the fill on the text is it. */
    }
    .line-num {
      width: 58px;
      text-align: right;
      padding-right: 18px;
      color: #6e7681;
      flex-shrink: 0;
      user-select: none;
      font-size: 12px;
    }
    .line-num.highlighted {
      color: #cccccc;
    }
    .line-content {
      flex: 1;
      white-space: pre;
      color: #d4d4d4;
      padding-right: 24px;
    }
    .line-content.highlighted {
      color: #d4d4d4;
    }
    /*
     * Hug the glyphs, the way an editor selection does, instead of flooding the
     * row to the right-hand edge of the pane. The span is inline, so its
     * background ends where the line's text ends -- including the leading
     * indentation, which is part of the token stream.
     */
    .line-content.highlighted > span {
      background: #264f78;
      border-radius: 0;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    /* Blinking VS Code Caret */
    .vs-caret {
      display: inline-block;
      width: 2px;
      height: 15px;
      background: #528bff;
      margin-left: 2px;
      vertical-align: middle;
      animation: vsBlink 1s step-start infinite;
    }
    @keyframes vsBlink {
      50% { opacity: 0; }
    }
    /* Minimap */
    .minimap {
      width: 68px;
      background: #181818;
      border-left: 1px solid #252526;
      display: flex;
      flex-direction: column;
      padding: 10px 6px;
      gap: 3px;
      opacity: 0.65;
      overflow: hidden;
    }
    .minimap-line {
      height: 2px;
      background: #4a4a4a;
      border-radius: 1px;
    }
    .minimap-line.active {
      background: #007acc;
      box-shadow: 0 0 4px #007acc;
    }
    /* Status Bar */
    .statusbar {
      height: 22px;
      background: #181818;
      border-top: 1px solid #2b2b2b;
      color: #cccccc;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 11px;
      z-index: 10;
    }
    .statusbar-left, .statusbar-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .statusbar-item {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    /* ── Integrated terminal ─────────────────────────────────────────── */
    .terminal-panel {
      height: 38%;
      min-height: 210px;
      display: flex;
      flex-direction: column;
      background: #181818;
      border-top: 1px solid #2b2b2b;
    }
    .terminal-header {
      height: 35px;
      flex: 0 0 35px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 18px;
      border-bottom: 1px solid #2b2b2b;
    }
    .terminal-header-tabs {
      display: flex;
      gap: 16px;
      font-size: 11px;
      letter-spacing: 0.4px;
      color: #9d9d9d;
    }
    .terminal-header-tabs .active {
      color: #e7e7e7;
      border-bottom: 1px solid #0078d4;
      padding-bottom: 3px;
    }
    .terminal-header-actions {
      display: flex;
      gap: 12px;
      color: #9d9d9d;
    }
    .terminal-main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .terminal-views {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0 10px 18px;
      font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.45;
      color: #cccccc;
    }
    .terminal-views::-webkit-scrollbar { width: 10px; }
    .terminal-views::-webkit-scrollbar-thumb { background: #3a3a3a; }
    .term-prompt { color: #16c60c; margin-right: 6px; }
    .term-cmd { color: #e5e5e5; white-space: pre; }
    .term-line-out { white-space: pre-wrap; }
    .term-caret {
      display: inline-block;
      width: 7px;
      height: 15px;
      background: #cccccc;
      vertical-align: text-bottom;
      animation: termBlink 1.05s steps(1) infinite;
    }
    @keyframes termBlink { 50% { opacity: 0; } }
    .terminal-sessions {
      width: 168px;
      flex: 0 0 168px;
      border-left: 1px solid #2b2b2b;
      padding: 6px 0;
      font-size: 12px;
    }
    .term-session {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 3px 10px;
      color: #cccccc;
      cursor: pointer;
    }
    .term-session.active { background: #04395e; }
    .term-session-icon { color: #9d9d9d; font-size: 11px; }
  </style>
</head>
<body>
  <div class="vscode-container">
    <!-- Title Bar -->
    <header class="titlebar">
      <div class="titlebar-left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#007acc">
          <path d="M18.5 2.5 12 8.5 7 4.5 3.5 6v12L7 19.5l5-4 6.5 6 3-1.5V4l-3-1.5z" />
        </svg>
        <div class="menubar">
          <span>File</span>
          <span>Edit</span>
          <span>Selection</span>
          <span>View</span>
          <span>Go</span>
          <span>Run</span>
          <span>Terminal</span>
          <span>Help</span>
        </div>
      </div>

      <div class="titlebar-center">
        <div class="search-left">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#858585" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <span>${escapeHtml(projectName.toLowerCase())} &gt; ${escapeHtml(
            primaryFilePath.replace(/\\/g, '/'),
          )}</span>
        </div>
        <span class="keybadge">Ctrl + P</span>
      </div>

      <div class="titlebar-controls">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
        <span>&#x2500;</span>
        <span>&#x25A1;</span>
        <span>&#x2715;</span>
      </div>
    </header>

    <!-- Main Workspace -->
    <div class="main-body">
      <!-- Activity Bar -->
      <aside class="activity-bar">
        <div class="activity-group">
          <!-- Explorer (Active): codicon "files", two stacked pages -->
          <div class="activity-icon active">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <path d="M8.5 3.5h7l4 4v11a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z" />
              <path d="M15.5 3.5v4h4" />
              <path d="M6 7.5H5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9" />
            </svg>
          </div>
          <!-- Search -->
          <div class="activity-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="13.5" cy="10.5" r="6" />
              <path d="M9.3 14.7 4 20" stroke-linecap="round" />
            </svg>
          </div>
          <!-- Source Control -->
          <div class="activity-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="7" cy="6" r="2.2" />
              <circle cx="7" cy="18" r="2.2" />
              <circle cx="17" cy="9" r="2.2" />
              <path d="M7 8.2v7.6" />
              <path d="M17 11.2c0 3-2.5 3.6-5 4.1-2 .4-3.5 1-3.8 2.5" />
            </svg>
            <span class="badge">1</span>
          </div>
          <!-- Run & Debug: codicon "debug-alt", play with a bug -->
          <div class="activity-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <path d="M5.5 4.5v15l7.5-4.6V9.1z" />
              <path d="M13 12.5l6.5-4V19z" />
              <path d="M11 4.5 19 9.5" />
              <circle cx="17.5" cy="16.5" r="2.6" fill="#181818" />
              <path d="M17.5 13.9v-1.2M15.3 15l-1.2-.6M19.7 15l1.2-.6M15.3 18l-1.2.6M19.7 18l1.2.6M17.5 19.1v1.2" stroke-linecap="round" />
            </svg>
          </div>
          <!-- Extensions: three squares and one lifted away -->
          <div class="activity-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <rect x="4" y="10" width="5.5" height="5.5" />
              <rect x="9.5" y="15.5" width="5.5" height="5.5" />
              <rect x="4" y="15.5" width="5.5" height="5.5" />
              <rect x="13.5" y="3" width="6.5" height="6.5" />
            </svg>
          </div>
        </div>
        <div class="activity-group">
          <!-- Account -->
          <div class="activity-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="8.5" />
              <circle cx="12" cy="10" r="3" />
              <path d="M6.3 18.2c1.2-2.3 3.2-3.4 5.7-3.4s4.5 1.1 5.7 3.4" />
            </svg>
          </div>
          <!-- Manage (gear) -->
          <div class="activity-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <circle cx="12" cy="12" r="2.8" />
              <path d="M12 3.5l1.3 2.2 2.5-.6.7 2.5 2.5.7-.6 2.5 2.1 1.2-2.1 1.3.6 2.5-2.5.7-.7 2.5-2.5-.6L12 20.5l-1.3-2.1-2.5.6-.7-2.5-2.5-.7.6-2.5L3.5 12l2.1-1.2-.6-2.5 2.5-.7.7-2.5 2.5.6z" />
            </svg>
          </div>
        </div>
      </aside>

      <!-- Sidebar -->
      <div class="sidebar">
        <div class="sidebar-header">
          <span>Explorer</span>
          <span style="color:#858585;cursor:pointer;">&#x22EF;</span>
        </div>
        <div class="sidebar-project">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span>${escapeHtml(projectName.toUpperCase())}</span>
        </div>
        <div class="file-tree">
          ${treeNodes.join('')}
        </div>
      </div>

      <!-- Editor Pane -->
      <main class="editor-pane">
        <div class="tabs-bar">
          <div class="tabs-left">
            ${tabHeadersHtml}
          </div>
          <div class="tabs-right-actions">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 3h18v18H3z"/></svg>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
          </div>
        </div>

        ${tabBodiesHtml}
        ${terminalPanelHtml}
      </main>
    </div>

    <!-- Status Bar -->
    <footer class="statusbar">
      <div class="statusbar-left">
        <span class="statusbar-item" style="background:#1f8ad2;padding:0 6px;margin-left:-10px;height:100%;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg>
        </span>
        <span class="statusbar-item">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M18 15V9a9 9 0 0 0-9-9" />
            <path d="M6 9v12" />
          </svg>
          main*
        </span>
        <span class="statusbar-item">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          0&#x2193; 1&#x2191;
        </span>
        <span class="statusbar-item">&#x2297; 0 &nbsp;&#x26A0; 0</span>
      </div>
      <div class="statusbar-right">
        <span class="statusbar-item" id="statusbar-pos">Ln ${openStatus.line}, Col 1</span>
        <span class="statusbar-item">Spaces: 2</span>
        <span class="statusbar-item">UTF-8</span>
        <span class="statusbar-item" id="statusbar-lang">${openStatus.lang}</span>
        <span class="statusbar-item">Prettier &#x2713;</span>
        <span class="statusbar-item">&#x1F514;</span>
      </div>
    </footer>
  </div>

  <script>
    var IDE_TAB_STATUS = ${tabStatusJson};

    // Paints the selection over lines from..to of view idx, the way a drag
    // would: called once per line as the cursor passes it.
    window.selectIdeLines = function(idx, from, to) {
      var view = document.getElementById('ide-view-' + idx);
      if (!view) return;
      var rows = view.querySelectorAll('.code-line[data-line]');
      for (var i = 0; i < rows.length; i++) {
        var n = Number(rows[i].getAttribute('data-line'));
        var on = n >= from && n <= to;
        rows[i].classList.toggle('highlighted', on);
        var num = rows[i].querySelector('.line-num');
        var txt = rows[i].querySelector('.line-content');
        if (num) num.classList.toggle('highlighted', on);
        if (txt) txt.classList.toggle('highlighted', on);
      }
    };
    window.switchIdeTab = function(idx) {
      var tabs = document.querySelectorAll('.tab');
      var views = document.querySelectorAll('.editor-body-view');
      for (var i = 0; i < tabs.length; i++) {
        if (i === idx) {
          tabs[i].classList.add('active');
          tabs[i].style.background = '#1f1f1f';
          tabs[i].style.borderTop = '1px solid #0078d4';
          tabs[i].style.color = '#ffffff';
        } else {
          tabs[i].classList.remove('active');
          tabs[i].style.background = '#181818';
          tabs[i].style.borderTop = '1px solid transparent';
          tabs[i].style.color = '#9d9d9d';
        }
        if (views[i]) views[i].style.display = i === idx ? 'flex' : 'none';
      }
      var fileNodes = document.querySelectorAll('.tree-node.file-node');
      // (terminal API is defined below)
      for (var j = 0; j < fileNodes.length; j++) {
        if (fileNodes[j].getAttribute('data-tab-idx') === String(idx)) {
          fileNodes[j].classList.add('active-file');
        } else {
          fileNodes[j].classList.remove('active-file');
        }
      }

      var status = IDE_TAB_STATUS[idx];
      if (status) {
        var langEl = document.getElementById('statusbar-lang');
        if (langEl) langEl.textContent = status.lang;
        var posEl = document.getElementById('statusbar-pos');
        if (posEl) posEl.textContent = 'Ln ' + status.line + ', Col 1';
      }
    };

    /**
     * The integrated terminal.
     *
     * Content is rendered with the document: it is a captured session, so
     * there is nothing to animate. The recorder only reveals the panel and
     * moves between sessions, the way someone alt-tabbing between two running
     * dev servers would.
     */
    window.ideShowTerminal = function() {
      var panel = document.getElementById('ide-terminal-panel');
      if (panel) panel.style.display = 'flex';
      var views = document.querySelectorAll('.terminal-views');
      for (var v = 0; v < views.length; v++) views[v].scrollTop = 0;
    };

    window.ideSwitchTerminal = function(idx) {
      var bodies = document.querySelectorAll('.term-body');
      var tabs = document.querySelectorAll('.term-session');
      for (var i = 0; i < bodies.length; i++) {
        bodies[i].style.display = i === idx ? 'block' : 'none';
      }
      for (var j = 0; j < tabs.length; j++) {
        if (j === idx) tabs[j].classList.add('active');
        else tabs[j].classList.remove('active');
      }
    };
  </script>
</body>
</html>`;
}



