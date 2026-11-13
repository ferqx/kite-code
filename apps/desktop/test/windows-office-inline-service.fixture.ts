import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  createRuntime,
  prepareOutputDirectory,
  prepareOutputStaging,
  withOutputCollection,
} from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createConfigurationSnapshot } from '@kite-ai/agent/config';
import {
  officeShellEnvironment,
  runOfficeCLI,
  verifyOfficeRuntimeAssets,
} from '@kite-ai/agent/documents';
import type { JobDefinition, Json } from '@kite-ai/agent/extensions';
import { createWorkingInputFiles } from '@kite-ai/agent/files';
import { stageWindowsGitBash, withBundledRipgrep } from '@kite-ai/agent/jobs/shell';
import type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { createShellExtension } from '@kite-ai/agent/shell';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { AgentClient } from '@kite-ai/client';
import { launchIdentityAsync } from '../../../packages/agent/src/jobs/launch-identity';
import { privateDirectory } from '../../../packages/agent/src/platform/windows-path-security';
import { shellRiskInstructions } from '../../../packages/agent/src/shell-risk-review';
import { startService } from '../../service/src';
import { createDefaultProcessConfiguration } from '../../service/src/configuration';
import { runModelProtocol } from '../../service/src/session-model-protocol';
import type { OfficeEditContext } from '../src/output-files-bridge';

