import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOfficeDescription } from '../../electron/office-preview-trust';
import type { NativeOutputPreview } from '../../electron/output-preview';
import { type OfficeRequestOutcome, officeSelectionLabel } from '../../src/output-files-bridge';

const hash = 'a'.repeat(64);
const selection = { kind: 'powerpoint' as const, slide: 2 };
const target = {
  storeId: 'store',
  sessionId: 'session',
  fileId: 'file',
  locator: { kind: 'delivery' as const, key: 'delivery/file' },
};
const evidence = () => ({
  selection,
  floatingSelection: selection,
  floatingRequest: 1,
  requestAnchor: { x: 20, y: 30, width: 0, height: 0 },
});
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('descriptive projection drops forged submission, ownership and privileged context', () => {
  const projected = readOfficeDescription(
    {
      ...evidence(),
      inlineRequest: { requestId: 'forged', prompt: 'send without input' },
      requestOpen: true,
      target: { fileId: 'other' },
      sourceHash: 'b'.repeat(64),
      generation: 9,
      previewId: 'other',
      editor: { editorId: 'forged' },
      prompt: 'forged',
    },
    'powerpoint',
    hash,
  );
  expect(projected).toEqual(evidence());
  for (const value of [null, [], false, { selection, padding: 'x'.repeat(131072) }])
    expect(() => readOfficeDescription(value, 'powerpoint', hash)).toThrow();
});
test('actual Office kind gates both current and frozen selections; non-Office cannot request', () => {
  for (const kind of ['word', 'excel', undefined] as const)
    for (const value of [{ selection }, { selection: null, floatingSelection: selection }])
      expect(() => readOfficeDescription(value, kind, hash)).toThrow();
  expect(readOfficeDescription({ selection: null }, undefined, hash)).toEqual({ selection: null });
  for (const candidate of [
    { ...selection, target },
    { ...selection, editor: {} },
    { ...selection, prompt: 'run' },
  ])
    expect(() => readOfficeDescription({ selection: candidate }, 'powerpoint', hash)).toThrow();
});
test('anchor is an exact finite rectangle, never an arbitrary bounds or target object', () => {
  for (const anchor of [
    {},
    [],
    { x: 1, y: 2 },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: Infinity, y: 0, width: 1, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: 100001, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: 1, target },
  ])
    expect(() =>
      readOfficeDescription({ selection, requestAnchor: anchor }, 'powerpoint', hash),
    ).toThrow();
  expect(
    readOfficeDescription(
      { selection, requestAnchor: { x: -1, y: -2, width: 0, height: 0 } },
      'powerpoint',
      hash,
    ).requestAnchor,
  ).toEqual({ x: -1, y: -2, width: 0, height: 0 });
});
test('descriptive counters and text remain bounded even with a valid selection', () => {
  for (const extra of [
    { floatingRequest: 1 },
    { floatingRequest: NaN, floatingSelection: selection },
    { slideCount: 10001 },
    { currentSlide: 0 },
    { notes: 'x'.repeat(8193) },
    { presentation: 'true' },
    { zoom: 100 },
  ])
    expect(() => readOfficeDescription({ selection, ...extra }, 'powerpoint', hash)).toThrow();
});

