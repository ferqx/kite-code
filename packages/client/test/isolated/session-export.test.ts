import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createClient, type SessionExportFrame, type SessionExportManifest } from '../../src';
import { createBrowserClient } from '../../src/browser';

function fixture() {
  const profile = { dataRoot: '/selected', name: 'owned', accessKey: 'owned' },
    identity = 'a'.repeat(64),
    original = Buffer.from(`{ unknown ☃ 👋 ${'raw'.repeat(50000)} exact-tail }`),
    hash = createHash('sha256').update(original).digest('hex');
  const sections = [
    'sessions',
    'commands',
    'runs',
    'messages',
    'message_parts',
    'executions',
    'execution_output',
    'interactions',
    'context_snapshots',
    'extension_records',
    'artifact_refs',
  ] as const;
  const manifest: SessionExportManifest = {
    version: 1,
    storeId: 'store',
    rootSessionId: 's',
    readInstanceId: 'reader',
    snapshotCursor: '9007199254740993',
    dataVersion: '1',
    sections: sections.map((section) => ({
      section,
      highWaterSeq:
        section === 'sessions' ? '1' : section === 'message_parts' ? '9007199254740993' : '0',
      count: section === 'sessions' || section === 'message_parts' ? '1' : '0',
    })),
    excluded: ['host_controls_and_credentials'],
    contentMedia: 'sqlite-records-and-original-scope-artifact-references',
  };
  let tamper = '',
    reads = 0,
    posts = 0,
    verifies = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.method !== 'GET') posts++;
      const url = new URL(request.url),
        response = (body: unknown) =>
          Response.json(body, { headers: { 'x-kite-web-identity': identity } });
      if (url.pathname.endsWith('/server'))
        return response(
          url.pathname.startsWith('/browser/')
            ? {
                instanceId: 'owned',
                buildId: 'owned',
                pageIdentity: identity,
                capabilities: ['session_exports'],
                storeId: 'store',
                dataAvailability: 'available',
              }
            : {
                instanceId: 'owned',
                buildId: 'owned',
                apiMajor: 1,
                profile,
                capabilities: ['session_exports'],
                storeId: 'store',
                dataAvailability: 'available',
              },
        );
      reads++;
      if (url.pathname.endsWith('/manifest'))
        return response(
          tamper === 'manifest'
            ? {
                ...manifest,
                sections: manifest.sections.map((section) => ({ ...section, section: 'sessions' })),
              }
            : manifest,
        );
      if (url.pathname.endsWith('/verify')) {
        verifies++;
        return response({
          manifest: tamper === 'completion' ? { ...manifest, readInstanceId: 'other' } : manifest,
          verified: true,
          contentMedia: manifest.contentMedia,
        });
      }
      const section = url.searchParams.get('section')!,
        seq = section === 'message_parts' ? '9007199254740993' : '1';
      if (url.pathname.endsWith('/text')) {
        const at = Number(url.searchParams.get('afterByte') ?? '0'),
          bytes = original.subarray(at, at + 65536),
          next = at + bytes.length;
        return response({
          storeId: 'store',
          rootSessionId: 's',
          section,
          seq,
          field: 'json',
          afterByte: String(at),
          byteLength: String(original.length),
          contentBase64: (tamper === 'hash' ? Buffer.alloc(bytes.length) : bytes).toString(
            'base64',
          ),
          nextAfterByte:
            next === original.length ? null : tamper === 'text_cursor' ? String(at) : String(next),
        });
      }
      const record =
        section === 'sessions'
          ? { id: 's', root_id: 's', parent_id: null }
          : {
              kind: 'future.part',
              content_version: '901',
              json: {
                kind: 'export_text',
                field: 'json',
                byteLength: String(original.length),
                sha256: hash,
              },
              futureRaw: 'preserved unparsed data',
            };
      return response({
        storeId: 'store',
        rootSessionId: 's',
        section,
        snapshotCursor: manifest.snapshotCursor,
        upperSeq: manifest.sections.find((item) => item.section === section)!.highWaterSeq,
        records:
          section === 'sessions' || section === 'message_parts'
            ? tamper === 'missing' && section === 'message_parts'
              ? []
              : [
                  {
                    section,
                    seq,
                    sessionId: tamper === 'scope' && section === 'message_parts' ? 'foreign' : 's',
                    id: section === 'sessions' ? 's' : 'message',
                    record,
                    futureFact: true,
                  },
                ]
            : [],
        nextAfterSeq: null,
      });
    },
  });
  const native = createClient({
      endpoint: server.url.href,
      token: 'private',
      expected: { profile, apiMajor: 1, requiredCapabilities: ['session_exports'] },
    }),
    browser = createBrowserClient({ origin: server.url.origin, pageIdentity: identity });
  return {
    native,
    browser,
    original,
    manifest,
    setTamper(value: string) {
      tamper = value;
    },
    counts: () => ({ reads, posts, verifies }),
    async connect() {
      await native.connect();
      await browser.connect();
    },
    close() {
      native.disposeNetwork();
      browser.disposeNetwork();
      server.stop(true);
    },
  };
}

