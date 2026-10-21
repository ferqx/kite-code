import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  matchReviewedPredecessorInput,
  type ReviewedPredecessorKind,
} from '../../fixtures/unified-agent/predecessor-reviewed-input';

const repository = resolve(import.meta.dir, '../../..');
const predecessors: Readonly<Record<ReviewedPredecessorKind, string>> = {
  compatible: '4a4c0e440b2098e5b4ec58c5831452773b39228f',
  terminal_legacy: 'a2b6441fde28d9c0f895a26e6a9d2471d2b1b242',
  windows_legacy: '837a2b8cde946d70d00920941a1a3e5e7c684f5d',
};
const paths = [
  'bun.lock',
  'package.json',
  'packages/ai/package.json',
  'packages/agent/package.json',
  'packages/ui/package.json',
  'apps/service/package.json',
];
const show = (commit: string, path: string) => {
  const result = Bun.spawnSync(['git', 'show', `${commit}:${path}`], { cwd: repository });
  if (result.exitCode !== 0) throw Error(`reviewed_fixture_blob_missing:${commit}:${path}`);
  return result.stdout;
};
const current = (path: string) => readFileSync(resolve(repository, path));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mutate = (bytes: Uint8Array) => {
  const changed = Buffer.from(bytes);
  changed[0] = changed[0]! ^ 1;
  return changed;
};

test('six reviewed raw pairs retain actual predecessor/current hashes and explicit non-identical provenance', () => {
  for (const [kind, commit] of Object.entries(predecessors)) {
    for (const path of paths) {
      const previous = show(commit, path),
        actual = current(path);
      const result = matchReviewedPredecessorInput(
        kind as ReviewedPredecessorKind,
        path,
        previous,
        actual,
      )!;
      expect(result).toBeDefined();
      expect(result.match).toBe('reviewed_locked_input_increment');
      expect(String(result.predecessorCommit)).toBe(commit);
      expect(result.reviewScope).toBe(
        path === 'bun.lock' ||
          path === 'packages/ui/package.json' ||
          path === 'packages/agent/package.json'
          ? 'approved_input_increments_2026_10_21'
          : path === 'package.json'
            ? 'approved_input_increments_2026_10_19'
            : 'approved_input_increments_2026_10_18',
      );
      expect(result.previousSha256).toBe(sha(previous));
      expect(result.currentSha256).toBe(sha(actual));
      expect(result.currentSha256).not.toBe(result.previousSha256);
      expect(result.commits).toContain('9ff6904a0f49213f06c483a08615ff69f099720a');
      if (path === 'bun.lock' || path === 'packages/ai/package.json')
        expect(result.commits).toContain('eeea65f5f2cc14f7fab76218cb9e9506ebbbc58e');
      if (path === 'packages/agent/package.json')
        expect(result.commits).toContain('bcf70ce843463194ab91ca3938b9fa1375cb22bc');
      if (path === 'bun.lock' || path === 'packages/ui/package.json')
        expect(result.commits).toContain('5dba8a6bd5fe348aef130f83694b0453e98833ea');
      if (path === 'packages/agent/package.json')
        expect(result.commits).toContain('044df65ff6bffadc4ae4087a0a866b823d9a87e6');
      expect(result.increments.length).toBeGreaterThan(0);
      if (path === 'package.json') {
        expect(result.increments).toContain('model_collaboration_live_script');
        expect(result.collaborationLiveScript).toBe(
          '    "test:model:collaboration:live": "bun run tests/e2e/live/model/collaboration.live.ts",\n',
        );
      }
    }
  }
});

test('each reviewed path rejects changed current bytes, changed previous bytes, unrelated prior and wrong path', () => {
  for (const [kind, commit] of Object.entries(predecessors)) {
    for (const path of paths) {
      const previous = show(commit, path),
        actual = current(path);
      for (const [oldBytes, newBytes] of [
        [mutate(previous), actual],
        [previous, mutate(actual)],
        [previous, Buffer.concat([actual, Buffer.from('\n')])],
        [actual, actual],
      ] as const)
        expect(
          matchReviewedPredecessorInput(kind as ReviewedPredecessorKind, path, oldBytes, newBytes),
        ).toBeUndefined();
      expect(
        matchReviewedPredecessorInput(
          kind as ReviewedPredecessorKind,
          'other/package.json',
          previous,
          actual,
        ),
      ).toBeUndefined();
    }
  }
});

test('context swaps reject different fixed predecessor blobs rather than admitting any reviewed old hash', () => {
  for (const path of ['bun.lock', 'packages/agent/package.json']) {
    for (const [kind, commit] of Object.entries(predecessors)) {
      for (const other of Object.values(predecessors)) {
        if (other === commit) continue;
        const expected = show(commit, path),
          swapped = show(other, path);
        // The guard can distinguish raw inputs; identical blobs carry no different byte identity.
        if (expected.equals(swapped)) continue;
        expect(
          matchReviewedPredecessorInput(
            kind as ReviewedPredecessorKind,
            path,
            swapped,
            current(path),
          ),
        ).toBeUndefined();
      }
    }
  }
});

