import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigurationError,
  type CredentialBackend,
  createConfigurationSnapshot,
  createCredentialVault,
  createTemporaryCredentialBackend,
  readConfigurationFile,
  resolveConfiguration,
  updateConfigurationFile,
} from '@kite-ai/agent/config';

const create = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-config-')));
  return {
    root,
    path: join(root, 'kite-code.jsonc'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('a valid configured catalogue beyond legacy item quotas survives file read, merge and snapshot', () => {
  const f = create();
  try {
    const skills = Array.from({ length: 5001 }, (_, i) => ({
      id: `guide-${i}`,
      path: `skills/guide-${i}`,
    }));
    writeFileSync(f.path, JSON.stringify({ skills }));
    const effective = resolveConfiguration({
      defaults: {},
      user: readConfigurationFile({ path: f.path }).value,
      workspace: { skills: [{ id: 'guide-5000', enabled: false }] },
    });
    const snapshot = createConfigurationSnapshot(effective);
    expect(snapshot.configuration.skills).toHaveLength(5001);
    expect(snapshot.configuration.skills?.at(-1)).toEqual({
      id: 'guide-5000',
      path: 'skills/guide-5000',
      enabled: false,
    });
    expect(Object.isFrozen(snapshot.configuration.skills?.at(-1))).toBe(true);
    expect(() =>
      resolveConfiguration({ defaults: { skills: [...skills, { id: 'guide-5000' }] } }),
    ).toThrow('invalid_configuration');
  } finally {
    f.close();
  }
});

test('explicit four layer configuration has shallow top-level replacement, stable id merge, removal and disabling', () => {
  const result = resolveConfiguration({
    defaults: {
      modelId: 'first',
      models: [
        { id: 'first', provider: 'compatible', model: 'base', options: { a: 1, b: 2 } },
        { id: 'delete', provider: 'compatible', model: 'old' },
      ],
      tools: [{ id: 'shell', enabled: true }],
      array: [1, 2],
      nested: { x: 1, y: 2 },
      unknown: true,
    },
    user: { models: [{ id: 'first', options: { a: 3 } }] },
    workspace: {
      models: [{ id: 'delete', remove: true }],
      tools: [{ id: 'shell', enabled: false }],
      array: [3],
      nested: { x: 4 },
    },
    explicit: { modelId: 'first', models: [{ id: 'first', model: 'explicit' }] },
  });
  expect(result).toMatchObject({
    unknown: true,
    array: [3],
    nested: { x: 4 },
    tools: [{ id: 'shell', enabled: false }],
  });
  expect(result.models).toEqual([
    { id: 'first', provider: 'compatible', model: 'explicit', options: { a: 3 } },
  ]);
  expect(
    resolveConfiguration({
      defaults: { models: [{ id: 'a', provider: 'p', model: 'm' }] },
      user: { models: [{ id: 'a', remove: true }] },
      explicit: { models: [{ id: 'a', provider: 'p2', model: 'm2' }] },
    }).models,
  ).toEqual([{ id: 'a', provider: 'p2', model: 'm2' }]);
  expect(() => resolveConfiguration({ defaults: { tools: [{ id: 'a' }, { id: 'a' }] } })).toThrow(
    'invalid_configuration',
  );
});

test('actual call options and assembly facts are in an immutable digest snapshot while unknown fields and credential bodies are excluded', async () => {
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() });
  const ref = await vault.put('fixture-only-secret');
  const effective = resolveConfiguration({
    defaults: {
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'remote-name',
          baseURL: 'http://127.0.0.1:1234/v1',
          credentialRef: ref.id,
          options: { temperature: 0.25, reasoning: { effort: 'high' } },
          unknownModelField: 'do-not-persist',
        },
      ],
      tools: [{ id: 'tool', definitionVersion: '2', enabled: false, options: { limit: 2 } }],
      skills: [{ id: 'guide', path: '/trusted/guide', digest: 'actual-digest' }],
      mcp: [{ id: 'local', transport: 'stdio', command: 'harmless', args: ['--help'] }],
      unsupported: 'fixture-only-secret',
    },
  });
  const snapshot = createConfigurationSnapshot(effective);
  const before = JSON.stringify(snapshot);
  expect(snapshot.configuration.models?.[0]).toMatchObject({
    provider: 'compatible',
    model: 'remote-name',
    options: { temperature: 0.25, reasoning: { effort: 'high' } },
    credentialRef: ref.id,
  });
  expect(before).not.toContain('fixture-only-secret');
  expect(before).not.toContain('unknownModelField');
  expect(snapshot.configuration.tools?.[0]?.enabled).toBe(false);
  effective.models![0]!.options = { temperature: 1 };
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(Object.isFrozen(snapshot.configuration.models![0]!.options)).toBe(true);
  expect(createConfigurationSnapshot(effective).digest).not.toBe(snapshot.digest);
  for (const models of [
    [{ id: 'x', provider: 'p', model: 'm', options: { apiKey: 'fixture-only-secret' } }],
    [{ id: 'x', provider: 'p', model: 'm', baseURL: 'http://user:pass@localhost/v1' }],
    [{ id: 'x', provider: 'p', model: 'm', credentialRef: 'raw-secret' }],
  ])
    expect(() =>
      createConfigurationSnapshot(resolveConfiguration({ defaults: { models } })),
    ).toThrow('credential_reference_required');
});

