import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type McpSourceEntryMutation,
  type McpSourceOptions,
  readMcpSourceEntryPreview,
  readMcpSources,
  writeMcpSourceEntry,
  writeMcpSourceMetadata,
} from '@kite-ai/agent/config';
import { acquireFileLock } from '../../../src/platform/locks';

const http = { type: 'http', url: 'https://example.test/mcp' } as const;
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-mutations-')));
  const profilePath = join(base, 'profile'),
    workspacePath = join(base, 'workspace');
  mkdirSync(profilePath, { mode: 0o700 });
  mkdirSync(workspacePath, { mode: 0o700 });
  const options: McpSourceOptions = {
    profilePath,
    workspacePath,
    scope: { profileId: 'p', storeId: 'store', sessionId: 's', workspaceId: 'w' },
  };
  const user = join(profilePath, 'mcp.json'),
    project = join(workspacePath, '.kite-code', 'mcp.json');
  const put = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  };
  const mutate = (mutation: McpSourceEntryMutation, operationId = 'op') =>
    writeMcpSourceEntry({
      ...options,
      mutation,
      operationId,
      expectedReadSet: readMcpSources(options).readSet,
      validatePublication() {},
    });
  return {
    base,
    options,
    user,
    project,
    put,
    mutate,
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('basic Add is private, marked, closed and does not overwrite same layer or approve project', () => {
  const f = fixture();
  try {
    const first = f.mutate({ kind: 'add', scope: 'workspace', name: 'local', entry: http });
    expect(first.target.source.kind).toBe('workspace');
    expect(first.fallback).toBeNull();
    expect(first.oldEtag).not.toBe(first.newEtag);
    expect(statSync(f.project).mode & 0o777).toBe(0o600);
    const s = readMcpSources(f.options);
    expect(s.entries[0]!.raw).toMatchObject({
      _kiteSourceCreation: { version: 1, operationId: 'op' },
    });
    expect(s.registry.servers[0]!.reason).toBe('mcp_project_approval_pending');
    expect(existsSync(join(f.options.profilePath, 'mcp-approvals.json'))).toBe(false);
    expect(existsSync(join(f.options.profilePath, 'mcp-auth-bindings.json'))).toBe(false);
    expect(() =>
      f.mutate({ kind: 'add', scope: 'workspace', name: 'local', entry: http }, 'op2'),
    ).toThrow('mcp_source_entry_exists');
    expect(JSON.stringify(first)).not.toContain('example.test');
    expect(() =>
      f.mutate(
        JSON.parse(
          '{"kind":"add","scope":"user","name":"bad","entry":{"type":"http","url":"https://example.test","headers":{}}}',
        ),
      ),
    ).toThrow('mcp_source_mutation_invalid');
    expect(() =>
      f.mutate({
        kind: 'add',
        scope: 'user',
        name: 'secret',
        entry: { type: 'http', url: 'https://u:p@example.test/' },
      }),
    ).toThrow('mcp_transport_unavailable');
    expect(() =>
      f.mutate({
        kind: 'add',
        scope: 'user',
        name: 'relative',
        entry: { type: 'stdio', command: 'sh' },
      }),
    ).toThrow('mcp_transport_unavailable');
  } finally {
    f.close();
  }
});

test('basic Add rejects raw empty URL suffixes, controls, variables and oversize STDIO before any source edit', () => {
  const f = fixture();
  try {
    f.put(f.user, { mcpServers: { retained: http }, advanced: { untouched: true } });
    f.put(f.project, { mcpServers: {} });
    const user = readFileSync(f.user),
      project = readFileSync(f.project);
    const unsafe: Extract<McpSourceEntryMutation, { kind: 'add' }>['entry'][] = [
      { type: 'http', url: 'https://example.test/mcp?' },
      { type: 'http', url: 'https://example.test/mcp#' },
      { type: 'http', url: ' https://example.test/mcp' },
      { type: 'http', url: 'https://example.test/\tmcp' },
      { type: 'http', url: 'https://example.test/\u007fmcp' },
      { type: 'http', url: `https://example.test/\${VARIABLE}` },
      { type: 'http', url: `https://example.test/${'x'.repeat(8192)}` },
      { type: 'stdio', command: `/${'x'.repeat(4096)}` },
      { type: 'stdio', command: '/owned/\ncommand' },
      { type: 'stdio', command: '/owned/\u007fcommand' },
      { type: 'stdio', command: `/owned/\${VARIABLE}` },
    ];
    for (const entry of unsafe) {
      expect(() => f.mutate({ kind: 'add', scope: 'workspace', name: 'unsafe', entry })).toThrow(
        'mcp_transport_unavailable',
      );
      expect(readFileSync(f.user)).toEqual(user);
      expect(readFileSync(f.project)).toEqual(project);
    }
    // This is a new basic API bound, not a reduction of advanced JSONC declaration support.
    f.put(f.project, {
      mcpServers: {
        advanced: {
          type: 'stdio',
          command: `/${'x'.repeat(4096)}`,
          args: ['retained'],
          env: { VALUE: 'retained' },
        },
      },
    });
    const advanced = readMcpSources(f.options).entries.find(
      (entry) => entry.server.name === 'advanced',
    );
    expect(advanced?.server.transport).toBe('stdio');
    expect(advanced?.raw).toMatchObject({ args: ['retained'], env: { VALUE: 'retained' } });
  } finally {
    f.close();
  }
});

test('project Remove exposes exact safe user fallback and only deletes effective original entry', () => {
  const f = fixture();
  try {
    f.put(f.user, {
      mcpServers: { local: { type: 'stdio', command: '/bin/true', enabled: false } },
    });
    f.put(f.project, { mcpServers: { local: http } });
    const state = readMcpSources(f.options),
      selected = state.registry.servers[0]!;
    const preview = readMcpSourceEntryPreview(f.options, {
      scope: 'workspace',
      serverId: selected.id,
      expectedReadSet: state.readSet,
    });
    expect(preview.fallback?.source.kind).toBe('user');
    expect(preview.fallback?.enabled).toBe(false);
    expect(preview.fallback?.transport).toBe('stdio');
    expect(JSON.stringify(preview)).not.toContain('/bin/true');
    expect(() =>
      f.mutate({
        kind: 'remove',
        scope: 'user',
        serverId: selected.id,
        expectedRawEntryDigest: selected.rawEntryDigest,
      }),
    ).toThrow('mcp_source_entry_conflict');
    expect(() =>
      f.mutate({
        kind: 'remove',
        scope: 'workspace',
        serverId: selected.id,
        expectedRawEntryDigest: '0'.repeat(64),
      }),
    ).toThrow('mcp_source_entry_conflict');
    const user = readFileSync(f.user);
    const removed = f.mutate({
      kind: 'remove',
      scope: 'workspace',
      serverId: selected.id,
      expectedRawEntryDigest: selected.rawEntryDigest,
    });
    expect(removed.fallback).toEqual(preview.fallback);
    expect(readFileSync(f.user)).toEqual(user);
    expect(readMcpSources(f.options).registry.servers[0]!.source.kind).toBe('user');
  } finally {
    f.close();
  }
});

test('remove and re-add identical project config cannot revive either old approval fingerprint', () => {
  const f = fixture();
  try {
    f.put(f.project, { mcpServers: { local: http } });
    const approve = () => {
      const s = readMcpSources(f.options),
        entry = s.entries[0]!;
      writeMcpSourceMetadata({
        ...f.options,
        expectedReadSet: s.readSet,
        value: {
          ...entry.binding!,
          kind: 'mcp_source_approval',
          decision: 'approved',
          proof: {
            decisionId: 'd',
            storeId: 'store',
            sessionId: 's',
            interactionId: 'i',
            acceptedRevision: '1',
            subjectId: 'owner',
            requestDigest: 'a'.repeat(64),
            recordedAt: 1,
          },
        },
        validateDecision: () => true,
      });
    };
    const remove = () => {
      const v = readMcpSources(f.options).registry.servers[0]!;
      return f.mutate({
        kind: 'remove',
        scope: 'workspace',
        serverId: v.id,
        expectedRawEntryDigest: v.rawEntryDigest,
      });
    };
    approve();
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(true);
    const oldMetadata = readFileSync(join(f.options.profilePath, 'mcp-approvals.json'));
    remove();
    const a = f.mutate({ kind: 'add', scope: 'workspace', name: 'local', entry: http }, 'create1');
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_project_approval_pending',
    );
    expect(readFileSync(join(f.options.profilePath, 'mcp-approvals.json'))).toEqual(oldMetadata);
    approve();
    remove();
    const b = f.mutate({ kind: 'add', scope: 'workspace', name: 'local', entry: http }, 'create2');
    expect(b.target.rawEntryDigest).not.toBe(a.target.rawEntryDigest);
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_project_approval_pending',
    );
  } finally {
    f.close();
  }
});

