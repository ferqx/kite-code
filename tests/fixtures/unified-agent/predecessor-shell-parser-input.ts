import { refinePredecessorWorkspaceDeclarations } from './predecessor-workspace-declarations';

const shellParserDeclarations =
  '    "tree-sitter-bash": "0.25.1",\n    "web-tree-sitter": "0.25.10",\n';
/** Exact new parser closure only; these are retained as bytes, never normalized JSON. */
function shellParserLockIncrement(original: string): string | undefined {
  const declarationAnchor = '        "turndown": "7.2.4",\n        "yaml": "2.9.0",\n';
  const additions: readonly [string, string][] = [
    [
      '    "node-releases": [',
      '    "node-addon-api": ["node-addon-api@8.9.2", "", {}, "sha512-VijLXbi3UACN69I0JVXJsX4tjACjNoQDgv2gTF6sx2wWEi8tkSg2eX8p5gSIFi8z2+DL3oHmY6OyKce38SDolg=="],\n\n    "node-gyp-build": ["node-gyp-build@4.8.4", "", { "bin": { "node-gyp-build": "bin.js", "node-gyp-build-optional": "optional.js", "node-gyp-build-test": "build-test.js" } }, "sha512-LA4ZjwlnUblHVgq0oBF3Jl/6h/Nvs5fzBLwdEF4nuxnFdsfajde4WfxtJr3CaiH+F6ewcIB/q4jQ4UzPyid+CQ=="],\n\n',
    ],
    [
      '    "trim-lines": [',
      '    "tree-sitter-bash": ["tree-sitter-bash@0.25.1", "", { "dependencies": { "node-addon-api": "^8.2.1", "node-gyp-build": "^4.8.2" }, "peerDependencies": { "tree-sitter": "^0.25.0" }, "optionalPeers": ["tree-sitter"] }, "sha512-7hMytuYIMoXOq24yRulgIxthE9YmggZIOHCyPTTuJcu6EU54tYD+4G39cUb28kxC6jMf/AbPfWGLQtgPTdh3xw=="],\n\n',
    ],
    [
      '    "webidl-conversions": [',
      '    "web-tree-sitter": ["web-tree-sitter@0.25.10", "", { "peerDependencies": { "@types/emscripten": "^1.40.0" }, "optionalPeers": ["@types/emscripten"] }, "sha512-Y09sF44/13XvgVKgO2cNDw5rGk6s26MgoZPXLESvMXeefBf7i6/73eFurre0IsTW6E14Y0ArIzhUMmjoc7xyzA=="],\n\n',
    ],
  ];
  if (
    original.split(declarationAnchor).length !== 2 ||
    original.includes('"web-tree-sitter"') ||
    original.includes('"tree-sitter-bash"')
  )
    return undefined;
  let expected = original.replace(
    declarationAnchor,
    '        "tree-sitter-bash": "0.25.1",\n' +
      '        "turndown": "7.2.4",\n' +
      '        "web-tree-sitter": "0.25.10",\n' +
      '        "yaml": "2.9.0",\n',
  );
  for (const [anchor, addition] of additions) {
    if (expected.split(anchor).length !== 2) return undefined;
    expected = expected.replace(anchor, addition + anchor);
  }
  return expected;
}

/** Exact Agent permissions exports/build entries and pinned parser owner only. */
export function matchPredecessorShellParserInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
): 'shell_parser_locked_dependency_increment' | undefined {
  current = refinePredecessorWorkspaceDeclarations(path, current)?.bytes ?? current;
  const original = Buffer.from(previous).toString('utf8');
  let expected: string | undefined;
  if (path === 'bun.lock') expected = shellParserLockIncrement(original);
  else if (path === 'packages/agent/package.json') {
    const exportAnchor = '    "./extensions": "./src/extensions/index.ts",\n',
      buildAnchor = ' ./src/extensions/index.ts ./src/storage/index.ts ',
      dependencyAnchor = '    "turndown": "7.2.4",\n';
    if (
      [exportAnchor, buildAnchor, dependencyAnchor].some(
        (anchor) => original.split(anchor).length !== 2,
      ) ||
      original.includes('"tree-sitter-bash"') ||
      original.includes('"web-tree-sitter"') ||
      original.includes('"./permissions"') ||
      original.includes('"./permissions/shell"')
    )
      return undefined;
    expected = original
      .replace(
        exportAnchor,
        exportAnchor +
          '    "./permissions": "./src/permissions/index.ts",\n' +
          '    "./permissions/shell": "./src/permissions/shell.ts",\n',
      )
      .replace(
        buildAnchor,
        ' ./src/extensions/index.ts ./src/permissions/index.ts ./src/permissions/shell.ts ./src/storage/index.ts ',
      )
      .replace(dependencyAnchor, dependencyAnchor + shellParserDeclarations);
  }
  return expected && Buffer.from(expected).equals(Buffer.from(current))
    ? 'shell_parser_locked_dependency_increment'
    : undefined;
}
