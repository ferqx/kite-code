/** Exact committed declaration increments; never normalize manifests or resolved lock packages. */
function replaceOnce(text: string, changes: readonly (readonly [string, string])[]) {
  for (const [current, previous] of changes) {
    if (text.split(current).length !== 2) return undefined;
    text = text.replace(current, previous);
  }
  return text;
}

function workspaceDeclaration(text: string, workspace: string, change: readonly [string, string]) {
  const anchor = `    "${workspace}": {\n`;
  if (text.split(anchor).length !== 2) return undefined;
  const start = text.indexOf(anchor),
    end = text.indexOf('\n    },\n', start);
  if (end < 0) return undefined;
  const previous = replaceOnce(text.slice(start, end), [change]);
  return previous === undefined ? undefined : text.slice(0, start) + previous + text.slice(end);
}

/** The original match label describes the preserved projection; this records its exact refinement. */
export function refinePredecessorWorkspaceDeclarations(path: string, current: Uint8Array) {
  const text = Buffer.from(current).toString('utf8');
  let projected: string | undefined;
  let kind:
    | 'context_estimate_declarations'
    | 'session_ui_declarations'
    | 'workspace_lock_declarations';
  if (path === 'packages/agent/package.json') {
    kind = 'context_estimate_declarations';
    // cf6b4946e: one export/build pair and a declaration for an already locked root dependency.
    projected = replaceOnce(text, [
      [
        '    "./windows-path-security": "./src/platform/windows-path-security.ts",\n    "./context-estimate": "./src/context-estimate.ts"\n',
        '    "./windows-path-security": "./src/platform/windows-path-security.ts"\n',
      ],
      [
        '"build": "bun build ./src/index.ts ./src/context-estimate.ts ./src/extensions/index.ts ',
        '"build": "bun build ./src/index.ts ./src/extensions/index.ts ',
      ],
      ['    "yaml": "2.9.0",\n    "gpt-tokenizer": "^3.4.0"\n', '    "yaml": "2.9.0"\n'],
    ]);
  } else if (path === 'packages/ui/package.json') {
    kind = 'session_ui_declarations';
    // cf6b4946e declared the existing scroll dependency; 21fd426d7 exported the pure parser.
    projected = replaceOnce(text, [
      [
        '    "./desktop": "./src/desktop/index.ts",\n    "./desktop/markdown": "./src/desktop/markdown-parser.ts",\n    "./desktop/style.css": "./src/desktop/style.css"\n',
        '    "./desktop": "./src/desktop/index.ts",\n    "./desktop/style.css": "./src/desktop/style.css"\n',
      ],
      [
        '    "ink": "^7.1.1",\n    "ink-scroll-list": "^0.4.1",\n    "string-width": "^8.2.0",\n',
        '    "ink": "^7.1.1",\n    "string-width": "^8.2.0",\n',
      ],
    ]);
  } else if (path === 'bun.lock') {
    kind = 'workspace_lock_declarations';
    projected = workspaceDeclaration(text, 'packages/agent', [
      '        "drizzle-orm": "0.44.7",\n        "gpt-tokenizer": "^3.4.0",\n        "jsdom": "29.1.1",\n',
      '        "drizzle-orm": "0.44.7",\n        "jsdom": "29.1.1",\n',
    ]);
    if (projected !== undefined)
      projected = workspaceDeclaration(projected, 'packages/ui', [
        '        "ink": "^7.1.1",\n        "ink-scroll-list": "^0.4.1",\n        "ink-syntax-highlight": "^2.0.2",\n',
        '        "ink": "^7.1.1",\n        "ink-syntax-highlight": "^2.0.2",\n',
      ]);
  } else return undefined;
  if (projected === undefined) return undefined;
  return {
    bytes: Buffer.from(projected),
    kind,
    commits: path === 'packages/ui/package.json' ? ['cf6b4946e', '21fd426d7'] : ['cf6b4946e'],
  };
}
