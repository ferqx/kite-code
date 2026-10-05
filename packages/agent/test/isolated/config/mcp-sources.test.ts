import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import {
  type McpSourceApproval,
  type McpSourceCredentialBinding,
  type McpSourceOptions,
  readMcpSources,
  writeMcpSourceMetadata,
} from '@kite-ai/agent/config';
import { acquireFileLock } from '../../../src/platform/locks';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-source-')));
  const profilePath = join(base, 'profile');
  const workspacePath = join(base, 'workspace');
  mkdirSync(profilePath, { mode: 0o700 });
  mkdirSync(workspacePath, { mode: 0o700 });
  const options: McpSourceOptions = {
    profilePath,
    workspacePath,
    scope: {
      profileId: 'profile',
      storeId: 'store',
      sessionId: 'session-a',
      workspaceId: 'workspace',
    },
    now: () => 100,
  };
  const user = join(profilePath, 'mcp.json');
  const project = join(workspacePath, '.kite-code', 'mcp.json');
  return {
    base,
    options,
    user,
    project,
    put(path: string, value: unknown) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(value));
    },
    close() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
const source = { type: 'http', url: 'https://example.test/mcp', auth: { type: 'none' } };
const reference = (name: string) => ['$', '{', name, '}'].join('');
const proof = {
  decisionId: 'decision',
  storeId: 'store',
  sessionId: 'session-a',
  interactionId: 'interaction',
  acceptedRevision: '1',
  subjectId: 'user',
  requestDigest: 'a'.repeat(64),
  recordedAt: 100,
};
function approve(options: McpSourceOptions, decision: 'approved' | 'rejected' = 'approved') {
  const state = readMcpSources(options);
  const value: McpSourceApproval = {
    ...state.entries[0]!.binding!,
    kind: 'mcp_source_approval',
    decision,
    proof,
  };
  return writeMcpSourceMetadata({
    ...options,
    expectedReadSet: state.readSet,
    value,
    validateDecision: () => true,
  });
}

test('no sources creates no files/locks, registry is safe and private captures immutable', () => {
  const f = fixture();
  try {
    expect(readMcpSources(f.options).registry.servers).toEqual([]);
    expect(existsSync(join(f.options.workspacePath!, '.kite-code'))).toBe(false);
    expect(existsSync(`${f.user}.lock`)).toBe(false);
    f.put(f.user, {
      mcpServers: { 'private.name': { ...source, unknown: { password: 'body-secret' } } },
    });
    const state = readMcpSources(f.options);
    expect(state.registry.servers[0]!.admitted).toBe(true);
    expect(JSON.stringify(state.registry)).not.toContain('example.test');
    expect(JSON.stringify(state.registry)).not.toContain('body-secret');
    expect(state.entries[0]!.raw).toMatchObject({ unknown: { password: 'body-secret' } });
    expect(Object.isFrozen(state.entries[0]!.raw)).toBe(true);
    expect(state.user.etag).toBe(createHash('sha256').update(readFileSync(f.user)).digest('hex'));
    const old = state.entries[0]!.server.rawEntryDigest;
    f.put(f.user, {
      mcpServers: { 'private.name': { ...source, unknown: { password: 'changed' } } },
    });
    expect(readMcpSources(f.options).entries[0]!.server.rawEntryDigest).not.toBe(old);
    expect(state.entries[0]!.server.rawEntryDigest).toBe(old);
  } finally {
    f.close();
  }
});

test('every project entry shadows user; approval does not connect and preserves comments/unknown', () => {
  const f = fixture();
  try {
    f.put(f.user, { mcpServers: { local: source } });
    for (const raw of [{ ...source, enabled: false }, 1, source]) {
      f.put(f.project, { mcpServers: { local: raw } });
      const state = readMcpSources(f.options);
      expect(state.registry.servers).toHaveLength(1);
      expect(state.registry.servers[0]!.source.kind).toBe('workspace');
      expect(state.registry.servers[0]!.admitted).toBe(false);
    }
    const path = join(f.options.profilePath, 'mcp-approvals.json');
    writeFileSync(path, '{ // keep-comment\n "unknown": {"x":1}, "records": {} }');
    approve(f.options, 'rejected');
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_project_approval_rejected',
    );
    approve(f.options);
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('keep-comment');
    expect(readMcpSources(f.options).approvals.value).toMatchObject({ unknown: { x: 1 } });
    expect(readFileSync(f.project, 'utf8')).toContain('example.test');
  } finally {
    f.close();
  }
});