type FixtureProviderBody = {
  tools?: { function?: { name?: string } }[];
  messages?: { role: string; content: unknown }[];
};
const wordPageSourceHash = 'cd838d2fb88e12eb561e853f6d090d0556348057c9e11b39ba2bb752e5f8f1b0';
const wordPageTexts = [
  '第一页标题：保留原始内容。',
  '第一页保留段：编号 ONE-UNCHANGED。',
  '第二预览页目标：请仅替换这一段。',
  '第二预览页保留段：预算 2400 元，编号 TWO-UNCHANGED。',
  '第三页标题：保留原始内容。',
  '第三页保留段：编号 THREE-UNCHANGED。',
];
const wordPageSelection = (layoutGeneration: number) => ({
  kind: 'word',
  scope: 'page',
  pageBasis: 'html-preview',
  page: 2,
  layoutGeneration,
  blocks: [
    { path: '/body/p[3]', text: wordPageTexts[2] },
    { path: '/body/p[4]', text: wordPageTexts[3] },
  ],
});
type FixtureCase = 'base' | 'range' | 'sheet' | 'ppt-page' | 'word-page';
function fixtureSelectionValid(
  scenario: FixtureCase,
  kind: string,
  selection: OfficeEditContext['selection'],
) {
  if (scenario === 'word-page')
    return (
      kind === 'word' &&
      selection?.kind === 'word' &&
      'scope' in selection &&
      selection.scope === 'page' &&
      Number.isSafeInteger(selection.layoutGeneration) &&
      selection.layoutGeneration > 0 &&
      isDeepStrictEqual(selection, wordPageSelection(selection.layoutGeneration))
    );
  if (scenario === 'sheet')
    return (
      kind === 'excel' &&
      isDeepStrictEqual(selection, { kind: 'excel', scope: 'sheet', sheet: '对照' })
    );
  if (scenario === 'range')
    return (
      kind === 'excel' &&
      isDeepStrictEqual(selection, {
        kind: 'excel',
        sheet: '预算',
        range: 'B2:B3',
        cells: [
          { path: '/预算/B2', address: 'B2', value: '1200' },
          { path: '/预算/B3', address: 'B3', value: '2400' },
        ],
      })
    );
  if (scenario === 'ppt-page') {
    if (
      kind !== 'powerpoint' ||
      selection?.kind !== 'powerpoint' ||
      selection.slide !== 2 ||
      selection.objectPath !== undefined
    )
      return false;
    const text = selection.text;
    return (
      isDeepStrictEqual(selection, {
        kind: 'powerpoint',
        slide: 2,
        ...(text === undefined ? {} : { text }),
      }) &&
      (text === undefined || text.trim() === '第二页 · 保留导航与请求修改')
    );
  }
  if (kind === 'word')
    return isDeepStrictEqual(selection, {
      kind: 'word',
      start: { path: '/body/p[1]', offset: 0 },
      end: { path: '/body/p[1]', offset: 24 },
      text: 'Windows 文档选区验证：请仅修改本段标题。',
    });
  if (kind === 'excel')
    return isDeepStrictEqual(selection, {
      kind: 'excel',
      sheet: '预算',
      range: 'B2',
      cells: [{ path: '/预算/B2', address: 'B2', value: '1200' }],
    });
  return (
    kind === 'powerpoint' &&
    isDeepStrictEqual(selection, {
      kind: 'powerpoint',
      slide: 1,
      objectPath: '/slide[1]/shape[@id=100000]',
      text: 'Windows 办公文件预览\n',
    })
  );
}
function fixtureRiskClassification(
  body: FixtureProviderBody,
  binding: { command: string; cwd: string },
) {
  if (
    body.tools?.length ||
    body.messages?.length !== 2 ||
    body.messages[0]?.role !== 'system' ||
    body.messages[0].content !== shellRiskInstructions ||
    body.messages[1]?.role !== 'user' ||
    typeof body.messages[1].content !== 'string'
  )
    throw Error('fixture_risk_envelope_mismatch');
  const input = JSON.parse(body.messages[1].content);
  if (
    input.purpose !== 'shell_risk' ||
    !isDeepStrictEqual(input.operation, {
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input: { command: binding.command },
      kind: 'tool',
    }) ||
    input.material?.command !== binding.command ||
    input.material.cwd !== binding.cwd ||
    !isDeepStrictEqual(input.material.scope, { filesystem: 'workspace_write', network: 'none' }) ||
    input.material.coverage?.environment !== 'host_sanitized'
  )
    throw Error('fixture_risk_binding_mismatch');
  // Exact-effect TEST classification, not evidence of a real risk model intelligence.
  // Production auto authorization applies its own ordinary-to-approve_once policy unchanged.
  return {
    risk: 'ordinary',
    reason:
      'Copies the bound synthetic local document, applies the fixed selected-field operations, and publishes a new local output without network access or source mutation.',
  };
}
// Pure expected-scope checks do not replace marker/DOM/CUA or real Service evidence.
if (process.argv.includes('--fixture-word-page-contract-check')) {
  const sourceHash = wordPageSourceHash;
  const blocks = wordPageSelection(17).blocks;
  const context = (generation: number) => ({
    sourceHash,
    selection: wordPageSelection(generation),
  });
  const valid = (value: unknown, observedGeneration: number, settled: boolean) =>
    settled &&
    Number.isSafeInteger(observedGeneration) &&
    observedGeneration > 0 &&
    isDeepStrictEqual(value, context(observedGeneration));
  const original = context(17);
  const cases: [unknown, number, boolean, boolean][] = [
    [original, 17, true, true],
    [original, 17, false, false],
    [original, 18, true, false],
    [original, 0, true, false],
    [original, 17.5, true, false],
    [{ ...original, sourceHash: 'forged' }, 17, true, false],
    [
      { ...original, selection: { ...original.selection, pageBasis: 'native-word' } },
      17,
      true,
      false,
    ],
    [{ ...original, selection: { ...original.selection, page: 1 } }, 17, true, false],
    [{ ...original, selection: { ...original.selection, blocks: [] } }, 17, true, false],
    [
      { ...original, selection: { ...original.selection, blocks: blocks.slice(0, 1) } },
      17,
      true,
      false,
    ],
    [
      { ...original, selection: { ...original.selection, blocks: [...blocks].reverse() } },
      17,
      true,
      false,
    ],
    [
      { ...original, selection: { ...original.selection, blocks: [blocks[0], blocks[0]] } },
      17,
      true,
      false,
    ],
    [
      {
        ...original,
        selection: {
          ...original.selection,
          blocks: [{ ...blocks[0], path: '/body/p[5]' }, blocks[1]],
        },
      },
      17,
      true,
      false,
    ],
    [
      {
        ...original,
        selection: { ...original.selection, blocks: [{ ...blocks[0], text: 'forged' }, blocks[1]] },
      },
      17,
      true,
      false,
    ],
    [
      { ...original, selection: { ...original.selection, extra: 'not permitted' } },
      17,
      true,
      false,
    ],
  ];
  for (const [value, generation, settled, expected] of cases)
    if (valid(value, generation, settled) !== expected)
      throw Error('fixture_word_page_contract_failed');
  const providerCases: [string, unknown, boolean][] = [
    ['word', original.selection, true],
    ['excel', original.selection, false],
    ['word', { ...original.selection, layoutGeneration: 0 }, false],
    ['word', { ...original.selection, page: 1 }, false],
    ['word', { ...original.selection, blocks: [] }, false],
    ['word', { ...original.selection, blocks: [blocks[0], blocks[0]] }, false],
  ];
  for (const [kind, selection, expected] of providerCases)
    if (
      fixtureSelectionValid('word-page', kind, selection as OfficeEditContext['selection']) !==
      expected
    )
      throw Error('fixture_word_provider_scope_contract_failed');
  console.log(
    `Word preview-page scope: ${cases.length + providerCases.length} pure checks passed; no rendered-page or business qualification`,
  );
  process.exit(0);
}
if (process.argv.includes('--fixture-selection-contract-check')) {
  const range = {
    kind: 'excel',
    sheet: '预算',
    range: 'B2:B3',
    cells: [
      { path: '/预算/B2', address: 'B2', value: '1200' },
      { path: '/预算/B3', address: 'B3', value: '2400' },
    ],
  };
  const cases: [FixtureCase, string, unknown, boolean][] = [
    ['range', 'excel', range, true],
    ['range', 'word', range, false],
    ['range', 'excel', { ...range, sheet: '对照' }, false],
    ['range', 'excel', { ...range, range: 'B3:B2' }, false],
    ['range', 'excel', { ...range, cells: [...range.cells].reverse() }, false],
    ['range', 'excel', { ...range, cells: range.cells.slice(0, 1) }, false],
    ['range', 'excel', { ...range, cells: [...range.cells, range.cells[0]] }, false],
    [
      'range',
      'excel',
      { ...range, cells: [{ ...range.cells[0], value: 'changed' }, range.cells[1]] },
      false,
    ],
    [
      'range',
      'excel',
      { ...range, cells: [{ ...range.cells[0], path: '/对照/B2' }, range.cells[1]] },
      false,
    ],
    ['sheet', 'excel', { kind: 'excel', scope: 'sheet', sheet: '对照' }, true],
    ['sheet', 'excel', { kind: 'excel', scope: 'sheet', sheet: '预算' }, false],
    ['sheet', 'excel', { kind: 'excel', scope: 'sheet', sheet: '对照', cells: [] }, false],
    ['sheet', 'excel', range, false],
    ['ppt-page', 'powerpoint', { kind: 'powerpoint', slide: 2 }, true],
    [
      'ppt-page',
      'powerpoint',
      { kind: 'powerpoint', slide: 2, text: '第二页 · 保留导航与请求修改\n' },
      true,
    ],
    ['ppt-page', 'powerpoint', { kind: 'powerpoint', slide: 1 }, false],
    ['ppt-page', 'powerpoint', { kind: 'powerpoint', slide: 2, objectPath: '/slide[2]' }, false],
    ['ppt-page', 'powerpoint', { kind: 'powerpoint', slide: 2, text: 'forged' }, false],
    ['base', 'excel', { kind: 'excel', sheet: '预算', range: 'B2', cells: [range.cells[0]] }, true],
    ['base', 'excel', range, false],
    [
      'base',
      'word',
      {
        kind: 'word',
        start: { path: '/body/p[1]', offset: 0 },
        end: { path: '/body/p[1]', offset: 24 },
        text: 'Windows 文档选区验证：请仅修改本段标题。',
      },
      true,
    ],
    [
      'base',
      'powerpoint',
      {
        kind: 'powerpoint',
        slide: 1,
        objectPath: '/slide[1]/shape[@id=100000]',
        text: 'Windows 办公文件预览\n',
      },
      true,
    ],
  ];
  for (const [scenario, kind, selection, expected] of cases)
    if (
      fixtureSelectionValid(scenario, kind, selection as OfficeEditContext['selection']) !==
      expected
    )
      throw Error(`fixture_selection_contract_failed:${scenario}:${JSON.stringify(selection)}`);
  console.log(
    `fixture selection contract: ${cases.length} checks passed; no service or tool execution`,
  );
  process.exit(0);
}
if (process.argv.includes('--fixture-risk-contract-check')) {
  const binding = { command: 'fixture exact command', cwd: 'fixture workspace' };
  const payload = {
    purpose: 'shell_risk',
    operation: {
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input: { command: binding.command },
      kind: 'tool',
    },
    material: {
      command: binding.command,
      cwd: binding.cwd,
      scope: { filesystem: 'workspace_write', network: 'none' },
      coverage: { environment: 'host_sanitized' },
    },
  };
  const body = {
    messages: [
      { role: 'system', content: shellRiskInstructions },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
  if (fixtureRiskClassification(body, binding).risk !== 'ordinary')
    throw Error('contract_classification_failed');
  for (const mutate of [
    (p: typeof payload) => {
      p.material.command = 'other';
    },
    (p: typeof payload) => {
      p.material.cwd = 'outside';
    },
    (p: typeof payload) => {
      p.material.scope.network = 'internet';
    },
    (p: typeof payload) => {
      p.operation.input.command = 'other';
    },
  ]) {
    const changed = structuredClone(payload);
    mutate(changed);
    let denied = false;
    try {
      fixtureRiskClassification(
        {
          ...body,
          messages: [body.messages[0]!, { role: 'user', content: JSON.stringify(changed) }],
        },
        binding,
      );
    } catch {
      denied = true;
    }
    if (!denied) throw Error('contract_scope_not_denied');
  }
  console.log(
    'fixture risk contract: 5 checks passed; no service, model request, or tool execution',
  );
  process.exit(0);
}
const parent = resolve(import.meta.dir, '../../../..');
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const root = resolve(argument('--fixture-root') ?? join(parent, 'inline-service-5'));
const allowedRoots = [
  'inline-service-5',
  'inline-edit-word-1',
  'inline-edit-word-2',
  'inline-edit-word-3',
  'inline-edit-word-5',
  'inline-edit-excel-4',
  'inline-edit-ppt-4',
  'inline-range-excel-1',
  'inline-sheet-excel-1',
  'inline-page-ppt-1',
  'inline-page-word-1',
  'inline-edit-ppt-5',
  'inline-style-excel-1',
  'inline-style-excel-2',
  'inline-style-excel-3',
  'inline-style-excel-4',
  'inline-style-excel-5',
  'inline-style-excel-6',
  'inline-style-excel-7',
  'inline-style-excel-8',
  'inline-style-excel-9',
  'inline-style-word-1',
  'inline-style-ppt-1',
  'inline-edit-word-4',
  'inline-edit-excel-3',
  'inline-edit-ppt-3',
  'inline-edit-excel-2',
  'inline-edit-ppt-2',
  'inline-edit-excel-1',
  'inline-edit-ppt-1',
  'inline-formats-word-1',
  'inline-formats-word-2',
  'inline-formats-excel-1',
  'inline-formats-ppt-1',
].map((name) => join(parent, name));
if (!allowedRoots.includes(root)) throw Error('fixture_root_denied');
const fixtureCase = basename(root).startsWith('inline-range-')
  ? 'range'
  : basename(root).startsWith('inline-sheet-')
    ? 'sheet'
    : basename(root) === 'inline-page-ppt-1'
      ? 'ppt-page'
      : basename(root) === 'inline-page-word-1'
        ? 'word-page'
        : 'base';
const editMode = fixtureCase !== 'base' || basename(root).startsWith('inline-edit-');
const readOnlyVisual = [
  'inline-style-excel-1',
  'inline-style-excel-2',
  'inline-style-excel-3',
  'inline-style-excel-4',
  'inline-style-excel-5',
  'inline-style-excel-6',
  'inline-style-excel-7',
  'inline-style-excel-8',
  'inline-style-excel-9',
  'inline-style-word-1',
  'inline-style-ppt-1',
].includes(basename(root));
const keyboardOnly = editMode || readOnlyVisual || basename(root).startsWith('inline-formats-');
if (keyboardOnly && !argument('--fixture-source')) throw Error('fixture_source_required');
if (existsSync(join(root, 'data', 'fixture', 'core.db')))
  throw Error('fixture_profile_already_exists');
const profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
const paths = resolveProfile(profile);
const source = resolve(
  argument('--fixture-source') ?? join(parent, 'visible-inline-1', 'Windows-preview.pptx'),
);
const allowedSources = [
  join(parent, 'visible-inline-1', 'Windows-preview.pptx'),
  join(parent, 'inline-formats-word-1', 'sources', 'Windows-selection.docx'),
  join(parent, 'inline-formats-word-2', 'sources', 'Windows-selection.docx'),
  join(parent, 'inline-formats-excel-1', 'sources', 'Windows-selection.xlsx'),
  join(parent, 'inline-selection-sources-1', 'Windows-ranges.xlsx'),
  join(parent, 'inline-word-page-sources-1', 'Windows-preview-pages.docx'),
  join(parent, 'xlsx-formula-evidence-1', 'workspace', 'Windows-formula-styles.xlsx'),
  ...([
    'inline-style-excel-4',
    'inline-style-excel-5',
    'inline-style-excel-6',
    'inline-style-excel-7',
    'inline-style-excel-8',
    'inline-style-excel-9',
  ].includes(basename(root))
    ? [join(parent, 'xlsx-border-evidence-1', 'workspace', 'Windows-border-variants.xlsx')]
    : []),
];
if (!allowedSources.includes(source)) throw Error('fixture_source_denied');
if (
  ((fixtureCase === 'range' || fixtureCase === 'sheet') &&
    source !== join(parent, 'inline-selection-sources-1', 'Windows-ranges.xlsx')) ||
  (fixtureCase === 'ppt-page' &&
    source !== join(parent, 'visible-inline-1', 'Windows-preview.pptx')) ||
  (fixtureCase === 'word-page' &&
    source !== join(parent, 'inline-word-page-sources-1', 'Windows-preview-pages.docx'))
)
  throw Error('fixture_case_source_mismatch');
const kind =
  extname(source) === '.docx' ? 'word' : extname(source) === '.xlsx' ? 'excel' : 'powerpoint';
const workspaceRoot = keyboardOnly ? join(root, 'workspace') : root;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceSha = hash(await readFile(source));
const visualSource =
  basename(root) === 'inline-style-word-1'
    ? {
        path: join(parent, 'inline-word-page-sources-1', 'Windows-preview-pages.docx'),
        sha: wordPageSourceHash,
      }
    : basename(root) === 'inline-style-ppt-1'
      ? {
          path: join(parent, 'visible-inline-1', 'Windows-preview.pptx'),
          sha: '2c387d4a4ec6932a33bf49c0a1c0797e0c37c23c4e74f4d623c2e0424c1a70fd',
        }
      : [
            'inline-style-excel-4',
            'inline-style-excel-5',
            'inline-style-excel-6',
            'inline-style-excel-7',
            'inline-style-excel-8',
            'inline-style-excel-9',
          ].includes(basename(root))
        ? {
            path: join(
              parent,
              'xlsx-border-evidence-1',
              'workspace',
              'Windows-border-variants.xlsx',
            ),
            sha: 'ab49848b7dd04b849b2edc80563445061eb75994730a686f37f86bf136695ebe',
          }
        : {
            path: join(
              parent,
              'xlsx-formula-evidence-1',
              'workspace',
              'Windows-formula-styles.xlsx',
            ),
            sha: 'c71670c56a7eece008e4b0db843d7bb2e08e4df2ed4813a9d89a920963007892',
          };
if (readOnlyVisual && (source !== visualSource.path || sourceSha !== visualSource.sha))
  throw Error('fixture_visual_source_mismatch');
if (fixtureCase === 'range' || fixtureCase === 'sheet') {
  const manifest = JSON.parse(await readFile(join(dirname(source), 'source-proof.json'), 'utf8'));
  if (
    manifest.kind !== 'synthetic-xlsx-selection-source' ||
    manifest.sourceSha !== sourceSha ||
    sourceSha !== '1c5cf8b7041916938cde1add639081a39ce58b68c2fc77831edf7c2535c6dba3' ||
    manifest.rows !== 1000 ||
    manifest.columns !== 8 ||
    !isDeepStrictEqual(manifest.sheets, ['预算', '对照']) ||
    manifest.validated !== true ||
    manifest.macros !== false ||
    manifest.externalLinks !== false
  )
    throw Error('fixture_synthetic_source_not_verified');
}
if (
  fixtureCase === 'ppt-page' &&
  sourceSha !== '2c387d4a4ec6932a33bf49c0a1c0797e0c37c23c4e74f4d623c2e0424c1a70fd'
)
  throw Error('fixture_ppt_source_changed');
if (fixtureCase === 'word-page') {
  const manifest = JSON.parse(await readFile(join(dirname(source), 'source-proof.json'), 'utf8'));
  if (
    sourceSha !== wordPageSourceHash ||
    manifest.sourceSha !== sourceSha ||
    manifest.kind !== 'synthetic-docx-preview-page-source' ||
    manifest.validated !== true ||
    manifest.macros !== false ||
    manifest.externalLinks !== false ||
    !isDeepStrictEqual(
      manifest.paragraphs,
      wordPageTexts.map((text, i) => ({
        domPath: `/body/p[${i + 1}]`,
        officePath: `/body/p[@paraId=3000000${i + 1}]`,
        text,
        pageBreakBefore: i === 2 || i === 4,
      })),
    )
  )
    throw Error('fixture_word_page_source_not_verified');
}
privateDirectory(root);
privateDirectory(profile.dataRoot);
privateDirectory(paths.profilePath);
privateDirectory(workspaceRoot);
let store = await openSqliteStore(profile);
let runtime: ReturnType<typeof createRuntime>;
const job: JobDefinition = {
  id: 'shell.command',
  version: '1',
  description: 'Copy fixed synthetic source only',
  inputSchema: { type: 'object' },
  async start(_input, context) {
    const directory = await mkdtemp(join(root, 'producer-'));
    const allocation = await runtime.prepareOutputCollection(
      context,
      await launchIdentityAsync(directory),
    );
    await copyFile(source, join(allocation.env.KITE_OUTPUT_DIR!, basename(source)));
    return { reference: {} };
  },
  async *observe() {
    yield {
      type: 'terminal' as const,
      supervision: 'ended' as const,
      result: {
        outcome: 'succeeded' as const,
        content: 'copied',
        details: { exitCode: 0, processTreeStopped: true },
      },
    };
  },
  async cancel() {
    return { status: 'unknown' as const };
  },
  async dispose() {},
};
const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const seedModel = createFixedModel([
  [
    {
      type: 'tool_call',
      name: 'shell_execute',
      id: 'seed',
      arguments: JSON.stringify({ command: 'fixed synthetic copy' }),
    },
    { ...finish, reason: 'tool_calls' },
  ],
  [{ type: 'text_delta', text: 'Synthetic Office source ready' }, finish],
]);
// This synthetic seed host declares its protocol before allocation, not by editing history.
const seedSnapshot = createConfigurationSnapshot({
  models: [{ id: 'seed', provider: 'compatible', model: 'synthetic-seed' }],
}) as unknown as Json;
runtime = createRuntime({
  store,
  modelId: 'seed',
  model: seedModel,
  async resolveRunConfiguration() {
    return { model: seedModel, modelId: 'seed', snapshot: seedSnapshot };
  },
  artifacts: createArtifactStore({ store, profile }),
  workingInputFiles: createWorkingInputFiles(),
  outputCollections: {
    prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
  },
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'seed-only' };
    },
  },
  extensions: [
    createShellExtension({ job }),
    withOutputCollection({ id: 'builtin.files', version: '1', apiMajor: 1 }, () => runtime),
  ],
});
const serviceProfile = {
  dataRoot: profile.dataRoot,
  name: profile.profile,
  accessKey: paths.profileAccessKey,
};
let service = await startService({
  runtime,
  profile: serviceProfile,
  buildId: 'fixture',
  subjectId: 'owner',
});
const client = new AgentClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  expected: {
    profile: serviceProfile,
    apiMajor: 1,
    requiredCapabilities: ['commands', 'output_files'],
  },
});
await client.connect();
const { storeId } = await store.getMetadata();
await runtime.createWorkspace({
  expectedStoreId: storeId,
  id: 'w',
  name: 'Synthetic Office',
  rootUri: pathToFileURL(workspaceRoot).href,
});
await runtime.createSession({
  expectedStoreId: storeId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'create-session',
  workspaceId: 'w',
  title: 'Office inline verification',
});
await client.startRun('s', {
  expectedStoreId: storeId,
  commandId: 'seed',
  kind: 'run.start',
  content: 'Create synthetic Office source',
});
await runtime.waitForCommand('seed', { timeoutMs: 30000 });
let page = await client.queryOutputFiles({ scope: { storeId, sessionId: 's' } });
for (let i = 0; i < 500 && !page.items.length; i++) {
  await Bun.sleep(50);
  page = await client.queryOutputFiles({ scope: { storeId, sessionId: 's' } });
}
if (page.items.length !== 1) throw Error('seed_delivery_missing');
const first = await runtime.readFirstSessionRun({ expectedStoreId: storeId, sessionId: 's' });
if (!first.run || runModelProtocol(first.run) !== 'chat-completions') {
  throw Error('seed_protocol_manifest_invalid');
}
const target = page.items[0]!;
client.disposeNetwork();
await service.close();

