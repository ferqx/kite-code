import { expect, test } from 'bun:test';
import type { AgentClient, InputFileReference } from '@kite-ai/client';
import { NativeInputFiles } from '../../electron/input-files';
import { decodeNativeRequest } from '../../electron/native-ipc';
import {
  browserDraftMatches,
  browserDraftProofText,
  composeBrowserDraft,
} from '../../src/browser-annotation-content';
import {
  isOfficeEditContext,
  type OutputDraftFile,
  officeSelectionLabel,
  outputDraftLabel,
  outputDraftUri,
  readOutputDraftFiles,
} from '../../src/output-files-bridge';

const target = {
  storeId: 'store',
  sessionId: 'session',
  fileId: 'file',
  locator: { kind: 'delivery' as const, key: 'delivery/exact' },
};
const hash = 'a'.repeat(64);
const file: OutputDraftFile = {
  id: 'chip',
  name: 'report.docx',
  target,
  context: {
    sourceHash: hash,
    selection: {
      kind: 'word',
      start: { path: '/body/p[2]', offset: 3 },
      end: { path: '/body/p[2]', offset: 9 },
      text: 'quoted',
    },
  },
};
test('selection context persists in exact draft proof and model projection without changing raw editor text', () => {
  const document = { content: 'Shorten this sentence.', outputFiles: [file] };
  const content = composeBrowserDraft(document);
  expect(content).toContain('Shorten this sentence.');
  expect(content).toContain(hash);
  expect(content).toContain('/body/p[2]');
  expect(content).toContain('quoted');
  expect(document.content).toBe('Shorten this sentence.');
  expect(browserDraftMatches(document, content)).toBe(true);
  expect(browserDraftMatches(document, document.content)).toBe(false);
  const changed = structuredClone(document);
  changed.outputFiles[0]!.context!.sourceHash = 'b'.repeat(64);
  expect(browserDraftProofText(changed)).not.toBe(browserDraftProofText(document));
  expect(readOutputDraftFiles(JSON.parse(JSON.stringify([file])))).toEqual([file]);
});
test('selection IPC rejects non-hash versions, extra capabilities, huge context, stale editor hash and arbitrary actions', () => {
  expect(isOfficeEditContext(file.context)).toBe(true);
  expect(
    decodeNativeRequest({
      method: 'input.files.fromOutput',
      generation: 1,
      id: 'chip',
      target,
      context: file.context,
    }),
  ).toMatchObject({ context: file.context });
  for (const context of [
    { ...file.context, sourceHash: '/etc/passwd' },
    { ...file.context, path: '/etc/passwd' },
    { ...file.context, editor: { editorId: 'editor', revision: 2, sourceHash: 'b'.repeat(64) } },
    { ...file.context, selection: { ...file.context!.selection, text: 'x'.repeat(16001) } },
  ])
    expect(() =>
      decodeNativeRequest({
        method: 'input.files.fromOutput',
        generation: 1,
        id: 'chip',
        target,
        context,
      }),
    ).toThrow();
  const base = {
    method: 'outputs.office.apply',
    generation: 1,
    target,
    editorId: hash,
    expectedRevision: 0,
  };
  expect(() => decodeNativeRequest({ ...base, action: { kind: 'addSlide' } })).toThrow();
  expect(() =>
    decodeNativeRequest({ method: 'outputs.office.open', generation: 1, target }),
  ).toThrow();
  for (const action of [
    {
      kind: 'image',
      slide: 1,
      placement: { x: 1, y: 1, width: 2, height: 2 },
      path: '/etc/passwd',
    },
    { kind: 'addSlide', command: 'shell' },
    { kind: 'notes', slide: 1, text: 'x'.repeat(16001) },
  ])
    expect(() => decodeNativeRequest({ ...base, action })).toThrow();
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.preview.control',
      generation: 1,
      previewId: 'p',
      control: { kind: 'eval', value: 'process.exit()' },
    }),
  ).toThrow();
});
test('editor attachment prepares lazily and binds stable revision identity without regenerating', async () => {
  const owner = new NativeInputFiles();
  let calls = 0;
  const reference = {
    name: 'deck.pptx',
    uri: 'input-file:revision',
    reference: {
      hash,
      size: '10',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  } as InputFileReference;
  const local = {
    identity: 'editor:3',
    async publish() {
      calls++;
      return reference;
    },
  };
  owner.fromOutput('chip', target, 'deck.pptx', local);
  expect(calls).toBe(0);
  expect(() =>
    owner.fromOutput('chip', target, 'deck.pptx', { ...local, identity: 'editor:4' }),
  ).toThrow();
  const client = {} as AgentClient;
  expect(await owner.publish(client, 'store', 'session', ['chip'])).toEqual([reference]);
  expect(await owner.publish(client, 'store', 'session', ['chip'])).toEqual([reference]);
  expect(calls).toBe(1);
  await owner.close();
});

test('same output has distinct restored chip identities for different selections and revisions', () => {
  const second = {
    ...file,
    id: 'chip-two',
    context: {
      ...file.context!,
      selection: {
        kind: 'excel' as const,
        sheet: 'Tasks',
        range: 'B2:C3',
        cells: ['B2', 'C2', 'B3', 'C3'].map((address) => ({
          address,
          path: `/Tasks/${address}`,
          value: '',
        })),
      },
    },
  };
  const restored = readOutputDraftFiles(JSON.parse(JSON.stringify([file, second])));
  expect(restored.map(outputDraftUri)).toEqual([outputDraftUri(file), outputDraftUri(second)]);
  expect(new Set(restored.map(outputDraftUri)).size).toBe(2);
  expect(outputDraftLabel(second)).toContain('Tasks!B2:C3');
  expect(outputDraftUri({ ...file, context: undefined })).toBe('output-file:file');
});

test('initial PPT view accepts only bounded page and zoom data', () => {
  const request = {
    method: 'outputs.office.preview',
    generation: 1,
    target,
    editorId: hash,
    revision: 3,
    previewId: 'view',
    bounds: { x: 0, y: 0, width: 600, height: 400 },
    initialSlide: 2,
    initialZoom: 1.25,
  };
  expect(decodeNativeRequest(request)).toMatchObject({ initialSlide: 2, initialZoom: 1.25 });
  for (const patch of [
    { initialSlide: 0 },
    { initialSlide: 1.5 },
    { initialSlide: 1001 },
    { initialZoom: 0 },
    { initialZoom: Infinity },
    { initialZoom: 'auto' },
    { initialControls: [] },
  ])
    expect(() => decodeNativeRequest({ ...request, ...patch })).toThrow();
});

test('scope labels and sheet requests preserve precise file and sheet context without invented cells', () => {
  const selection = { kind: 'excel' as const, scope: 'sheet' as const, sheet: '预算' };
  const context = { sourceHash: hash, selection };
  expect(isOfficeEditContext(context)).toBe(true);
  expect(officeSelectionLabel(selection)).toBe('工作表 预算');
  expect(officeSelectionLabel({ kind: 'powerpoint', slide: 3 })).toBe('第 3 页');
  expect(officeSelectionLabel(file.context!.selection!)).toBe('选中文字');
  const item = { ...file, context };
  expect(readOutputDraftFiles(JSON.parse(JSON.stringify([item])))).toEqual([item]);
  expect(
    decodeNativeRequest({
      method: 'input.files.fromOutput',
      generation: 1,
      id: 'scope',
      target,
      context,
    }),
  ).toMatchObject({ context });
  expect(composeBrowserDraft({ content: '修改整表格式', outputFiles: [item] })).toContain(
    '"scope":"sheet"',
  );
  for (const extra of [
    { range: 'A1' },
    { cells: [] },
    { sheet: '' },
    { sheet: 'x\ny' },
    { scope: 'all' },
    { path: '/other' },
  ])
    expect(isOfficeEditContext({ sourceHash: hash, selection: { ...selection, ...extra } })).toBe(
      false,
    );
});

test('range decoder requires ordered complete unique bounded rectangles and exact sheet paths', () => {
  const cells = ['B2', 'C2', 'B3', 'C3'].map((address) => ({
    address,
    path: `/预算/${address}`,
    value: '',
  }));
  const selection = { kind: 'excel', sheet: '预算', range: 'B2:C3', cells };
  const valid = (patch: object) =>
    isOfficeEditContext({ sourceHash: hash, selection: { ...selection, ...patch } });
  expect(valid({})).toBe(true);
  expect(
    valid({
      range: 'XFD1048576',
      cells: [{ address: 'XFD1048576', path: '/预算/XFD1048576', value: 'last' }],
    }),
  ).toBe(true);
  for (const range of ['C3:B2', 'B3:C2', 'B2:C3:D4', 'XFE1', 'A1048577', 'A0', 'a1', 'A1:ZZ9'])
    expect(valid({ range })).toBe(false);
  for (const value of [
    [],
    cells.slice(1),
    [cells[0], cells[0], cells[2], cells[3]],
    [cells[1], cells[0], cells[2], cells[3]],
    cells.map((c, i) => (i ? c : { ...c, path: '/另一表/B2' })),
    cells.map((c, i) => (i ? c : { ...c, address: 'D2' })),
    cells.map((c, i) => (i ? c : { ...c, value: 'x'.repeat(4097) })),
    cells.map((c, i) => (i ? c : { ...c, formula: 'x'.repeat(4097) })),
    cells.map((c, i) => (i ? c : { ...c, execute: true })),
  ])
    expect(valid({ cells: value })).toBe(false);
  expect(valid({ cells: cells.map((c) => ({ ...c, value: '汉'.repeat(3000) })) })).toBe(false);
  expect(valid({ cells: cells.map((c) => ({ ...c, formula: 'SUM(A1)', value: '' })) })).toBe(true);
});

test('Word preview page scope encodes bounded complete blocks and explicit HTML generation without invented offsets', () => {
  const selection = {
    kind: 'word' as const,
    scope: 'page' as const,
    pageBasis: 'html-preview' as const,
    page: 2,
    layoutGeneration: 3,
    blocks: [{ path: '/body/p[1]', text: '正文' }],
  };
  const valid = (patch: object) =>
    isOfficeEditContext({ sourceHash: hash, selection: { ...selection, ...patch } });
  expect(valid({})).toBe(true);
  expect(officeSelectionLabel(selection)).toBe('预览第 2 页正文');
  expect(
    composeBrowserDraft({
      content: '修改该预览页',
      outputFiles: [{ ...file, context: { sourceHash: hash, selection } }],
    }),
  ).toContain('"pageBasis":"html-preview"');
  for (const patch of [
    { pageBasis: 'native-word' },
    { page: 0 },
    { page: 501 },
    { layoutGeneration: 0 },
    { layoutGeneration: 1.5 },
    { blocks: [] },
    { blocks: [selection.blocks[0], selection.blocks[0]] },
    { blocks: [{ path: '/other/p[1]', text: 'x' }] },
    { blocks: [{ path: '/body/p[1]', text: 'x', offset: 1 }] },
    { blocks: [{ path: '/body/p[1]', text: 'x'.repeat(16001) }] },
    { start: { path: '/body/p[1]', offset: 0 } },
  ])
    expect(valid(patch)).toBe(false);
});

test('legacy sparse Excel is readable only as draft data, remains marked for reselection and never gains submit authority', () => {
  const legacy = {
    ...file,
    name: 'budget.xlsx',
    context: {
      sourceHash: hash,
      selection: {
        kind: 'excel' as const,
        sheet: '预算',
        range: 'A1:C3',
        cells: [{ path: '/预算/A1', address: 'A1', value: '12' }],
      },
    },
  };
  const items = [legacy, { ...file, id: 'ordinary', context: undefined }],
    copy = JSON.parse(JSON.stringify(items));
  expect(() => readOutputDraftFiles(copy)).toThrow();
  expect(readOutputDraftFiles(copy, { allowLegacyExcelRanges: true })).toEqual(items);
  expect(JSON.stringify(copy)).toBe(JSON.stringify(items));
  expect(outputDraftLabel(legacy)).toContain('范围需重选');
  const doc = { content: '保留普通草稿', outputFiles: items };
  expect(JSON.parse(browserDraftProofText(doc)).outputFiles).toEqual(copy);
  expect(browserDraftMatches(doc, doc.content)).toBe(false);
  expect(() => composeBrowserDraft(doc)).toThrow();
  expect(
    decodeNativeRequest({
      method: 'draft.write',
      generation: 1,
      sessionId: 'session',
      revision: 1,
      ...doc,
      browserAnnotations: [],
      annotationImageOffset: 0,
    }),
  ).toBeDefined();
  expect(() =>
    decodeNativeRequest({
      method: 'input.files.fromOutput',
      generation: 1,
      id: 'chip',
      target,
      context: legacy.context,
    }),
  ).toThrow();
  expect(() =>
    decodeNativeRequest({
      method: 'submit',
      generation: 1,
      sessionId: 'session',
      intent: {
        kind: 'run.start',
        commandId: 'legacy',
        expectedStoreId: 'store',
        content: 'request',
      },
      fileIds: ['chip'],
      officeDocument: { content: 'request', outputFiles: [legacy] },
    }),
  ).toThrow();
  for (const bad of [
    { ...legacy, context: { ...legacy.context, sourceHash: 'invalid' } },
    { ...legacy, target: { ...target, locator: { kind: 'delivery', key: '' } } },
    { ...legacy, context: { ...legacy.context, extra: 'capability' } },
    {
      ...legacy,
      context: {
        ...legacy.context,
        selection: {
          ...legacy.context.selection,
          cells: [{ ...legacy.context.selection.cells[0], command: 'run' }],
        },
      },
    },
  ])
    expect(() => readOutputDraftFiles([bad], { allowLegacyExcelRanges: true })).toThrow();
  const removed = { ...doc, outputFiles: [items[1]!] };
  expect(composeBrowserDraft(removed)).toBe(doc.content);
});

test('historically valid long Chinese Word and PPT text keep their character budget while new scopes enforce byte limits', () => {
  const text = '汉'.repeat(12000);
  for (const selection of [
    {
      kind: 'word' as const,
      start: { path: '/body/p[1]', offset: 0 },
      end: { path: '/body/p[1]', offset: 12000 },
      text,
    },
    { kind: 'powerpoint' as const, slide: 1, objectPath: '/slide[1]/shape[1]', text },
  ]) {
    const restored = { ...file, context: { sourceHash: hash, selection } };
    expect(new TextEncoder().encode(JSON.stringify(selection)).byteLength).toBeGreaterThan(32768);
    expect(isOfficeEditContext(restored.context)).toBe(true);
    expect(readOutputDraftFiles(JSON.parse(JSON.stringify([restored])))).toEqual([restored]);
  }
  expect(
    isOfficeEditContext({
      sourceHash: hash,
      selection: {
        kind: 'word',
        scope: 'page',
        pageBasis: 'html-preview',
        page: 1,
        layoutGeneration: 1,
        blocks: [{ path: '/body/p[1]', text }],
      },
    }),
  ).toBe(false);
  const selection = {
    kind: 'excel',
    sheet: 'S',
    range: 'A1:D1',
    cells: ['A1', 'B1', 'C1', 'D1'].map((address) => ({
      address,
      path: `/S/${address}`,
      value: '汉'.repeat(3000),
    })),
  };
  expect(isOfficeEditContext({ sourceHash: hash, selection })).toBe(false);
  expect(
    readOutputDraftFiles([{ ...file, context: { sourceHash: hash, selection } }], {
      allowLegacyExcelRanges: true,
    }),
  ).toHaveLength(1);
});