test('Native and Cookie raw export streams privately bind the frozen manifest, preserve unknown records and prove text EOF/hash before a references-only completion', async () => {
  const f = fixture();
  try {
    expect(() => f.native.exportSession('s', { storeId: 'store' })).toThrow(
      'connection_not_admitted',
    );
    await f.connect();
    const intent = { storeId: 'store' },
      originalStream = f.native.exportSession('s', intent);
    intent.storeId = 'caller-change';
    const first = await originalStream.next();
    expect(first.value.kind).toBe('manifest');
    if (first.value.kind === 'manifest') first.value.manifest.sections[0]!.count = '0';
    const streams = [originalStream, f.browser.exportSession('s')];
    for (const stream of streams) {
      const frames: SessionExportFrame[] = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames.at(-1)).toMatchObject({
        kind: 'complete',
        rawTextVerified: true,
        media: 'original-scope-references',
      });
      const raw = frames.find(
        (frame) => frame.kind === 'record' && frame.record.section === 'message_parts',
      );
      expect(raw).toMatchObject({
        kind: 'record',
        record: {
          seq: '9007199254740993',
          futureFact: true,
          record: { futureRaw: 'preserved unparsed data' },
        },
      });
      expect(
        Buffer.concat(
          frames.flatMap((frame) =>
            frame.kind === 'text' ? [Buffer.from(frame.page.contentBase64, 'base64')] : [],
          ),
        ),
      ).toEqual(f.original);
      expect(frames.filter((frame) => frame.kind === 'text_complete')).toHaveLength(1);
    }
    expect(f.counts().posts).toBe(0);
    expect(f.counts().verifies).toBe(2);
    const before = f.counts().reads;
    expect(() => f.native.exportSession('s', { storeId: 'foreign' })).toThrow(
      'store_identity_mismatch',
    );
    expect(() =>
      f.native.exportSession('s', { storeId: 'store', subjectId: 'claimed' } as {
        storeId: string;
      }),
    ).toThrow('Invalid BeginSessionExportQuery');
    expect(f.counts().reads).toBe(before);
  } finally {
    f.close();
  }
});

test('missing rows, foreign scope, bad raw text/hash/cursor and replaced final proof never publish a valid export completion; early close and network disposal do not verify or POST', async () => {
  const f = fixture();
  try {
    await f.connect();
    for (const read of [
      () => f.native.exportSession('s', { storeId: 'store' }),
      () => f.browser.exportSession('s'),
    ]) {
      for (const [tamper, code] of [
        ['manifest', 'invalid_export_response'],
        ['missing', 'invalid_export_response'],
        ['scope', 'invalid_export_response'],
        ['text_cursor', 'invalid_export_response'],
        ['hash', 'export_text_hash_mismatch'],
        ['completion', 'invalid_export_response'],
      ] as const) {
        f.setTamper(tamper);
        const frames: SessionExportFrame[] = [];
        let error: unknown;
        try {
          for await (const frame of read()) frames.push(frame);
        } catch (caught) {
          error = caught;
        }
        expect((error as { code: string }).code).toBe(code);
        expect(frames.some((frame) => frame.kind === 'complete')).toBe(false);
      }
    }
    f.setTamper('');
    const before = f.counts().verifies,
      early = f.native.exportSession('s', { storeId: 'store' });
    await early.next();
    await early.return(undefined);
    expect(f.counts().verifies).toBe(before);
    const disposed = f.native.exportSession('s', { storeId: 'store' });
    await disposed.next();
    f.native.disposeNetwork();
    const reads = f.counts().reads;
    expect(
      ((await disposed.next().catch((error: unknown) => error)) as { code: string }).code,
    ).toBe('connection_not_admitted');
    expect(f.counts().reads).toBe(reads);
    expect(f.counts().verifies).toBe(before);
    expect(f.counts().posts).toBe(0);
  } finally {
    f.close();
  }
});