const editPlan =
  fixtureCase === 'word-page'
    ? {
        prompt: '请将第二预览页目标段落改为 Windows 预览页修改验证完成，并保留其他段落和分页。',
        path: '/body/p[@paraId=30000003]',
        props: { text: 'Windows 预览页修改验证完成' },
        invariantPath: '/body/p[@paraId=30000004]',
        invariant: wordPageTexts[3]!,
        expected: 'Windows 预览页修改验证完成',
      }
    : fixtureCase === 'range'
      ? {
          prompt: '请将预算表 B2:B3 分别改为 1500、2700，并保留其他单元格。',
          path: '/预算/B2',
          props: { value: '1500' },
          invariantPath: '/预算/A2',
          invariant: '差旅',
          expected: '1500',
        }
      : fixtureCase === 'sheet'
        ? {
            prompt: '请将对照工作表 B2 改为 800，并保留其他工作表和单元格。',
            path: '/对照/B2',
            props: { value: '800' },
            invariantPath: '/预算/B2',
            invariant: '1200',
            expected: '800',
          }
        : fixtureCase === 'ppt-page'
          ? {
              prompt: '请将第二页标题改为 Windows 页面修改验证完成，并保留其他页面和备注。',
              path: '/slide[2]/shape[@id=100001]',
              props: { text: 'Windows 页面修改验证完成' },
              invariantPath: '/slide[1]',
              invariant: 'Windows 办公文件预览',
              expected: 'Windows 页面修改验证完成',
            }
          : kind === 'word'
            ? {
                prompt: '请将选中段落改为 Windows 文档编辑验证完成，并保留其他内容。',
                path: '/body/p[@paraId=00100000]',
                props: { text: 'Windows 文档编辑验证完成' },
                invariantPath: '/body/p[@paraId=00100002]',
                invariant: '第二段保留内容：预算 1200 元，数量 24 件，日期 2026-11-12。',
                expected: 'Windows 文档编辑验证完成',
              }
            : kind === 'excel'
              ? {
                  prompt: '请将预算表 B2 改为 1500，并保留其他单元格。',
                  path: '/预算/B2',
                  props: { value: '1500' },
                  invariantPath: '/预算/B3',
                  invariant: '2400',
                  expected: '1500',
                }
              : {
                  prompt: '请将选中标题改为 Windows 演示编辑验证完成，并保留其他内容。',
                  path: '/slide[1]/shape[@id=100000]',
                  props: { text: 'Windows 演示编辑验证完成' },
                  invariantPath: '/slide[2]',
                  invariant: '第二页',
                  expected: 'Windows 演示编辑验证完成',
                };