test('malformed/unsafe project source blocks user fallback; bad unrelated server is local', () => {
  const f = fixture();
  try {
    f.put(f.user, { mcpServers: { local: source, other: { type: 'http', url: 'bad-url' } } });
    f.put(f.project, {});
    writeFileSync(f.project, '{ bad secret text');
    let state = readMcpSources(f.options);
    expect(state.registry.errors.workspace).toBe('mcp_source_invalid');
    expect(state.registry.servers.every((server) => !server.admitted)).toBe(true);
    expect(JSON.stringify(state.registry)).not.toContain('secret text');
    rmSync(f.project);
    symlinkSync(f.user, f.project);
    state = readMcpSources(f.options);
    expect(state.registry.errors.workspace).toBe('mcp_source_path_unsafe');
    expect(state.registry.servers[0]!.admitted).toBe(false);
    rmSync(f.project);
    state = readMcpSources(f.options);
    expect(state.registry.servers[0]!.admitted).toBe(true);
    expect(state.registry.servers[1]!.reason).toBe('mcp_server_invalid');
  } finally {
    f.close();
  }
});

test('variable supply is explicit: no ambient/default/empty substitution, no inherited env', () => {
  const f = fixture();
  const old = process.env.KITE_MCP_SOURCE_TEST;
  try {
    process.env.KITE_MCP_SOURCE_TEST = '/ambient/private';
    f.put(f.user, {
      mcpServers: {
        local: {
          type: 'stdio',
          command: reference('KITE_MCP_SOURCE_TEST'),
          args: [reference('ARG')],
          env: { SAFE: reference('ARG') },
        },
      },
    });
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe('mcp_variable_unavailable');
    const supplied = {
      ...f.options,
      variables: { KITE_MCP_SOURCE_TEST: '/usr/bin/true', ARG: 'a' },
    };
    const state = readMcpSources(supplied);
    expect(state.registry.servers[0]!.admitted).toBe(true);
    expect(state.entries[0]!.transport).toMatchObject({
      command: '/usr/bin/true',
      args: ['a'],
      env: { SAFE: 'a' },
    });
    expect(JSON.stringify(state.entries)).not.toContain('/ambient/private');
    expect(
      readMcpSources({ ...supplied, variables: { ...supplied.variables, ARG: 'b' } }).registry
        .servers[0]!.transportDigest,
    ).not.toBe(state.registry.servers[0]!.transportDigest);
    expect(() => readMcpSources({ ...supplied, variables: { ARG: '' } })).toThrow(
      'mcp_variables_invalid',
    );
    f.put(f.user, {
      mcpServers: { local: { type: 'stdio', command: reference('MISSING:-/usr/bin/true') } },
    });
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe('mcp_variable_unavailable');
    f.put(f.user, {
      mcpServers: {
        local: { type: 'stdio', command: '/usr/bin/true', env: { API_TOKEN: 'secret' } },
      },
    });
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_environment_unavailable',
    );
  } finally {
    if (old === undefined) delete process.env.KITE_MCP_SOURCE_TEST;
    else process.env.KITE_MCP_SOURCE_TEST = old;
    f.close();
  }
});

test('persistent approval reuses same Workspace in next Session; changed source/Store/root invalidates', () => {
  const f = fixture();
  try {
    f.put(f.project, { mcpServers: { local: source } });
    approve(f.options);
    const state = readMcpSources(f.options);
    const next = readMcpSources({
      ...f.options,
      scope: { ...f.options.scope, sessionId: 'session-b' },
    });
    expect(next.registry.servers[0]!.admitted).toBe(true);
    expect(next.entries[0]!.binding).toEqual(state.entries[0]!.binding);
    expect(next.registry.revision).not.toBe(state.registry.revision);
    expect(next.approvals.value).toMatchObject({
      records: { [Object.keys(next.approvals.value!.records as object)[0]!]: { proof } },
    });
    expect(
      readMcpSources({ ...f.options, scope: { ...f.options.scope, storeId: 'new-store' } }).registry
        .servers[0]!.reason,
    ).toBe('mcp_project_approval_pending');
    f.put(f.project, { mcpServers: { local: { ...source, unknown: true } } });
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_project_approval_pending',
    );
    const moved = join(f.base, 'moved');
    mkdirSync(moved);
    mkdirSync(join(moved, '.kite-code'));
    f.put(join(moved, '.kite-code', 'mcp.json'), { mcpServers: { local: source } });
    expect(readMcpSources({ ...f.options, workspacePath: moved }).registry.servers[0]!.reason).toBe(
      'mcp_project_approval_pending',
    );
    f.put(f.project, { mcpServers: { local: source } });
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(true);
    renameSync(f.options.workspacePath!, join(f.base, 'old-workspace'));
    mkdirSync(f.options.workspacePath!);
    f.put(f.project, { mcpServers: { local: source } });
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_project_approval_pending',
    );
  } finally {
    f.close();
  }
});