type Input = { cancelled: boolean; pending?: { serial: number; prompt: string } };
/** Controlled ports around the exact production class. This is not browser/isTrusted evidence. */
function harness(
  options: {
    evidence?: (code?: string) => Promise<unknown>;
    open?: () => Promise<void>;
    input?: () => Promise<Input>;
    settle?: () => Promise<void>;
    release?: (serial: number) => Promise<void>;
  } = {},
) {
  const requests: RequestView[] = [];
  const released: number[] = [];
  class RequestView {
    closed = false;
    constructor() {
      requests.push(this);
    }
    async open() {
      await options.open?.();
    }
    bounds() {}
    async read() {
      return options.input ? options.input() : { cancelled: false };
    }
    async settle(_serial: number, _outcome: OfficeRequestOutcome) {
      await options.settle?.();
    }
    close() {
      this.closed = true;
    }
  }
  const source = readFileSync(
    resolve(import.meta.dir, '../../electron/output-preview.ts'),
    'utf8',
  ).replace(/^import[\s\S]*?;\r?\n/gm, '');
  const compiled = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^export /gm, '');
  const Class = new Function(
    'deps',
    `const { randomUUID, readOfficeDescription, officeSelectionLabel, NativeOfficeRequestView,
    officeInteractionWorld, officeInteractionReadScript, officeInteractionPeekScript, officeInteractionReleaseScript, officeInteractionControlScript,
    focusNativeWindowContent, rm } = deps; ${compiled}; return NativeOutputPreview;`,
  )({
    randomUUID,
    readOfficeDescription,
    officeSelectionLabel,
    NativeOfficeRequestView: RequestView,
    officeInteractionWorld: 1004,
    officeInteractionControlScript: (command: unknown) => `control:${JSON.stringify(command)}`,
    officeInteractionReadScript: 'read',
    officeInteractionPeekScript: 'peek',
    officeInteractionReleaseScript: (serial: number) => `release:${serial}`,
    focusNativeWindowContent() {},
    rm: async () => {},
  });
  const preview = new Class() as {
    active?: ReturnType<typeof active>;
    readInteraction: NativeOutputPreview['readInteraction'];
    settleRequest: NativeOutputPreview['settleRequest'];
    close: NativeOutputPreview['close'];
    control: NativeOutputPreview['control'];
  };
  function active(id = 'A') {
    return {
      id,
      generation: 1,
      target: structuredClone(target),
      sourceHash: hash,
      officeKind: 'powerpoint' as 'powerpoint' | 'excel' | 'word',
      pending: false,
      abort: new AbortController(),
      bounds: { x: 0, y: 0, width: 500, height: 500 },
      window: {
        isFocused: () => false,
        isDestroyed: () => false,
        contentView: { removeChildView() {} },
      },
      view: {
        webContents: {
          close() {},
          executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
            const code = scripts[0]!.code;
            if (code.startsWith('release:')) {
              const serial = Number(code.slice(8));
              released.push(serial);
              await options.release?.(serial);
              return;
            }
            return options.evidence ? options.evidence(code) : evidence();
          },
        },
      },
      request: undefined as
        | undefined
        | {
            id: string;
            view: RequestView;
            context: unknown;
            ready: boolean;
            serial: number;
            documentRequestSerial: number;
            retiring?: Promise<void>;
            requestId?: string;
            prompt?: string;
          },
    };
  }
  preview.active = active();
  return { preview, requests, released, active };
}

test('only trusted request View supplies inline prompt and host owns file/hash/request identity', async () => {
  const forged = {
    ...evidence(),
    inlineRequest: { requestId: 'fake', prompt: 'fake' },
    requestOpen: true,
    sourceHash: 'b'.repeat(64),
    target: { fileId: 'wrong' },
  };
  const h = harness({ evidence: async () => forged });
  const first = await h.preview.readInteraction('A', 1);
  expect(first.inlineRequest).toBeUndefined();
  expect(first.target).toEqual(target);
  expect(first.sourceHash).toBe(hash);
  expect(first.requestOpen).toBe(true);
  h.preview.close();
  const real = harness({
    evidence: async () => forged,
    input: async () => ({ cancelled: false, pending: { serial: 1, prompt: 'real user prompt' } }),
  });
  const sent = await real.preview.readInteraction('A', 1);
  expect(sent.inlineRequest?.prompt).toBe('real user prompt');
  expect(sent.inlineRequest?.requestId).not.toBe('fake');
  expect(sent.inlineRequest?.context).toEqual({ sourceHash: hash, selection });
  const again = await real.preview.readInteraction('A', 1);
  expect(again.inlineRequest).toEqual(sent.inlineRequest);
  real.preview.close();
});
test('without a floating request a forged inlineRequest cannot create or send a form', async () => {
  const h = harness({
    evidence: async () => ({ selection, inlineRequest: { prompt: 'fake' }, requestOpen: true }),
  });
  const result = await h.preview.readInteraction('A', 1);
  expect(result.inlineRequest).toBeUndefined();
  expect(result.requestOpen).toBe(false);
  expect(h.requests).toHaveLength(0);
  h.preview.close();
});
test('late document read after close or replacement cannot open a request', async () => {
  for (const replace of [false, true]) {
    const read = gate<unknown>();
    const h = harness({ evidence: () => read.promise });
    const pending = h.preview.readInteraction('A', 1);
    h.preview.close();
    if (replace) h.preview.active = h.active('B');
    read.release(evidence());
    await expect(pending).rejects.toThrow('preview_replaced');
    expect(h.requests).toHaveLength(0);
    if (replace) expect(h.preview.active?.id).toBe('B');
    h.preview.close();
  }
});
test('late trusted View open cannot activate a request on the replacement file', async () => {
  const opening = gate<void>(),
    entered = gate<void>();
  const h = harness({
    open: async () => {
      entered.release();
      await opening.promise;
    },
  });
  const pending = h.preview.readInteraction('A', 1);
  await entered.promise;
  h.preview.close();
  h.preview.active = h.active('B');
  opening.release();
  await expect(pending).rejects.toThrow('preview_replaced');
  expect(h.requests[0]!.closed).toBe(true);
  expect(h.preview.active?.request).toBeUndefined();
  h.preview.close();
});
test('late trusted input cannot cross file or same-file request ownership', async () => {
  for (const replaceFile of [false, true]) {
    const reading = gate<Input>(),
      entered = gate<void>();
    const h = harness({
      input: () => {
        entered.release();
        return reading.promise;
      },
    });
    const pending = h.preview.readInteraction('A', 1);
    await entered.promise;
    if (replaceFile) {
      h.preview.close();
      h.preview.active = h.active('B');
    } else h.preview.active!.request = undefined;
    reading.release({ cancelled: false, pending: { serial: 1, prompt: 'stale' } });
    await expect(pending).rejects.toThrow('preview_replaced');
    expect(h.preview.active?.request).toBeUndefined();
    h.preview.close();
  }
});
test('late settlement cannot close or mutate a replacement form', async () => {
  const settling = gate<void>(),
    entered = gate<void>();
  const h = harness({
    input: async () => ({ cancelled: false, pending: { serial: 1, prompt: 'real' } }),
    settle: async () => {
      entered.release();
      await settling.promise;
    },
  });
  const request = (await h.preview.readInteraction('A', 1)).inlineRequest!;
  const pending = h.preview.settleRequest('A', 1, request.requestId, { status: 'accepted' });
  await entered.promise;
  h.preview.close();
  h.preview.active = h.active('B');
  settling.release();
  await expect(pending).rejects.toThrow('preview_request_replaced');
  expect(h.preview.active?.id).toBe('B');
  expect(h.preview.active?.request).toBeUndefined();
  h.preview.close();
});