const editOperations = [
  { command: 'set', path: editPlan.path, props: editPlan.props },
  ...(fixtureCase === 'range'
    ? [{ command: 'set', path: '/预算/B3', props: { value: '2700' } }]
    : []),
];
const outputName = `edited${extname(source)}`;
let editCommandId: string | undefined;
let toolCallIssued = false;
const verifiedEditAssets = new Map<string, string>();
let issuedEdit:
  | { command: string; cwd: string; workingPath: string; sourceHash: string; commandId: string }
  | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
async function editDelta(body: { tools?: { function?: { name?: string } }[] }) {
  const users = (await store.listMessages('s')).filter(
    (m) => m.role === 'user' && m.originCommandId !== 'seed',
  );
  if (users.length !== 1 || !users[0]?.originCommandId) throw Error('edit_user_command_not_unique');
  const user = users[0];
  const originalPrompt = user.content.slice(0, user.content.indexOf('\n\n'));
  if (originalPrompt !== editPlan.prompt) throw Error('edit_prompt_outside_fixture');
  const contexts = JSON.parse(
    user.content.slice(user.content.lastIndexOf('\n') + 1),
  ) as (OfficeEditContext & { name: string; target: { fileId: string } })[];
  const selected = contexts[0];
  if (
    contexts.length !== 1 ||
    selected?.sourceHash !== sourceSha ||
    selected.name !== target.name ||
    !isDeepStrictEqual(selected.target, {
      storeId: target.storeId,
      sessionId: target.sessionId,
      fileId: target.fileId,
      locator: target.locator,
    })
  )
    throw Error('edit_source_context_mismatch');
  const selection = selected.selection;
  const selectionValid = fixtureSelectionValid(fixtureCase, kind, selection);
  if (!selectionValid) throw Error('edit_selection_outside_fixture');
  if (editCommandId && editCommandId !== user.originCommandId)
    throw Error('edit_second_submit_denied');
  editCommandId = user.originCommandId;
  if (toolCallIssued) {
    const jobs = (await store.listExecutions('s')).filter(
      (e) => e.rootWorkCommandId === editCommandId && e.definitionId === 'shell.command',
    );
    if (
      jobs.length !== 1 ||
      jobs[0]?.status !== 'succeeded' ||
      !jobs[0].result ||
      typeof jobs[0].result !== 'object' ||
      Array.isArray(jobs[0].result) ||
      jobs[0].result.outcome !== 'succeeded'
    )
      return {
        delta: {
          content:
            'LOCAL_FIXTURE_TOOL_STOPPED: The edit did not complete. Inspect the original tool result; no retry was issued.',
        },
        finish: 'stop',
      };
    return {
      delta: { content: 'LOCAL_PROVIDER_RECEIVED_INLINE_REQUEST; EDITED_OUTPUT_DELIVERED' },
      finish: 'stop',
    };
  }
  if (!body.tools?.some((t) => t.function?.name === 'shell_execute'))
    throw Error('production_shell_tool_missing');
  const file = user.files?.[0];
  if (user.files?.length !== 1 || file?.reference?.hash !== sourceSha)
    throw Error('edit_input_binding_missing');
  const working = await store.getWorkingInput({
    expectedStoreId: storeId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: editCommandId!,
    importId: file.reference.id.slice('input-file-'.length),
  });
  if (working?.state !== 'bound' || !working.workingRelativePath.startsWith('.kite-inputs/'))
    throw Error('edit_working_input_missing');
  const sourcePath = resolve(workspaceRoot, working.workingRelativePath);
  if (
    !sourcePath.startsWith(`${workspaceRoot}\\`) ||
    hash(await readFile(sourcePath)) !== sourceSha
  )
    throw Error('edit_working_source_mismatch');
  const operations = JSON.stringify(editOperations);
  const command = `set -e; printf %s ${quote(operations)} | "$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" office --source ${quote(sourcePath)} --input - --out "$KITE_OUTPUT_DIR/${outputName}"`;
  issuedEdit = {
    command,
    cwd: workspaceRoot,
    workingPath: sourcePath,
    sourceHash: sourceSha,
    commandId: editCommandId!,
  };
  toolCallIssued = true;
  await writeFile(
    join(root, 'provider-tool-command.json'),
    JSON.stringify({ commandId: editCommandId, command, context: selected }, null, 2),
  );
  return {
    delta: {
      tool_calls: [
        {
          index: 0,
          id: 'office-edit-tool',
          type: 'function',
          function: { name: 'shell_execute', arguments: JSON.stringify({ command }) },
        },
      ],
    },
    finish: 'tool_calls',
  };
}
const requests: unknown[] = [];
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions')
      return new Response('Not found', { status: 404 });
    const body = await request.json();
    requests.push(body);
    await writeFile(join(root, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    const frame = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'inline-local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    let response: { delta: unknown; finish: string };
    try {
      const riskRequest = body.messages?.some(
        (m: { role: string; content: unknown }) =>
          m.role === 'system' && m.content === shellRiskInstructions,
      );
      if (editMode && riskRequest) {
        if (
          !issuedEdit ||
          issuedEdit.commandId !== editCommandId ||
          issuedEdit.sourceHash !== sourceSha ||
          hash(await readFile(issuedEdit.workingPath)) !== sourceSha ||
          hash(await readFile(source)) !== sourceSha
        )
          throw Error('fixture_risk_source_mismatch');
        if (verifiedEditAssets.size !== 5) throw Error('fixture_risk_assets_missing');
        for (const [asset, digest] of verifiedEditAssets)
          if (hash(await readFile(asset)) !== digest) throw Error('fixture_risk_asset_changed');
        const classification = fixtureRiskClassification(body, issuedEdit);
        await writeFile(
          join(root, 'risk-classification.json'),
          JSON.stringify(
            {
              fixtureOnly: true,
              classification,
              assetHashes: Object.fromEntries(verifiedEditAssets),
              commandId: editCommandId,
              command: issuedEdit.command,
              cwd: workspaceRoot,
              scope: { filesystem: 'workspace_write', network: 'none' },
              sourceSha,
            },
            null,
            2,
          ),
        );
        response = { delta: { content: JSON.stringify(classification) }, finish: 'stop' };
      } else
        response = editMode
          ? await editDelta(body)
          : { delta: { content: 'LOCAL_PROVIDER_RECEIVED_INLINE_REQUEST' }, finish: 'stop' };
    } catch (error) {
      await writeFile(
        join(root, 'provider-error.json'),
        JSON.stringify({ error: String(error), requestCount: requests.length }, null, 2),
      );
      response = {
        delta: {
          content: JSON.stringify({
            fixtureError: String(error),

            retryIssued: false,
          }),
        },
        finish: 'stop',
      };
    }
    return new Response(
      `${frame(response.delta, null) + frame({}, response.finish)}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
const configPath = join(root, 'config.jsonc');
await writeFile(
  configPath,
  JSON.stringify({
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    modelId: 'local',
  }),
);
store = await openSqliteStore(profile);
let shell: ShellConfigurationOptions | undefined;
if (editMode) {
  const built = join(parent, 'repo/packages/agent/dist/platform/process/windows-shell');
  const manifest = JSON.parse(await readFile(join(built, 'manifest.json'), 'utf8'));
  if (
    manifest.protocol !== 7 ||
    manifest.runtime !== 'windows-restricted-token' ||
    Object.keys(manifest.files).sort().join(',') !== 'kite-windows-runner.exe,ktipc.dll'
  )
    throw Error('shell_manifest_invalid');
  for (const [name, digest] of Object.entries(manifest.files))
    if (hash(await readFile(join(built, name))) !== digest)
      throw Error('shell_manifest_hash_mismatch');
  const office = await verifyOfficeRuntimeAssets();
  if (
    hash(await readFile(office.helper)) !==
    (await readFile(office.helper.replace(/\.js$/, '.sha256'), 'utf8')).trim()
  )
    throw Error('documents_helper_hash_mismatch');
  for (const asset of [
    join(built, 'manifest.json'),
    join(built, 'kite-windows-runner.exe'),
    join(built, 'ktipc.dll'),
    office.helper,
    office.officecli,
  ])
    verifiedEditAssets.set(asset, hash(await readFile(asset)));
  const staged = await stageWindowsGitBash(
    join(paths.profilePath, 'windows-sandbox'),
    join(built, 'ktipc.dll'),
  );
  const env = withBundledRipgrep(
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  ).env;
  shell = {
    platform: 'win32',
    configurationId: 'default.windows-host-shell-v1',
    env: { ...env, ...officeShellEnvironment() },
    supervisorPath: join(built, 'kite-windows-runner.exe'),
    bunExecutable: process.execPath,
    shellExecutable: staged.shell,
    windows: {
      fullShellExecutable: staged.fullShell,
      stateRoot: staged.stateRoot,
    },
    host: {
      controlBase: paths.coordinationPath,
      temporaryRoot: prepareOutputStaging(join(paths.coordinationPath, 'shell-staging')),
      trustedExecutables: [office.officecli],
      protectedRoots: [],
      readonlyAssets: [],
      runtimeReadOnlyRoots: [dirname(office.helper)],
    },
  };
}
const {
  configurationManagement,
  permissionManagement,
  diagnosticSource,
  skillCatalogue,
  userMcpManagement,
  bindWorkspaceSerialLocks,
  ...configuration
} = createDefaultProcessConfiguration({
  profile: paths,
  userConfigurationPath: configPath,
  localCodex: false,
  browser: false,
  ...(editMode ? { ordinaryHostTools: true as const, shell } : {}),
});
const workspaceSerialLocks = createWorkspaceSerialLocks(paths);
bindWorkspaceSerialLocks?.(workspaceSerialLocks);
runtime = createRuntime({
  ...configuration,
  workspaceSerialLocks,
  permissions: configuration.permissions!,
  store,
  artifacts: createArtifactStore({ store, profile }),
  workingInputFiles: createWorkingInputFiles(),
  outputCollections: {
    prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
  },
});
service = await startService({
  runtime,
  profile: serviceProfile,
  buildId: 'fixture',
  subjectId: 'owner',
  configurationManagement: configurationManagement?.(runtime),
  permissionManagement: permissionManagement?.(runtime),
  diagnosticSource,
  skillCatalogue,
});
await writeFile(
  join(root, 'bootstrap.json'),
  JSON.stringify(
    {
      endpoint: service.endpoint,
      bootstrap: service.bootstrap,
      profile,
      profilePath: paths.profilePath,
      target,
      sourceSha,
      source,
      storeId,
      sessionId: 's',
      root,
      workspaceRoot,
      kind,
      keyboardOnly,
      editMode,
      fixtureCase,
      editOperations: editMode ? editOperations : undefined,
      editPlan: editMode ? editPlan : undefined,
      pid: process.pid,
    },
    null,
    2,
  ),
);
console.log(`READY ${join(root, 'bootstrap.json')}`);
// Local fixture control only: never execute command text or alter source bytes.
const receiptRunId = (command: Awaited<ReturnType<typeof store.getCommand>>) => {
  const receipt = command?.receipt;
  return receipt &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    typeof receipt.runId === 'string'
    ? receipt.runId
    : null;
};
let lastControl = '';
for (;;) {
  await Bun.sleep(200);
  let controlText: string;
  try {
    controlText = await readFile(join(root, 'command.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  if (controlText === lastControl) continue;
  lastControl = controlText;
  try {
    const control = JSON.parse(controlText) as {
      kind: string;
      commandId: string;
      sourceHash: string;
      prompt: string;
      expectedContext?: { sourceHash: string; selection: unknown };
    };
    if (control.kind === 'close') {
      await service.close();
      await workspaceSerialLocks.close();
      await provider.stop(true);
      await writeFile(
        join(root, 'closed.json'),
        JSON.stringify({ closed: true, providerRequestCount: requests.length, pid: process.pid }),
      );
      break;
    }
    if (
      control.kind !== 'verify' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(control.commandId) ||
      !control.prompt ||
      control.sourceHash !== sourceSha
    )
      throw Error('invalid_verification_request');
    let command = await store.getCommand(control.commandId);
    let run = receiptRunId(command) ? await store.getRun(receiptRunId(command)!) : null;
    for (let i = 0; i < 150 && (!run || run.isActive); i++) {
      await Bun.sleep(200);
      command = await store.getCommand(control.commandId);
      run = receiptRunId(command) ? await store.getRun(receiptRunId(command)!) : null;
    }
    if (
      command?.status !== 'applied' ||
      command.sessionId !== 's' ||
      !run ||
      run.status !== 'completed' ||
      run.originCommandId !== command.id
    )
      throw Error('command_run_not_completed');
    const messages = await store.listMessages('s');
    const user = messages.find((m) => m.role === 'user' && m.originCommandId === command!.id);
    if (!user?.content.includes(control.prompt)) throw Error('user_prompt_missing');
    if (!keyboardOnly && control.prompt !== '请将选中标题精简为 Windows 预览，并保留原件。')
      throw Error('unexpected_fixture_prompt');
    // composeOfficeContext appends the actual selection JSON on its final line.
    const contextEvidence = JSON.parse(user.content.slice(user.content.lastIndexOf('\n') + 1));
    if (!Array.isArray(contextEvidence) || contextEvidence.length !== 1)
      throw Error('selection_context_missing');
    const selected = contextEvidence[0];
    if (
      selected.sourceHash !== sourceSha ||
      (keyboardOnly
        ? !control.expectedContext ||
          !isDeepStrictEqual(
            { sourceHash: selected.sourceHash, selection: selected.selection },
            control.expectedContext,
          )
        : selected.selection?.kind !== 'powerpoint' ||
          selected.selection.slide !== 1 ||
          selected.selection.objectPath !== '/slide[1]/shape[@id=100000]' ||
          selected.selection.text !== 'Windows 办公文件预览\n') ||
      selected.target?.fileId !== target.fileId ||
      selected.target.storeId !== storeId ||
      selected.target.sessionId !== 's'
    )
      throw Error('selection_context_mismatch');
    const files = user.files ?? [];
    if (files.length !== 1 || files[0]?.reference?.hash !== sourceSha)
      throw Error('input_source_mismatch');
    const input = files[0]!;
    const working = await store.getWorkingInput({
      expectedStoreId: storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: command.id,
      importId: input.reference!.id.slice('input-file-'.length),
    });
    if (working?.state !== 'bound') throw Error('working_input_not_bound');
    const workingPath = resolve(workspaceRoot, working.workingRelativePath);
    if (
      !workingPath.startsWith(`${workspaceRoot}\\`) ||
      !working.workingRelativePath.startsWith('.kite-inputs/')
    )
      throw Error('working_path_outside_fixture');
    const workingSha = hash(await readFile(workingPath));
    const finalSourceSha = hash(await readFile(source));
    if (workingSha !== sourceSha || finalSourceSha !== sourceSha)
      throw Error('source_hash_changed');
    const providerEvidence = requests.filter(
      (r) =>
        JSON.stringify(r).includes(control.prompt) && JSON.stringify(r).includes('.kite-inputs/'),
    );
    if (!editMode && (requests.length !== 1 || providerEvidence.length !== 1))
      throw Error('provider_request_not_unique');
    const providerMessages =
      (providerEvidence[0] as { messages?: { content?: unknown }[] }).messages ?? [];
    if (
      !providerMessages.some(
        (message) => typeof message.content === 'string' && message.content.includes(user.content),
      )
    )
      throw Error('provider_selection_context_missing');
    if (
      !messages.some(
        (m) =>
          m.runId === run!.id &&
          m.role === 'assistant' &&
          m.content.includes('LOCAL_PROVIDER_RECEIVED_INLINE_REQUEST'),
      )
    )
      throw Error('provider_reply_not_saved');
    let editEvidence: unknown;
    if (editMode) {
      if (editCommandId !== command.id || !toolCallIssued) throw Error('edit_command_mismatch');
      const users = messages.filter((m) => m.role === 'user' && m.originCommandId !== 'seed');
      if (users.length !== 1) throw Error('duplicate_user_submit');
      const executions = await store.listExecutions('s');
      const jobs = executions.filter(
        (e) => e.rootWorkCommandId === command.id && e.definitionId === 'shell.command',
      );
      if (jobs.length !== 1 || jobs[0]?.status !== 'succeeded')
        throw Error('edit_shell_not_succeeded');
      const observer = new AgentClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        expected: { profile: serviceProfile, apiMajor: 1, requiredCapabilities: ['output_files'] },
      });
      try {
        await observer.connect();
        let outputs = await observer.queryOutputFiles({ scope: { storeId, sessionId: 's' } });
        for (let i = 0; i < 150 && !outputs.items.some((file) => file.name === outputName); i++) {
          await Bun.sleep(200);
          outputs = await observer.queryOutputFiles({ scope: { storeId, sessionId: 's' } });
        }
        const edited = outputs.items.filter(
          (file) => file.name === outputName && file.ownerRunId === run.id,
        );
        if (edited.length !== 1) throw Error('edited_delivery_missing_or_duplicate');
        const resolved = await observer.resolveOutputFile(edited[0]!);
        const stream = await observer.readOutputFileStream(edited[0]!);
        const chunks: Uint8Array[] = [];
        try {
          for await (const chunk of stream.content) chunks.push(chunk);
        } finally {
          await stream.cancel();
        }
        const bytes = Buffer.concat(chunks);
        if (hash(bytes) !== resolved.reference.hash || hash(bytes) === sourceSha)
          throw Error('edited_delivery_hash_invalid');
        const verificationCopy = join(root, `verified-${outputName}`);
        await writeFile(verificationCopy, bytes);
        const targetRead = await runOfficeCLI({
          args: ['get', verificationCopy, editPlan.path, '--json'],
        });
        const invariantRead = await runOfficeCLI({
          args: ['get', verificationCopy, editPlan.invariantPath, '--json'],
        });
        if (
          targetRead.code !== 0 ||
          invariantRead.code !== 0 ||
          !targetRead.stdout.includes(editPlan.expected) ||
          !invariantRead.stdout.includes(editPlan.invariant)
        )
          throw Error('edited_content_readback_failed');
        const additionalReadbacks: unknown[] = [];
        if (fixtureCase === 'range') {
          const extra = await runOfficeCLI({
            args: ['get', verificationCopy, '/预算/B3', '--json'],
          });
          const parsed = JSON.parse(extra.stdout);
          if (
            extra.code !== 0 ||
            !parsed.data?.results?.some(
              (r: { path?: string; text?: string }) => r.path === '/预算/B3' && r.text === '2700',
            )
          )
            throw Error('edited_second_cell_readback_failed');
          additionalReadbacks.push(parsed);
        }
        let wordPageReadback: unknown;
        if (fixtureCase === 'word-page') {
          const bodyRead = await runOfficeCLI({
            args: ['get', verificationCopy, '/body', '--json'],
          });
          const body = JSON.parse(bodyRead.stdout).data?.results?.find(
            (r: { path?: string }) => r.path === '/body',
          );
          const expectedPaths = [
            ...wordPageTexts.map((_, i) => `/body/p[@paraId=3000000${i + 1}]`),
            '/body/sectPr[1]',
          ];
          if (
            bodyRead.code !== 0 ||
            body?.childCount !== 7 ||
            !isDeepStrictEqual(
              body.children?.map((r: { path?: string }) => r.path),
              expectedPaths,
            )
          )
            throw Error('edited_word_body_changed');
          const paragraphs: unknown[] = [];
          for (let i = 0; i < wordPageTexts.length; i++) {
            const path = `/body/p[@paraId=3000000${i + 1}]`;
            const read =
              i === 2
                ? targetRead
                : await runOfficeCLI({ args: ['get', verificationCopy, path, '--json'] });
            const parsed = JSON.parse(read.stdout);
            const item = parsed.data?.results?.find((r: { path?: string }) => r.path === path);
            if (
              read.code !== 0 ||
              !item ||
              item.text !== (i === 2 ? editPlan.expected : wordPageTexts[i]) ||
              (item.format?.pageBreakBefore === true) !== (i === 2 || i === 4)
            )
              throw Error('edited_word_paragraph_or_break_changed');
            paragraphs.push(parsed);
          }
          wordPageReadback = {
            body: JSON.parse(bodyRead.stdout),
            paragraphs,
            allOtherFivePreserved: true,
            pageBreakBeforePreserved: true,
          };
        }
        editEvidence = {
          wordPageReadback,
          operations: editOperations,
          additionalReadbacks,
          delivery: edited[0],
          hash: resolved.reference.hash,
          shellExecutionId: jobs[0].id,
          providerCalls: requests.length,
          targetReadback: JSON.parse(targetRead.stdout),
          invariantReadback: JSON.parse(invariantRead.stdout),
        };
      } finally {
        observer.disposeNetwork();
      }
    }
    await writeFile(
      join(root, 'proof.json'),
      JSON.stringify(
        {
          ok: true,
          commandId: command.id,
          commandStatus: command.status,
          runId: run.id,
          runStatus: run.status,
          providerRequestCount: providerEvidence.length,
          contextEvidence,
          editEvidence,
          working,
          workingSha,
          sourceSha: finalSourceSha,
          prompt: control.prompt,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      join(root, 'proof.json'),
      JSON.stringify({ ok: false, error: String(error) }, null, 2),
    );
  }
}