test('auth refs are not grants; exact opaque Bearer binding, expiry/revocation, unsupported auth zero vault IO', () => {
  const f = fixture();
  try {
    const ref = 'credential:00000000-0000-0000-0000-000000000001';
    f.put(f.user, {
      mcpServers: { local: { ...source, auth: { type: 'credential', credentialRef: ref } } },
    });
    let state = readMcpSources(f.options);
    expect(state.registry.servers[0]!.reason).toBe('mcp_credential_binding_required');
    let value: McpSourceCredentialBinding = {
      ...state.entries[0]!.binding!,
      kind: 'mcp_credential_binding',
      authProfile: 'default',
      purpose: 'mcp.http',
      vaultRef: ref,
      expiresAt: 200,
      revoked: false,
      proof,
    };
    writeMcpSourceMetadata({
      ...f.options,
      value,
      expectedReadSet: state.readSet,
      validateDecision: () => true,
    });
    state = readMcpSources(f.options);
    expect(state.registry.servers[0]!.admitted).toBe(true);
    expect(JSON.stringify(state.registry)).not.toContain(ref);
    expect(readMcpSources({ ...f.options, now: () => 200 }).registry.servers[0]!.reason).toBe(
      'mcp_credential_binding_expired',
    );
    expect(readMcpSources({ ...f.options, now: () => NaN }).registry.servers[0]!.reason).toBe(
      'mcp_credential_clock_unavailable',
    );
    value = { ...value, revoked: true };
    writeMcpSourceMetadata({
      ...f.options,
      value,
      expectedReadSet: state.readSet,
      validateDecision: () => true,
    });
    expect(readMcpSources(f.options).registry.servers[0]!.reason).toBe(
      'mcp_credential_binding_revoked',
    );
    for (const auth of [
      { type: 'oauth', clientSecretRef: 'named-profile' },
      { type: 'credential', credentialRef: 'named-profile' },
      { type: 'credential', credentialRef: ref, header: 'X-Key' },
    ]) {
      f.put(f.user, { mcpServers: { local: { ...source, auth } } });
      expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(false);
    }
    f.put(f.user, {
      mcpServers: {
        local: {
          ...source,
          auth: { type: 'oauth', clientId: 'fixed-client', scopes: ['tools.read'] },
        },
      },
    });
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(true);
    expect(readMcpSources(f.options).entries[0]!.transport!.auth).toEqual({
      type: 'oauth',
      profile: 'oauth',
      clientId: 'fixed-client',
      scopes: ['tools.read'],
    });
    state = readMcpSources(f.options);
    expect(state.registry.errors.binding).toBeNull();
    const path = join(f.options.profilePath, 'mcp-auth-bindings.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    Object.values(doc.records).forEach((entry) => {
      (entry as Record<string, unknown>).extra = 'not-closed';
    });
    f.put(path, doc);
    expect(readMcpSources(f.options).registry.errors.binding).toBe(
      'mcp_credential_binding_unavailable',
    );
  } finally {
    f.close();
  }
});

test('source/approval CAS and actual OS locks reject drift without metadata publication', () => {
  const f = fixture();
  try {
    f.put(f.project, { mcpServers: { local: source } });
    let state = readMcpSources(f.options);
    const value: McpSourceApproval = {
      ...state.entries[0]!.binding!,
      kind: 'mcp_source_approval',
      decision: 'approved',
      proof,
    };
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value,
        expectedReadSet: state.readSet,
        validateDecision: () => false,
      }),
    ).toThrow('mcp_source_decision_invalid');
    expect(existsSync(join(f.options.profilePath, 'mcp-approvals.json'))).toBe(false);
    const lock = acquireFileLock(`${f.project}.lock`, 'exclusive');
    try {
      expect(() =>
        writeMcpSourceMetadata({
          ...f.options,
          value,
          expectedReadSet: state.readSet,
          validateDecision: () => true,
        }),
      ).toThrow('mcp_source_busy');
    } finally {
      lock.release();
    }
    state = readMcpSources(f.options);
    let calls = 0;
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value,
        expectedReadSet: state.readSet,
        validateDecision: () => {
          if (++calls === 3)
            f.put(f.project, {
              mcpServers: { local: { ...source, url: 'https://changed.test/' } },
            });
          return true;
        },
      }),
    ).toThrow('mcp_source_conflict');
    expect(existsSync(join(f.options.profilePath, 'mcp-approvals.json'))).toBe(false);
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(false);
  } finally {
    f.close();
  }
});

