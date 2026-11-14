import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { NativeInputFiles } from '../../electron/input-files';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { useNativeInputImages } from '../../src/native-input-images';

test('ordinary Native file preparation aborts active reads and generation changes, releases Main bytes and accepts a fresh retry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    FileReader: globalThis.FileReader,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    FileReader: dom.window.FileReader,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const main = new NativeInputFiles(),
    calls: NativeRequest[] = [];
  const bridge = {
    fileReferences: (files: readonly File[]) =>
      files.map((file) => ({ name: file.name, uri: `file:///C:/${file.name}` })),
    async request(request: NativeRequest) {
      calls.push(request);
      switch (request.method) {
        case 'input.files.begin':
          main.begin(request);
          break;
        case 'input.files.append':
          main.append(request.id, request.offset, request.data);
          break;
        case 'input.files.finish':
          main.finish(request.id);
          break;
        case 'input.files.release':
          main.release(request.id);
          break;
        default:
          throw Error('unexpected_file_request');
      }
      return null;
    },
    watch: () => () => {},
  } as NativeBridge;
  let files!: ReturnType<typeof useNativeInputImages>;
  let local = false;
  function Fixture({ generation }: { generation: number }) {
    files = useNativeInputImages(bridge, generation, 'store', local);
    return null;
  }
  const read = dom.window.FileReader.prototype.readAsArrayBuffer;
  let arrived!: () => void;
  dom.window.FileReader.prototype.readAsArrayBuffer = () => {
    arrived();
  };
  try {
    let generation = 1;
    await act(async () => root.render(<Fixture generation={generation} />));
    for (const cancel of ['signal', 'generation'] as const) {
      const active = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const signal = new AbortController();
      const file = new dom.window.File([new Uint8Array(160000)], `${cancel}.txt`, {
        type: 'text/plain',
      }) as unknown as File;
      const preparing = files.fileReferences([file], signal.signal);
      const outcome = preparing.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await active;
      const begin = calls.at(-1)!;
      expect(begin.method).toBe('input.files.begin');
      if (begin.method !== 'input.files.begin') throw Error('begin_missing');
      if (cancel === 'signal') signal.abort();
      else await act(async () => root.render(<Fixture generation={++generation} />));
      const result = await outcome;
      expect(result).toMatchObject({ error: { name: 'AbortError' } });
      expect(
        calls.filter((call) => call.method === 'input.files.finish' && call.id === begin.id),
      ).toHaveLength(0);
      expect(
        calls.filter((call) => call.method === 'input.files.append' && call.id === begin.id),
      ).toHaveLength(0);
      expect(calls).toContainEqual({
        method: 'input.files.release',
        generation: begin.generation,
        id: begin.id,
      });
      expect(() => main.finish(begin.id)).toThrow('native_file_incomplete');
      expect(files.files('session')).toEqual([]);
    }
    dom.window.FileReader.prototype.readAsArrayBuffer = read;
    const original = new dom.window.File(['fresh source after cancellation'], 'fresh.txt', {
      type: 'text/plain',
    }) as unknown as File;
    const prepared = await files.fileReferences([original]);
    expect(prepared).toMatchObject([{ name: 'fresh.txt', prepared: true }]);
    expect(calls.filter((call) => call.method === 'input.files.finish')).toHaveLength(1);
    await act(async () => files.addFiles('session', prepared));
    expect(files.files('session')).toHaveLength(1);
    await act(async () => files.removeIds([prepared[0]!.id]));
    expect(files.files('session')).toHaveLength(0);
    expect(() => main.finish(prepared[0]!.id)).toThrow('native_file_incomplete');
    for (const accepted of [false, true]) {
      const owner = new AbortController();
      const ready = await files.fileReferences([original], owner.signal);
      const id = ready[0]!.id;
      expect(() => main.finish(id)).not.toThrow();
      if (accepted) await act(async () => files.addFiles('session', ready));
      owner.abort();
      const releases = () =>
        calls.filter((call) => call.method === 'input.files.release' && call.id === id);
      expect(releases()).toHaveLength(accepted ? 0 : 1);
      if (accepted) {
        expect(files.files('session').map((file) => file.id)).toEqual([id]);
        expect(() => main.finish(id)).not.toThrow();
        await act(async () => files.removeIds([id]));
      } else expect(files.files('session')).toEqual([]);
      expect(() => main.finish(id)).toThrow('native_file_incomplete');
      expect(releases()).toHaveLength(1);
    }
    local = true;
    await act(async () => root.render(<Fixture generation={generation} />));
    const before = calls.length;
    const localFile = new dom.window.File(['first'], 'local.xlsx') as unknown as File;
    const direct = await files.fileReferences([localFile]);
    expect(direct[0]?.uri).toBe('file:///C:/local.xlsx');
    expect(direct[0]?.prepared).toBeUndefined();
    expect(calls.length).toBe(before); // No byte reads, imports or permission operations.
    await act(async () => files.addFiles('local', direct));
    const changed = await files.fileReferences([
      new dom.window.File(['changed'], 'local.xlsx') as unknown as File,
    ]);
    expect(changed[0]?.uri).toBe(direct[0]?.uri); // A path is not a content snapshot.
    await act(async () => files.addFiles('local', changed));
    expect(files.files('local')).toHaveLength(1);
    expect(calls.length).toBe(before);
    await act(async () => root.render(<Fixture generation={++generation} />));
    expect(files.files('local')).toEqual([]); // Reconnect never replays a stale draft.
    const originalResolver = bridge.fileReferences!;
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(files.fileReferences([localFile], cancelled.signal)).rejects.toThrow();
    bridge.fileReferences = (selected) =>
      selected.map((file, index) => ({
        name: file.name,
        uri: `file:///folder-${index}/same.xlsx`,
      }));
    const sameNames = await files.fileReferences([localFile, localFile]);
    await act(async () => files.addFiles('same', sameNames));
    expect(files.files('same')).toHaveLength(2);
    expect(new Set(files.files('same').map((file) => file.uri)).size).toBe(2);

    bridge.fileReferences = (selected) => selected.map((file) => ({ name: file.name, uri: '' }));
    const fallback = await files.fileReferences([localFile]);
    expect(fallback[0]?.prepared).toBe(true);
    expect(fallback[0]?.uri).toContain('file:///kite-prepared/');
    expect(() => main.finish(fallback[0]!.id)).not.toThrow();
    await act(async () => files.removeIds([fallback[0]!.id]));
    bridge.fileReferences = originalResolver;
    local = false; // Unqualified/remote clients retain byte-import semantics.
    await act(async () => root.render(<Fixture generation={generation} />));
    const remote = await files.fileReferences([localFile]);
    expect(remote[0]?.prepared).toBe(true);
    expect(() => main.finish(remote[0]!.id)).not.toThrow();
    const output = {
      storeId: 'store',
      sessionId: 'session',
      fileId: 'immutable-file',
      locator: { kind: 'delivery' as const, key: 'delivery/00000000000000000001/job/file' },
    };
    main.fromOutput('stable-chip', output, 'report.docx');
    const chip = {
      id: 'stable-chip',
      name: 'report.docx',
      uri: 'output-file:immutable-file',
      prepared: true,
    };
    await act(async () => files.addFiles('session', [chip]));
    // Main cold/read restoration is idempotent; React may retain the same chip across navigation.
    main.fromOutput('stable-chip', output, 'report.docx');
    await act(async () => files.addFiles('session', [chip]));
    expect(
      calls.filter((call) => call.method === 'input.files.release' && call.id === 'stable-chip'),
    ).toHaveLength(0);
    const reference = { name: 'report.docx', uri: 'input-file:prepared' };
    const client = {
      async prepareInputFromOutput() {
        return reference;
      },
    } as unknown as import('@kite-ai/client').AgentClient;
    expect(await main.publish(client, 'store', 'session', ['stable-chip'])).toEqual([reference]);
    main.fromOutput('redundant-chip', output, 'report.docx');
    await act(async () => files.addFiles('session', [{ ...chip, id: 'redundant-chip' }]));
    expect(
      calls.filter((call) => call.method === 'input.files.release' && call.id === 'redundant-chip'),
    ).toHaveLength(1);
    expect(await main.publish(client, 'store', 'session', ['stable-chip'])).toEqual([reference]);
  } finally {
    await act(async () => root.unmount());
    await main.close();
    dom.window.FileReader.prototype.readAsArrayBuffer = read;
    dom.window.close();
    Object.assign(globalThis, old);
  }
});