test('real JSONC field set/remove preserves unrelated comments and unknown fields and IfMatch checks exact bytes', () => {
  const f = create();
  try {
    const source =
      '{\n // keep unrelated comment\n "unknown": { "future": true },\n "modelId": "old",\n "obsolete": 1,\n}\n';
    writeFileSync(f.path, source);
    const original = readConfigurationFile({ path: f.path });
    expect(original.etag).toBe(hash(source));
    const updated = updateConfigurationFile({
      path: f.path,
      ifMatch: original.etag,
      operations: [
        { kind: 'set', path: ['modelId'], value: 'new' },
        { kind: 'remove', path: ['obsolete'] },
      ],
    });
    expect(updated.value).toEqual({ unknown: { future: true }, modelId: 'new' });
    expect(readFileSync(f.path, 'utf8')).toContain('// keep unrelated comment');
    const latest = readFileSync(f.path, 'utf8');
    expect(() =>
      updateConfigurationFile({
        path: f.path,
        ifMatch: original.etag,
        operations: [{ kind: 'set', path: ['different'], value: true }],
      }),
    ).toThrow('configuration_conflict');
    expect(readFileSync(f.path, 'utf8')).toBe(latest);
    // Removing an override reveals the explicitly supplied lower layer, rather than mutating defaults.
    const removed = updateConfigurationFile({
      path: f.path,
      ifMatch: updated.etag,
      operations: [{ kind: 'remove', path: ['modelId'] }],
    });
    expect(
      resolveConfiguration({ defaults: { modelId: 'default' }, user: removed.value }).modelId,
    ).toBe('default');
  } finally {
    f.close();
  }
});

test('broken/duplicate JSONC is preserved, new credential bodies rejected, and symlinks/budgets fail locally', () => {
  const f = create();
  try {
    for (const text of ['{ broken', '{"a":1,"a":2}', '[]', '']) {
      writeFileSync(f.path, text);
      expect(() => readConfigurationFile({ path: f.path })).toThrow('invalid_jsonc');
      expect(() =>
        updateConfigurationFile({
          path: f.path,
          ifMatch: hash(text),
          operations: [{ kind: 'set', path: ['a'], value: 3 }],
        }),
      ).toThrow('invalid_jsonc');
      expect(readFileSync(f.path, 'utf8')).toBe(text);
    }
    writeFileSync(f.path, '{}');
    const current = readConfigurationFile({ path: f.path });
    expect(() =>
      updateConfigurationFile({
        path: f.path,
        ifMatch: current.etag,
        operations: [{ kind: 'set', path: ['models', 0, 'apiKey'], value: 'no-plaintext' }],
      }),
    ).toThrow('credential_reference_required');
    expect(() => readConfigurationFile({ path: f.path, maxBytes: 1 })).toThrow(
      'configuration_limit',
    );
    const target = join(f.root, 'target');
    writeFileSync(target, '{}');
    rmSync(f.path);
    symlinkSync(target, f.path);
    expect(() => readConfigurationFile({ path: f.path })).toThrow('configuration_path_unsafe');
    expect(readFileSync(target, 'utf8')).toBe('{}');
  } finally {
    f.close();
  }
});