test('exact metadata proof schema, wrong original scope and canonical lock set are checked', () => {
  const f = fixture();
  try {
    f.put(f.project, { mcpServers: { local: source } });
    const state = readMcpSources(f.options);
    const value: McpSourceApproval = {
      ...state.entries[0]!.binding!,
      kind: 'mcp_source_approval',
      decision: 'approved',
      proof,
    };
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value: { ...value, proof: { ...proof, sessionId: 'wrong' } },
        expectedReadSet: state.readSet,
        validateDecision: () => true,
      }),
    ).toThrow('mcp_source_decision_invalid');
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value: { ...value, proof: { ...proof, storeId: 'wrong' } },
        expectedReadSet: state.readSet,
        validateDecision: () => true,
      }),
    ).toThrow('mcp_source_decision_invalid');
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value: { ...value, proof: { ...proof, acceptedRevision: '0' } },
        expectedReadSet: state.readSet,
        validateDecision: () => true,
      }),
    ).toThrow('mcp_source_metadata_invalid');
    let validations = 0;
    writeMcpSourceMetadata({
      ...f.options,
      value,
      expectedReadSet: state.readSet,
      validateDecision: () => {
        if (++validations >= 2)
          for (const path of [f.user, f.project, state.approvals.path, state.bindings.path])
            expect(() => acquireFileLock(`${path}.lock`, 'exclusive')).toThrow('Lock is busy.');
        return true;
      },
    });
    expect(validations).toBe(3);
    expect(statSync(state.approvals.path).mode & 0o777).toBe(0o600);
  } finally {
    f.close();
  }
});

test('duplicate keys, invalid UTF8, hardlinks and directory redirection are local source failures', () => {
  const f = fixture();
  try {
    writeFileSync(f.user, '{"mcpServers":{"local":{},"local":{}}}');
    expect(readMcpSources(f.options).registry.errors.user).toBe('mcp_source_invalid');
    writeFileSync(f.user, Buffer.from([0xff]));
    expect(readMcpSources(f.options).registry.errors.user).toBe('mcp_source_invalid_utf8');
    expect(readMcpSources(f.options).user.etag).toBe(
      createHash('sha256')
        .update(Buffer.from([0xff]))
        .digest('hex'),
    );
    f.put(f.user, { mcpServers: { local: source } });
    linkSync(f.user, join(f.base, 'hardlink'));
    expect(readMcpSources(f.options).registry.errors.user).toBe('mcp_source_path_unsafe');
    rmSync(join(f.base, 'hardlink'));
    symlinkSync(f.options.profilePath, join(f.options.workspacePath!, '.kite-code'));
    expect(readMcpSources(f.options).registry.errors.workspace).toBe('mcp_source_path_unsafe');
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(false);
  } finally {
    f.close();
  }
});

test('publication receipt fault is unknown with original published proof and no automatic retry', () => {
  const f = fixture();
  try {
    f.put(f.project, { mcpServers: { local: source } });
    const state = readMcpSources(f.options);
    const value: McpSourceApproval = {
      ...state.entries[0]!.binding!,
      kind: 'mcp_source_approval',
      decision: 'approved',
      proof,
    };
    let calls = 0;
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value,
        expectedReadSet: state.readSet,
        validateDecision: () => true,
        afterPublication: () => {
          calls++;
          throw Error('receipt-fault');
        },
      }),
    ).toThrow('mcp_source_publication_unknown');
    const after = readMcpSources(f.options);
    expect(calls).toBe(1);
    expect(after.registry.servers[0]!.admitted).toBe(true);
    expect(after.approvals.value).toMatchObject({
      records: { [Object.keys(after.approvals.value!.records as object)[0]!]: value },
    });
    expect(() =>
      writeMcpSourceMetadata({
        ...f.options,
        value,
        expectedReadSet: state.readSet,
        validateDecision: () => true,
      }),
    ).toThrow('mcp_source_conflict');
  } finally {
    f.close();
  }
});

