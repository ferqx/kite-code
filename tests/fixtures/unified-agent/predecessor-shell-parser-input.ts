const shellParserDeclarations =
  '    "tree-sitter-bash": "0.25.1",\n    "web-tree-sitter": "0.25.10",\n';
/** Exact new parser closure only; these are retained as bytes, never normalized JSON. */
function shellParserLockIncrement(original: string): string | undefined {
  const declarationAnchor = '        "hono": "4.13.12",\n        "zod": "4.3.6",\n';
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
    '        "hono": "4.13.12",\n' +
      shellParserDeclarations.replaceAll('    "', '        "') +
      '        "zod": "4.3.6",\n',
  );
  for (const [anchor, addition] of additions) {
    if (expected.split(anchor).length !== 2) return undefined;
    expected = expected.replace(anchor, addition + anchor);
  }
  return expected;
}

/** Only the pinned Service parser declarations and their four exact lock records may differ. */
export function matchPredecessorShellParserInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
): 'shell_parser_locked_dependency_increment' | undefined {
  const original = Buffer.from(previous).toString('utf8');
  let expected: string | undefined;
  if (path === 'bun.lock') expected = shellParserLockIncrement(original);
  else if (path === 'apps/service/package.json') {
    const anchor = '    "hono": "4.13.12",\n';
    if (
      original.split(anchor).length !== 2 ||
      original.includes('"tree-sitter-bash"') ||
      original.includes('"web-tree-sitter"')
    )
      return undefined;
    expected = original.replace(anchor, anchor + shellParserDeclarations);
  }
  return expected && Buffer.from(expected).equals(Buffer.from(current))
    ? 'shell_parser_locked_dependency_increment'
    : undefined;
}