test('absent configuration read creates nothing and atomic update creates only the explicit chosen file', () => {
  const f = create();
  try {
    const original = readConfigurationFile({ path: f.path });
    expect(original.exists).toBe(false);
    expect(existsSync(f.path)).toBe(false);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    const updated = updateConfigurationFile({
      path: f.path,
      ifMatch: original.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: null }],
    });
    expect(updated.exists).toBe(true);
    expect(updated.value).toEqual({ modelId: null });
  } finally {
    f.close();
  }
});

test('two actual processes reject stale field CAS and a fresh edit preserves both fields and comments', async () => {
  const f = create();
  try {
    writeFileSync(f.path, '{ // preserved\n"unknown": 7\n}');
    const original = readConfigurationFile({ path: f.path });
    const launch = (key: string) =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'config-child.ts'),
          'cas',
          f.path,
          original.etag,
          key,
        ],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
    const a = launch('fieldA');
    const b = launch('fieldB');
    a.stdin.end();
    b.stdin.end();
    const outputs = await Promise.all([
      new Response(a.stdout).json(),
      new Response(b.stdout).json(),
    ]);
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    expect(outputs.filter((item) => item.status === 'ok')).toHaveLength(1);
    expect(outputs.filter((item) => item.status === 'failed')[0].code).toMatch(
      /^configuration_(conflict|busy)$/,
    );
    const winner = readConfigurationFile({ path: f.path });
    const missing = winner.value.fieldA === undefined ? 'fieldA' : 'fieldB';
    const final = updateConfigurationFile({
      path: f.path,
      ifMatch: winner.etag,
      operations: [{ kind: 'set', path: [missing], value: missing }],
    });
    expect(final.value).toEqual({ unknown: 7, fieldA: 'fieldA', fieldB: 'fieldB' });
    expect(readFileSync(f.path, 'utf8')).toContain('// preserved');
  } finally {
    f.close();
  }
});

test.skipIf(process.platform === 'win32')(
  'real child-held OS lock prevents publication until EOF releases it',
  async () => {
    const f = create();
    try {
      writeFileSync(f.path, '{}');
      const original = readConfigurationFile({ path: f.path });
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, 'config-child.ts'), 'hold', f.path],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
      try {
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe('locked\n');
        expect(() =>
          updateConfigurationFile({
            path: f.path,
            ifMatch: original.etag,
            operations: [{ kind: 'set', path: ['value'], value: 1 }],
          }),
        ).toThrow('configuration_busy');
        expect(readFileSync(f.path, 'utf8')).toBe('{}');
        child.stdin.end();
        expect(await child.exited).toBe(0);
        reader.releaseLock();
        expect(
          updateConfigurationFile({
            path: f.path,
            ifMatch: original.etag,
            operations: [{ kind: 'set', path: ['value'], value: 1 }],
          }).value,
        ).toEqual({ value: 1 });
      } finally {
        child.stdin.end();
        await child.exited;
      }
    } finally {
      f.close();
    }
  },
);