test('sheet scope remains bounded evidence tied to an actual Excel preview', () => {
  const sheet = { kind: 'excel', scope: 'sheet', sheet: 'Revenue' } as const;
  expect(readOfficeDescription({ selection: sheet }, 'excel', hash).selection).toEqual(sheet);
  for (const kind of ['word', 'powerpoint', undefined] as const)
    expect(() => readOfficeDescription({ selection: sheet }, kind, hash)).toThrow();
  for (const injected of [
    { ...sheet, range: 'A1' },
    { ...sheet, target },
    { ...sheet, cells: [] },
    { ...sheet, sourceHash: hash },
  ])
    expect(() => readOfficeDescription({ selection: injected }, 'excel', hash)).toThrow();
});
test('once opened, later document evidence cannot retarget the frozen request context', async () => {
  let current = evidence();
  let input: Input = { cancelled: false };
  const h = harness({ evidence: async () => current, input: async () => input });
  await h.preview.readInteraction('A', 1);
  current = { ...evidence(), floatingSelection: { kind: 'powerpoint', slide: 9 } };
  input = { cancelled: false, pending: { serial: 1, prompt: 'keep original scope' } };
  const request = (await h.preview.readInteraction('A', 1)).inlineRequest;
  expect(request?.context).toEqual({ sourceHash: hash, selection });
  h.preview.close();
});