test('JSONC mutation preserves unrelated raw env, unknown fields, comments and CRLF', () => {
  const f = fixture();
  try {
    const text =
      '// original\r\n{\r\n  "unknown": {"keep":true},\r\n  "mcpServers": {\r\n    // untouched\r\n    "other": {"type":"stdio","command":"/bin/true","env":{"LANG":"C"},"future":7}\r\n  }\r\n}\r\n';
    writeFileSync(f.user, text, { mode: 0o600 });
    f.mutate({ kind: 'add', scope: 'user', name: 'new', entry: http });
    const changed = readFileSync(f.user, 'utf8');
    expect(changed).toContain('// original\r\n');
    expect(changed).toContain('// untouched\r\n');
    expect(changed).toContain(
      '"other": {"type":"stdio","command":"/bin/true","env":{"LANG":"C"},"future":7}',
    );
    expect(changed).toContain('"unknown": {"keep":true}');
    expect(changed.replaceAll('\r\n', '')).not.toContain('\n');
  } finally {
    f.close();
  }
});

test('all canonical locks and complete read-set drift reject before publication', () => {
  const f = fixture();
  try {
    f.put(f.user, { mcpServers: {} });
    f.put(f.project, { mcpServers: {} });
    const old = readFileSync(f.user),
      expected = readMcpSources(f.options).readSet;
    for (const path of [
      f.user,
      f.project,
      join(f.options.profilePath, 'mcp-approvals.json'),
      join(f.options.profilePath, 'mcp-auth-bindings.json'),
    ]) {
      const lock = acquireFileLock(`${path}.lock`, 'exclusive');
      try {
        expect(() => f.mutate({ kind: 'add', scope: 'user', name: 'local', entry: http })).toThrow(
          'mcp_source_busy',
        );
      } finally {
        lock.release();
      }
    }
    expect(() =>
      writeMcpSourceEntry({
        ...f.options,
        expectedReadSet: expected,
        mutation: { kind: 'add', scope: 'user', name: 'local', entry: http },
        operationId: 'op',
        validatePublication() {
          f.put(f.project, { mcpServers: { late: http } });
        },
      }),
    ).toThrow('mcp_source_conflict');
    expect(readFileSync(f.user)).toEqual(old);
    expect(() =>
      writeMcpSourceEntry({
        ...f.options,
        expectedReadSet: readMcpSources(f.options).readSet,
        mutation: { kind: 'add', scope: 'user', name: 'local', entry: http },
        operationId: 'op',
        validatePublication() {
          throw Error('closed authorization');
        },
      }),
    ).toThrow('mcp_source_unavailable');
    expect(readFileSync(f.user)).toEqual(old);
  } finally {
    f.close();
  }
});