test('temporary credential revocation blocks future reads and restart cannot retrieve its body', async () => {
  const backend = createTemporaryCredentialBackend();
  const vault = createCredentialVault({ backend });
  const ref = await vault.put('only-temporary-secret');
  const alreadyResolved = await vault.resolve(ref);
  expect(alreadyResolved).toBe('only-temporary-secret');
  expect(JSON.stringify(ref)).not.toContain(alreadyResolved);
  await vault.revoke(ref);
  await expect(vault.resolve(ref)).rejects.toThrow('credential_revoked');
  expect(alreadyResolved).toBe('only-temporary-secret');
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'config-child.ts'), 'credential', ref.id],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await new Response(child.stdout).json()).toEqual({ code: 'credential_unavailable' });
  expect(await child.exited).toBe(0);
  await expect(
    createCredentialVault({ backend: createTemporaryCredentialBackend() }).resolve(ref),
  ).rejects.toThrow('credential_unavailable');
});

test('revocation wins over in-flight resolution and backend errors expose no body', async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  const backend: CredentialBackend = {
    kind: 'temporary',
    async put() {},
    async resolve() {
      return pending;
    },
    async remove() {
      throw new Error('leaky-fixture-secret');
    },
  };
  const vault = createCredentialVault({ backend });
  const ref = await vault.put('leaky-fixture-secret');
  const lookup = vault.resolve(ref);
  await expect(vault.revoke(ref)).rejects.toThrow('credential_unavailable');
  resolve('leaky-fixture-secret');
  await expect(lookup).rejects.toThrow('credential_revoked');
  await expect(vault.resolve(ref)).rejects.toThrow('credential_revoked');
  await expect(createCredentialVault().put('fixture')).rejects.toThrow('credential_unavailable');
});

test('OS backend uses explicit namespaces and lazy injected native entry operations without initializing a real keychain', async () => {
  const { createOsCredentialBackend } = await import('@kite-ai/agent/config');
  const values = new Map<string, string>();
  const identities: { service: string; account: string }[] = [];
  const backend = createOsCredentialBackend({
    service: 'kite-test',
    accountNamespace: 'disposable-profile',
    nativeFactory(service, account) {
      identities.push({ service, account });
      return {
        async setPassword(secret) {
          values.set(account, secret);
        },
        async getPassword() {
          return values.get(account);
        },
        async deleteCredential() {
          return values.delete(account);
        },
      };
    },
  });
  expect(identities).toHaveLength(0);
  const vault = createCredentialVault({ backend });
  const ref = await vault.put('private-native-fixture');
  expect(ref.persistence).toBe('os');
  expect(identities[0]).toEqual({ service: 'kite-test', account: `disposable-profile/${ref.id}` });
  expect(await vault.resolve(ref.id)).toBe('private-native-fixture');
  await vault.revoke(ref.id);
  await expect(vault.resolve(ref.id)).rejects.toThrow('credential_revoked');
  expect(values.size).toBe(0);
  await expect(createCredentialVault({ backend }).resolve(ref.id)).rejects.toThrow(
    'credential_unavailable',
  );
  expect(JSON.stringify(identities)).not.toContain('private-native-fixture');
  expect(() => createOsCredentialBackend({ service: '', accountNamespace: 'x' })).toThrow(
    'invalid_credential_namespace',
  );
});

test('OS backend load/store/read/delete failures are local sanitized failures and never select plaintext fallback', async () => {
  const { createOsCredentialBackend } = await import('@kite-ai/agent/config');
  const ref = { id: 'credential:11111111-1111-4111-8111-111111111111', persistence: 'os' as const };
  const unavailable = createOsCredentialBackend({
    service: 'fixture',
    accountNamespace: 'scope',
    nativeFactory() {
      throw new Error('native-fixture-secret');
    },
  });
  await expect(
    createCredentialVault({ backend: unavailable }).put('native-fixture-secret'),
  ).rejects.toThrow('credential_unavailable');
  const failing = createOsCredentialBackend({
    service: 'fixture',
    accountNamespace: 'scope',
    nativeFactory() {
      return {
        async setPassword() {
          throw new Error('native-fixture-secret');
        },
        async getPassword() {
          throw new Error('native-fixture-secret');
        },
        async deleteCredential() {
          throw new Error('native-fixture-secret');
        },
      };
    },
  });
  const vault = createCredentialVault({ backend: failing });
  for (const pending of [
    vault.put('native-fixture-secret'),
    vault.resolve(ref),
    vault.revoke(ref),
  ]) {
    try {
      await pending;
      throw new Error('fixture_expected_rejection');
    } catch (error) {
      expect(String(error)).toBe('Error: credential_unavailable');
      expect(String(error)).not.toContain('native-fixture-secret');
    }
  }
});