test('final publication checks user, approval, auth metadata and trusted variable drift separately', () => {
  for (const changed of ['user', 'approval', 'binding', 'variables'] as const) {
    const f = fixture();
    try {
      const variables = { HOST: 'example.test' };
      const options = { ...f.options, variables };
      f.put(f.project, {
        mcpServers: { local: { ...source, url: `https://${reference('HOST')}/mcp` } },
      });
      const state = readMcpSources(options);
      const value: McpSourceApproval = {
        ...state.entries[0]!.binding!,
        kind: 'mcp_source_approval',
        decision: 'approved',
        proof,
      };
      let calls = 0;
      expect(() =>
        writeMcpSourceMetadata({
          ...options,
          value,
          expectedReadSet: state.readSet,
          validateDecision: () => {
            if (++calls === 3) {
              if (changed === 'variables') variables.HOST = 'new.test';
              else
                f.put(
                  changed === 'user'
                    ? f.user
                    : changed === 'approval'
                      ? state.approvals.path
                      : state.bindings.path,
                  { unknown: 'external-edit' },
                );
            }
            return true;
          },
        }),
      ).toThrow('mcp_source_conflict');
      const current = readMcpSources(options);
      expect(current.registry.servers[0]!.admitted).toBe(false);
      expect(current.approvals.value?.records).toBeUndefined();
    } finally {
      f.close();
    }
  }
});

test('finite bytes, not aggregate catalogue quota: 5001 entries are retained', () => {
  const f = fixture();
  try {
    f.put(f.user, {
      mcpServers: Object.fromEntries(
        Array.from({ length: 5001 }, (_, i) => [`server${i}`, source]),
      ),
    });
    const state = readMcpSources(f.options);
    expect(state.registry.servers).toHaveLength(5001);
    expect(state.registry.servers.at(-1)!.admitted).toBe(true);
    expect(readMcpSources({ ...f.options, maxBytes: 10 }).registry.errors.user).toBe(
      'mcp_source_limit',
    );
  } finally {
    f.close();
  }
});

test('a separate real process holds source OS lock; two publishers share exact CAS with one winner', async () => {
  const f = fixture();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    f.put(f.project, { mcpServers: { local: source } });
    const locksModule = new URL('../../../src/platform/locks.ts', import.meta.url).href;
    const sourcesModule = new URL('../../../src/config/mcp-sources.ts', import.meta.url).href;
    const holder = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { acquireFileLock } from ${JSON.stringify(locksModule)};
      const lock = acquireFileLock(${JSON.stringify(`${f.project}.lock`)}, 'exclusive');
      await Bun.write(Bun.stdout, 'locked\\n');
      await new Response(Bun.stdin.stream()).text();
      lock.release();
    `,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    children.push(holder);
    const ready = holder.stdout.getReader();
    expect(new TextDecoder().decode((await ready.read()).value)).toBe('locked\n');
    ready.releaseLock();
    expect(() => approve(f.options)).toThrow('mcp_source_busy');
    expect(existsSync(join(f.options.profilePath, 'mcp-approvals.json'))).toBe(false);
    holder.stdin.end();
    expect(await holder.exited).toBe(0);
    const start = join(f.base, 'start');
    const code = `
      import { existsSync } from 'node:fs';
      import { readMcpSources, writeMcpSourceMetadata } from ${JSON.stringify(sourcesModule)};
      const options = ${JSON.stringify({ ...f.options, now: undefined })};
      const state = readMcpSources(options);
      const value = { ...state.entries[0].binding, kind:'mcp_source_approval', decision:'approved', proof:${JSON.stringify(proof)} };
      await Bun.write(Bun.stdout, 'ready\\n');
      while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(1);
      try { writeMcpSourceMetadata({ ...options, expectedReadSet:state.readSet, value, validateDecision:()=>true }); console.log('published'); }
      catch (error) { console.log(error.code); }
    `;
    const racers = [0, 1].map(() =>
      Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe' }),
    );
    children.push(...racers);
    const readers = racers.map((racer) => racer.stdout.getReader());
    for (const reader of readers) {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n');
    }
    writeFileSync(start, 'start');
    const outcomes = await Promise.all(
      racers.map(async (racer, index) => {
        let output = '';
        const reader = readers[index]!;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        expect(await racer.exited).toBe(0);
        expect(await new Response(racer.stderr).text()).toBe('');
        return output.trim();
      }),
    );
    expect(outcomes.filter((value) => value === 'published')).toHaveLength(1);
    expect(
      outcomes.filter((value) => ['mcp_source_busy', 'mcp_source_conflict'].includes(value)),
    ).toHaveLength(1);
    expect(readMcpSources(f.options).registry.servers[0]!.admitted).toBe(true);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    f.close();
  }
});