test('postpublication reply loss is unknown, exact bytes exist and old read-set cannot retry', () => {
  const f = fixture();
  try {
    const expected = readMcpSources(f.options).readSet;
    const input = {
      ...f.options,
      expectedReadSet: expected,
      mutation: { kind: 'add', scope: 'user', name: 'local', entry: http } as const,
      operationId: 'op',
      validatePublication() {},
    };
    expect(() =>
      writeMcpSourceEntry({
        ...input,
        afterPublication() {
          throw Error('reply lost');
        },
      }),
    ).toThrow('mcp_source_publication_unknown');
    expect(readMcpSources(f.options).entries[0]!.raw).toMatchObject({
      _kiteSourceCreation: { operationId: 'op' },
    });
    const saved = readFileSync(f.user);
    expect(() => writeMcpSourceEntry(input)).toThrow('mcp_source_conflict');
    expect(readFileSync(f.user)).toEqual(saved);
  } finally {
    f.close();
  }
});

for (const window of ['after-rename', 'successful-publication', 'before-publication'] as const)
  test(`Source ${window} with release failure preserves publication classification and attempts every real lock`, async () => {
    const f = fixture();
    try {
      f.put(f.user, { mcpServers: {} });
      f.put(f.project, { mcpServers: {} });
      const sourceModule = fileURLToPath(
        new URL('../../../src/config/mcp-sources.ts', import.meta.url),
      );
      const lockModule = fileURLToPath(new URL('../../../src/platform/locks.ts', import.meta.url));
      const errorModule = fileURLToPath(new URL('../../../src/config/types.ts', import.meta.url));
      // Child module isolation keeps fault wrappers out of normal readers and every neighboring test.
      // Every acquired lock and every file mutation below is real; only failures after real close,
      // or the directory fsync after the real rename, are injected.
      const program = `
        import { mock } from 'bun:test';
        const fs = await import('node:fs');
        const actualRename = fs.renameSync, actualSync = fs.fsyncSync, actualStat = fs.fstatSync;
        const locks = await import(${JSON.stringify(lockModule)});
        const actualAcquire = locks.acquireFileLock, actualAssert = locks.assertLiveLock;
        const {ConfigurationError} = await import(${JSON.stringify(errorModule)});
        const options = ${JSON.stringify(f.options)};
        const window = ${JSON.stringify(window)};
        const acquired = [], originals = new WeakMap();
        let published = false, releaseAttempts = 0, callbackCalls = 0, validationCalls = 0;
        mock.module(${JSON.stringify(lockModule)}, () => ({
          ...locks,
          acquireFileLock(...args) {
            const original = actualAcquire(...args);
            acquired.push(original);
            const proxy = {path: original.path, mode: original.mode, release() {
                releaseAttempts++;
                original.release();
                if (releaseAttempts === 1) throw Error('owned_lock_release_after_close');
              }
            };
            originals.set(proxy, original);
            return proxy;
          },
          assertLiveLock(lock, ...args) { return actualAssert(originals.get(lock) ?? lock, ...args); },
        }));
        mock.module('node:fs', () => ({
          ...fs,
          renameSync(...args) { actualRename(...args); published = true; },
          fsyncSync(fd) {
            if (window === 'after-rename' && published && actualStat(fd).isDirectory())
              throw Error('owned_directory_sync_failure');
            return actualSync(fd);
          },
        }));
        const {readMcpSources, writeMcpSourceEntry} = await import(${JSON.stringify(sourceModule)});
        const before = fs.readFileSync(options.profilePath + '/mcp.json');
        let code = null, receipt = null;
        try {
          receipt = writeMcpSourceEntry({
            ...options,
            expectedReadSet: readMcpSources(options).readSet,
            mutation: {kind:'add',scope:'user',name:'local',entry:{type:'http',url:'https://example.test/mcp'}},
            operationId:'release-fault',
            validatePublication() {
              validationCalls++;
              if (window === 'before-publication') throw new ConfigurationError('mcp_source_conflict');
            },
            afterPublication() { callbackCalls++; },
          });
        } catch (error) { code = error instanceof ConfigurationError ? error.code : 'unclassified_release_error'; }
        let reacquired = 0;
        try {
          for (const lock of acquired) {
            try { const check = actualAcquire(lock.path, 'exclusive'); check.release(); reacquired++; }
            catch { /* Actual lock remains held: report it, never repair the observation. */ }
          }
          const after = fs.readFileSync(options.profilePath + '/mcp.json');
          const value = JSON.parse(after.toString());
          console.log(JSON.stringify({
            code, receiptReturned: receipt !== null, acquired: acquired.length,
            releaseAttempts, reacquired, published, callbackCalls, validationCalls,
            bytesUnchanged: before.equals(after),
            actualMarker: value.mcpServers.local?._kiteSourceCreation ?? null,
          }));
        } finally { for (const lock of acquired) lock.release(); }
      `;
      const child = Bun.spawn([process.execPath, '--eval', program], {
        cwd: f.base,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe('');
      expect(exit).toBe(0);
      const fact = JSON.parse(stdout);
      expect(fact.code).toBe(
        window === 'before-publication' ? 'mcp_source_conflict' : 'mcp_source_publication_unknown',
      );
      expect(fact.receiptReturned).toBe(false);
      expect(fact.acquired).toBe(4);
      expect(fact.releaseAttempts).toBe(4);
      expect(fact.reacquired).toBe(4);
      expect(fact.validationCalls).toBe(1);
      expect(fact.callbackCalls).toBe(window === 'successful-publication' ? 1 : 0);
      expect(fact.published).toBe(window !== 'before-publication');
      expect(fact.bytesUnchanged).toBe(window === 'before-publication');
      expect(fact.actualMarker).toEqual(
        window === 'before-publication' ? null : { version: 1, operationId: 'release-fault' },
      );
    } finally {
      f.close();
    }
  }, 10000);

test('user, approval, binding and explicit variable changes each invalidate final Source publication', () => {
  for (const fact of ['user', 'approval', 'binding', 'variables'] as const) {
    const f = fixture();
    try {
      f.put(f.project, { mcpServers: {} });
      const original = readFileSync(f.project);
      const variables = { LANG: 'C' };
      f.options.variables = variables;
      const expectedReadSet = readMcpSources(f.options).readSet;
      expect(() =>
        writeMcpSourceEntry({
          ...f.options,
          expectedReadSet,
          operationId: 'op',
          mutation: { kind: 'add', scope: 'workspace', name: 'local', entry: http },
          validatePublication() {
            if (fact === 'variables') variables.LANG = 'changed';
            else
              f.put(
                fact === 'user'
                  ? f.user
                  : join(
                      f.options.profilePath,
                      fact === 'approval' ? 'mcp-approvals.json' : 'mcp-auth-bindings.json',
                    ),
                { future: fact },
              );
          },
        }),
      ).toThrow('mcp_source_conflict');
      expect(readFileSync(f.project)).toEqual(original);
      expect(readMcpSources(f.options).registry.servers).toEqual([]);
    } finally {
      f.close();
    }
  }
});

test('invalid UTF8, symlink, hardlink and root replacement refuse writes', () => {
  const f = fixture();
  try {
    writeFileSync(f.user, Buffer.from([255]), { mode: 0o600 });
    expect(() => f.mutate({ kind: 'add', scope: 'user', name: 'x', entry: http })).toThrow(
      'mcp_source_unavailable',
    );
    rmSync(f.user);
    f.put(join(f.base, 'foreign'), {});
    symlinkSync(join(f.base, 'foreign'), f.user);
    expect(() => f.mutate({ kind: 'add', scope: 'user', name: 'x', entry: http })).toThrow(
      'mcp_source_unavailable',
    );
    rmSync(f.user);
    linkSync(join(f.base, 'foreign'), f.user);
    expect(() => f.mutate({ kind: 'add', scope: 'user', name: 'x', entry: http })).toThrow(
      'mcp_source_unavailable',
    );
    rmSync(f.user);
    f.put(f.project, { mcpServers: {} });
    const old = readFileSync(f.project),
      moved = join(f.base, 'moved');
    expect(() =>
      writeMcpSourceEntry({
        ...f.options,
        expectedReadSet: readMcpSources(f.options).readSet,
        mutation: { kind: 'add', scope: 'workspace', name: 'x', entry: http },
        operationId: 'op',
        validatePublication() {
          renameSync(f.options.workspacePath!, moved);
          mkdirSync(f.options.workspacePath!, { mode: 0o700 });
        },
      }),
    ).toThrow('mcp_source_conflict');
    expect(readFileSync(join(moved, '.kite-code', 'mcp.json'))).toEqual(old);
  } finally {
    f.close();
  }
});

test('Unicode, whitespace and empty source keys remove by original ID while public labels stay sanitized', () => {
  const f = fixture();
  try {
    for (const name of ['雪/private', ' \t hidden ', '']) {
      const untouched =
        '"other":{"type":"stdio","command":"/bin/true","env":{"LANG":"C"},"future":9}';
      writeFileSync(
        f.user,
        `// original\r\n{"keep":true,"mcpServers":{${JSON.stringify(name)}:${JSON.stringify(http)},${untouched}}}\r\n`,
        { mode: 0o600 },
      );
      const state = readMcpSources(f.options);
      const server = state.registry.servers.find((v) => v.name.startsWith('invalid-'))!;
      expect(server.name).not.toBe(name);
      const preview = readMcpSourceEntryPreview(f.options, {
        scope: 'user',
        serverId: server.id,
        expectedReadSet: state.readSet,
      });
      expect(preview.target.name).toBe(server.name);
      expect(preview.target.rawEntryDigest).toBe(server.rawEntryDigest);
      if (name) expect(JSON.stringify(preview)).not.toContain(JSON.stringify(name));
      const receipt = f.mutate({
        kind: 'remove',
        scope: 'user',
        serverId: server.id,
        expectedRawEntryDigest: server.rawEntryDigest,
      });
      expect(receipt.target).toEqual(preview.target);
      const text = readFileSync(f.user, 'utf8');
      expect(text).toContain(untouched);
      expect(text).toContain('// original\r\n');
      expect(readMcpSources(f.options).registry.servers.map((v) => v.name)).toEqual(['other']);
    }
  } finally {
    f.close();
  }
});

test('two actual processes share Source locks and original CAS; at most one add publishes', async () => {
  const f = fixture();
  const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
  try {
    const expected = readMcpSources(f.options).readSet;
    const script = join(f.base, 'writer.ts'),
      go = join(f.base, 'go');
    writeFileSync(
      script,
      `import {existsSync,writeFileSync} from 'node:fs'; import {writeMcpSourceEntry} from ${JSON.stringify(import.meta.resolve('@kite-ai/agent/config'))};
      const name=process.argv[2]!;writeFileSync(${JSON.stringify(f.base)}+'/'+name+'.ready','ready');while(!existsSync(${JSON.stringify(go)}))await Bun.sleep(5);
      try{writeMcpSourceEntry({...${JSON.stringify(f.options)},expectedReadSet:${JSON.stringify(expected)},mutation:{kind:'add',scope:'user',name,entry:${JSON.stringify(http)}},operationId:name,validatePublication(){}});console.log('published')}catch(e){console.log(e instanceof Error?e.message:'error')}`,
      { mode: 0o600 },
    );
    for (const name of ['one', 'two'])
      children.push(
        Bun.spawn([process.execPath, script, name], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
    const deadline = Date.now() + 5000;
    while (!['one', 'two'].every((name) => existsSync(join(f.base, `${name}.ready`)))) {
      if (Date.now() > deadline) throw Error('writer_start_timeout');
      await Bun.sleep(5);
    }
    writeFileSync(go, 'go', { mode: 0o600 });
    const results = await Promise.all(
      children.map(async (p) => {
        const output = await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
        expect(await new Response(p.stderr).text()).toBe('');
        return output.trim();
      }),
    );
    expect(results.filter((v) => v === 'published')).toHaveLength(1);
    expect(
      results.filter((v) => ['mcp_source_busy', 'mcp_source_conflict'].includes(v)),
    ).toHaveLength(1);
    expect(readMcpSources(f.options).entries).toHaveLength(1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    f.close();
  }
}, 10000);