test('exact resolved additions and old closure reject version, URL, dependency, integrity, missing and duplicate edits', () => {
  const path = 'bun.lock',
    previous = show(predecessors.compatible, path),
    text = current(path).toString('utf8');
  const lines = text.split('\n');
  const openai = lines.find((line) => line.startsWith('    "@ai-sdk/openai": ['))!;
  const utils = lines.find((line) =>
    line.startsWith('    "@ai-sdk/openai/@ai-sdk/provider-utils": ['),
  )!;
  expect(openai).toBeString();
  expect(utils).toBeString();
  const changes = [
    text.replace('openai@4.0.19', 'openai@4.0.20'),
    text.replace('provider-utils@5.0.12', 'provider-utils@5.0.13'),
    text.replace(openai, openai.replace('"",', '"https://unexpected.invalid/openai.tgz",')),
    text.replace(openai, openai.replace('"5.0.12"', '"5.0.13"')),
    text.replace(openai, openai.replace('sha512-Mp0', 'sha512-Xp0')),
    text.replace(utils, utils.replace('sha512-bbh', 'sha512-Xbh')),
    text.replace(`${openai}\n`, ''),
    text.replace(`${utils}\n`, ''),
    text.replace(openai, `${openai}\n${openai}`),
    text.replace(utils, `${utils}\n${utils}`),
    text.replace('provider-utils@5.0.7', 'provider-utils@5.0.8'),
    text.replace('lexical@0.52.0', 'lexical@0.52.1'),
  ];
  for (const changed of changes) {
    expect(changed).not.toBe(text);
    expect(
      matchReviewedPredecessorInput('compatible', path, previous, Buffer.from(changed)),
    ).toBeUndefined();
  }
});

test('exact live script and build/entry increments cannot be omitted, duplicated, renamed or extended', () => {
  const liveLine =
    '    "test:model:tools:live": "bun run tests/e2e/live/model/model-tools.live.ts",\n';
  const collaborationLine =
    '    "test:model:collaboration:live": "bun run tests/e2e/live/model/collaboration.live.ts",\n';
  const changes: Readonly<Record<string, readonly [string, string][]>> = {
    'package.json': [
      [liveLine, ''],
      [liveLine, liveLine + liveLine],
      ['model-tools.live.ts', 'other.live.ts'],
      [collaborationLine, ''],
      [collaborationLine, collaborationLine + collaborationLine],
      ['collaboration.live.ts', 'other.live.ts'],
      ['collaboration.live.ts"', 'collaboration.live.ts && echo injected"'],
      ['"postinstall": "bun run build:files-native"', '"postinstall": "echo skip"'],
    ],
    'packages/ai/package.json': [
      ['"4.0.19"', '"4.0.20"'],
      ['--target browser', '--target bun'],
    ],
    'packages/agent/package.json': [
      ['    "./session-title": "./src/business/session-title/index.ts"\n', ''],
      ['--target=bun', '--target=browser'],
      [' && bun src/skills/workflow-contract/build-assets.ts dist', ''],
      [
        'workflow-contract/build-assets.ts dist',
        'workflow-contract/build-assets.ts dist && echo injected',
      ],
    ],
    'packages/ui/package.json': [
      ['    "./tui/ink": "./src/tui/ink.ts"\n', ''],
      ['"react-dom": "^19"', '"react-dom": "^20"'],
      ['    "@lexical/code-core": "0.52.0",\n', ''],
      ['"lexical": "0.52.0"', '"lexical": "0.52.1"'],
    ],
    'apps/service/package.json': [
      ['--target=bun', '--target=browser'],
      ['--splitting ', ''],
    ],
  };
  for (const [path, edits] of Object.entries(changes)) {
    const previous = show(predecessors.compatible, path),
      text = current(path).toString('utf8');
    for (const [before, after] of edits) {
      const changed = text.replace(before, after);
      expect(changed).not.toBe(text);
      expect(
        matchReviewedPredecessorInput('compatible', path, previous, Buffer.from(changed)),
      ).toBeUndefined();
    }
  }
});

test('five unchanged inputs, SQL and unknown paths never receive a reviewed exception even when identical', () => {
  for (const path of [
    'packages/client/package.json',
    'apps/cli/package.json',
    'apps/desktop/package.json',
    'apps/web/package.json',
    'patches/ink-virtual-list@0.2.3.patch',
    'packages/agent/src/storage/migrations/0001-baseline.sql',
    'packages/agent/src/storage/migrations/0002-recovery-audit.sql',
  ]) {
    const bytes = current(path);
    expect(matchReviewedPredecessorInput('compatible', path, bytes, bytes)).toBeUndefined();
  }
  expect(
    matchReviewedPredecessorInput('compatible', '__proto__', Buffer.from('x'), Buffer.from('x')),
  ).toBeUndefined();
});