test('invalidation is a bounded negative serial, never a public renderer command', async () => {
  for (const serial of [0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      readOfficeDescription({ selection: null, requestInvalidated: serial }, 'word', hash),
    ).toThrow();
  const h = harness({ evidence: async () => ({ selection: null, requestInvalidated: 7 }) });
  const result = await h.preview.readInteraction('A', 1);
  expect(h.released).toEqual([7]);
  expect(h.requests).toHaveLength(0);
  expect(result.requestOpen).toBe(false);
  expect('requestInvalidated' in result).toBe(false);
  h.preview.close();
});
test('another floating serial cannot replace an open scope or its frozen context', async () => {
  let value = evidence();
  const h = harness({ evidence: async () => value });
  await h.preview.readInteraction('A', 1);
  value = {
    ...evidence(),
    floatingRequest: 2,
    floatingSelection: { kind: 'powerpoint', slide: 8 },
  };
  await h.preview.readInteraction('A', 1);
  expect(h.requests).toHaveLength(1);
  expect(h.preview.active?.request?.documentRequestSerial).toBe(1);
  expect(h.preview.active?.request?.context).toEqual({ sourceHash: hash, selection });
  h.preview.close();
});
test('late old invalidation cannot close a newer document request serial', async () => {
  const h = harness({
    evidence: async () => ({ ...evidence(), floatingRequest: 2, requestInvalidated: 1 }),
  });
  const opened = await h.preview.readInteraction('A', 1);
  expect(opened.requestOpen).toBe(true);
  // The first negative serial had no owner; it only released that exact old controller lock.
  expect(h.released).toEqual([1]);
  await h.preview.readInteraction('A', 1);
  expect(h.requests[0]!.closed).toBe(false);
  expect(h.preview.active?.request?.documentRequestSerial).toBe(2);
  expect(h.released).toEqual([1]);
  h.preview.close();
});
test('Word page reflow while trusted input is awaited invalidates instead of emitting pending', async () => {
  const word = {
    kind: 'word',
    scope: 'page',
    pageBasis: 'html-preview',
    page: 1,
    layoutGeneration: 1,
    blocks: [{ path: '/body/p[1]', text: 'first layout' }],
  };
  let invalidated = false;
  const reading = gate<Input>(),
    entered = gate<void>();
  const h = harness({
    evidence: async (code) =>
      code === 'peek' && invalidated
        ? { selection: null, requestInvalidated: 1 }
        : { selection: word, floatingSelection: word, floatingRequest: 1 },
    input: () => {
      entered.release();
      return reading.promise;
    },
  });
  h.preview.active!.officeKind = 'word';
  const pending = h.preview.readInteraction('A', 1);
  await entered.promise;
  invalidated = true;
  reading.release({ cancelled: false, pending: { serial: 1, prompt: 'change old page' } });
  const result = await pending;
  expect(result.inlineRequest).toBeUndefined();
  expect(result.requestOpen).toBe(false);
  expect(h.requests[0]!.closed).toBe(true);
  expect(h.released).toEqual([1]);
  h.preview.close();
});
test('cancel and accepted close release exact document serial; failed and unknown keep ownership', async () => {
  for (const status of ['failed', 'unknown', 'accepted'] as const) {
    const h = harness({
      evidence: async () => ({ ...evidence(), floatingRequest: 9 }),
      input: async () => ({ cancelled: false, pending: { serial: 3, prompt: 'real' } }),
    });
    const request = (await h.preview.readInteraction('A', 1)).inlineRequest!;
    await h.preview.settleRequest('A', 1, request.requestId, { status });
    expect(h.released).toEqual(status === 'accepted' ? [9] : []);
    expect(h.requests[0]!.closed).toBe(status === 'accepted');
    h.preview.close();
  }
  const h = harness({
    evidence: async () => ({ ...evidence(), floatingRequest: 12 }),
    input: async () => ({ cancelled: true }),
  });
  expect((await h.preview.readInteraction('A', 1)).requestOpen).toBe(false);
  expect(h.released).toEqual([12]);
  h.preview.close();
});
test('open failure releases only its own controller serial', async () => {
  const h = harness({
    open: async () => {
      throw Error('open-failed');
    },
  });
  await expect(h.preview.readInteraction('A', 1)).rejects.toThrow('open-failed');
  expect(h.released).toEqual([1]);
  expect(h.preview.active?.request).toBeUndefined();
  expect(h.requests[0]!.closed).toBe(true);
  h.preview.close();
});
test('retirement in progress suppresses an older pending input even before release acknowledgement', async () => {
  const reading = gate<Input>(),
    entered = gate<void>(),
    releasing = gate<void>(),
    releaseEntered = gate<void>();
  let invalidated = false;
  const h = harness({
    evidence: async () => (invalidated ? { selection: null, requestInvalidated: 1 } : evidence()),
    input: () => {
      entered.release();
      return reading.promise;
    },
    release: async () => {
      releaseEntered.release();
      await releasing.promise;
    },
  });
  const input = h.preview.readInteraction('A', 1);
  await entered.promise;
  invalidated = true;
  const retirement = h.preview.readInteraction('A', 1);
  await releaseEntered.promise;
  reading.release({ cancelled: false, pending: { serial: 1, prompt: 'stale' } });
  await expect(input).rejects.toThrow('preview_replaced');
  releasing.release();
  expect((await retirement).inlineRequest).toBeUndefined();
  expect(h.released).toEqual([1]);
  h.preview.close();
});
test('late release acknowledgement cannot clear a replacement form', async () => {
  const releasing = gate<void>(),
    entered = gate<void>();
  let invalidated = false;
  const h = harness({
    evidence: async () => (invalidated ? { selection: null, requestInvalidated: 1 } : evidence()),
    release: async () => {
      entered.release();
      await releasing.promise;
    },
  });
  await h.preview.readInteraction('A', 1);
  invalidated = true;
  const retirement = h.preview.readInteraction('A', 1);
  await entered.promise;
  const next = harness({ evidence: async () => ({ ...evidence(), floatingRequest: 2 }) });
  await next.preview.readInteraction('A', 1);
  const replacement = next.preview.active!.request!;
  h.preview.active!.request = replacement;
  releasing.release();
  await retirement;
  expect(h.preview.active?.request).toBe(replacement);
  expect(replacement.view.closed).toBe(false);
  expect(h.released).toEqual([1]);
  h.preview.close();
  next.preview.close();
});
test('invalidation after delivery closes only UI and emits no replacement request', async () => {
  let invalidated = false;
  const h = harness({
    evidence: async () => (invalidated ? { selection: null, requestInvalidated: 1 } : evidence()),
    input: async () => ({ cancelled: false, pending: { serial: 1, prompt: 'already handed off' } }),
  });
  const sent = (await h.preview.readInteraction('A', 1)).inlineRequest!;
  invalidated = true;
  const result = await h.preview.readInteraction('A', 1);
  expect(result.inlineRequest).toBeUndefined();
  expect(result.requestOpen).toBe(false);
  expect(sent.prompt).toBe('already handed off');
  expect(h.released).toEqual([1]);
  await expect(
    h.preview.settleRequest('A', 1, sent.requestId, { status: 'accepted' }),
  ).rejects.toThrow('preview_request_replaced');
  h.preview.close();
});

const excelEvidence = () => ({
  selection: {
    kind: 'excel' as const,
    sheet: 'Sheet1',
    range: 'B2:C2',
    cells: [
      { path: '/Sheet1/B2', address: 'B2', value: 'left' },
      { path: '/Sheet1/C2', address: 'C2', value: 'right', formula: '=1+1' },
    ],
  },
  excelSelection: { selectionSerial: 7, activeAddress: 'C2' },
});
test('Excel display identity is exact, range bound and cannot carry privileged data', () => {
  expect(readOfficeDescription(excelEvidence(), 'excel', hash)).toEqual(excelEvidence());
  for (const excelSelection of [
    { selectionSerial: 0, activeAddress: 'C2' },
    { selectionSerial: 7, activeAddress: 'D4' },
    { selectionSerial: 7, activeAddress: 'C2', prompt: 'send' },
    { selectionSerial: 7.5, activeAddress: 'C2' },
    null,
  ])
    expect(() =>
      readOfficeDescription({ ...excelEvidence(), excelSelection }, 'excel', hash),
    ).toThrow();
  expect(() =>
    readOfficeDescription(
      { ...excelEvidence(), selection: { kind: 'excel', scope: 'sheet', sheet: 'Sheet1' } },
      'excel',
      hash,
    ),
  ).toThrow();
  expect(() => readOfficeDescription(excelEvidence(), 'word', hash)).toThrow();
});
test('locate rechecks serial, frozen requests and active owner before dispatch', async () => {
  let current = excelEvidence();
  const commands: string[] = [];
  const h = harness({
    evidence: async (code) => {
      commands.push(code ?? '');
      return current;
    },
  });
  h.preview.active!.officeKind = 'excel';
  await h.preview.control('A', 1, { kind: 'locate-selection', selectionSerial: 7 });
  expect(commands.filter((code) => code.startsWith('control:'))).toHaveLength(1);
  current = { ...current, excelSelection: { selectionSerial: 8, activeAddress: 'C2' } };
  await expect(
    h.preview.control('A', 1, { kind: 'locate-selection', selectionSerial: 7 }),
  ).rejects.toThrow('preview_selection_replaced');
  expect(commands.filter((code) => code.startsWith('control:'))).toHaveLength(1);
  const frozen = harness({
    evidence: async () => ({
      ...excelEvidence(),
      floatingRequest: 3,
      floatingSelection: excelEvidence().selection,
    }),
  });
  frozen.preview.active!.officeKind = 'excel';
  await expect(
    frozen.preview.control('A', 1, { kind: 'locate-selection', selectionSerial: 7 }),
  ).rejects.toThrow('preview_request_active');
  const delayed = gate<unknown>();
  const racing = harness({ evidence: async () => delayed.promise });
  racing.preview.active!.officeKind = 'excel';
  const result = racing.preview.control('A', 1, { kind: 'locate-selection', selectionSerial: 7 });
  racing.preview.active = racing.active('B');
  delayed.release(excelEvidence());
  await expect(result).rejects.toThrow('preview_replaced');
});