test('explicit invalid JSONC repair checks the exact ETag, preserves private original bytes, and does not replace a valid document', async () => {
  const { inspectConfigurationFile, repairConfigurationFile } = await import(
    '@kite-ai/agent/config'
  );
  const { statSync, readdirSync } = await import('node:fs');
  const f = create();
  try {
    const broken =
      '\ufeff{ // broken private fixture text\n "apiKey": "synthetic-private-original",';
    writeFileSync(f.path, broken);
    const inspected = inspectConfigurationFile({ path: f.path });
    expect(inspected.value).toBeNull();
    expect(inspected.error).toBe('invalid_jsonc');
    expect(inspected.etag).toBe(hash(broken));
    expect(() =>
      repairConfigurationFile({ path: f.path, ifMatch: hash('other'), value: { modelId: null } }),
    ).toThrow('configuration_conflict');
    expect(readFileSync(f.path, 'utf8')).toBe(broken);
    const repaired = repairConfigurationFile({
      path: f.path,
      ifMatch: inspected.etag,
      value: { modelId: null, models: [] },
    });
    expect(repaired.value).toEqual({ modelId: null, models: [] });
    expect(repaired.backupRef).toBe(`sha256:${hash(broken)}`);
    const directory = join(f.root, '.config-repair-backups');
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const backup = join(directory, files[0]!);
    expect(readFileSync(backup, 'utf8')).toBe(broken);
    expect(statSync(backup).mode & 0o077).toBe(0);
    expect(() =>
      repairConfigurationFile({ path: f.path, ifMatch: repaired.etag, value: {} }),
    ).toThrow('configuration_repair_not_required');
  } finally {
    f.close();
  }
});

test('trusted candidate/publication checks run under the target lock and reject a changed non-target read before publishing', () => {
  const f = create();
  try {
    writeFileSync(f.path, '// original\n{"modelId":"a"}\n');
    const other = join(f.root, 'other.jsonc');
    writeFileSync(other, '{"modelId":"a"}');
    const original = readConfigurationFile({ path: f.path });
    const readSet = readConfigurationFile({ path: other });
    let candidateCalls = 0,
      publicationCalls = 0;
    expect(() =>
      updateConfigurationFile({
        path: f.path,
        ifMatch: original.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: 'b' }],
        validateCandidate(candidate) {
          candidateCalls++;
          expect(candidate.modelId).toBe('b');
          expect(() =>
            updateConfigurationFile({
              path: f.path,
              ifMatch: original.etag,
              operations: [{ kind: 'set', path: ['modelId'], value: 'c' }],
            }),
          ).toThrow('configuration_busy');
          writeFileSync(other, '{"modelId":"changed-by-another-editor"}');
        },
        validatePublication() {
          publicationCalls++;
          if (readConfigurationFile({ path: other }).etag !== readSet.etag)
            throw new ConfigurationError('configuration_conflict');
        },
      }),
    ).toThrow('configuration_conflict');
    expect(readFileSync(f.path, 'utf8')).toBe('// original\n{"modelId":"a"}\n');
    expect(candidateCalls).toBe(1);
    expect(publicationCalls).toBe(1);
  } finally {
    f.close();
  }
});
