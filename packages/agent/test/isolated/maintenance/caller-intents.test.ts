import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  inspectProfileRestore,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-caller-maintenance-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  const selected = selectProfile(profile);
  mkdirSync(join(selected.profilePath, 'ui'), { mode: 0o700 });
  const path = join(selected.profilePath, 'ui/caller-intents.json');
  return {
    root,
    profile,
    selected,
    path,
    storeId,
    destinationRoot: join(root, 'backups'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function row(kind: string, index = 0, storeId = 'original_store') {
  const content = 'original Café e\u0301\r\nquote " / slash \\ tail';
  const common = { kind, expectedStoreId: storeId, commandId: `original_${index}` };
  let request: Record<string, unknown>, target: Record<string, unknown>;
  if (kind === 'run.start') {
    request = {
      ...common,
      content,
      modelId: '',
      selectedSkills: ['OriginalSkill'],
      extensionInputs: [
        { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
      ],
    };
    target = { kind: 'session', id: 'original_session' };
  } else if (kind === 'input.steer') {
    request = {
      ...common,
      content,
      targetRunId: 'original_run',
      contextSelectionId: 'original_context',
    };
    target = { kind: 'run', id: 'original_run', contextSelectionId: 'original_context' };
  } else if (kind === 'input.follow_up') {
    request = {
      ...common,
      content,
      afterRunId: null,
      contextSelectionId: 'original_context',
      modelId: 'original_model',
      selectedSkills: [],
      extensionInputs: [],
    };
    target = { kind: 'after_run', id: null, contextSelectionId: 'original_context' };
  } else if (kind === 'command.cancel') {
    request = { ...common, targetCommandId: 'original_target_command' };
    target = { kind: 'command', id: 'original_target_command' };
  } else {
    request = { ...common, executionId: 'original_execution' };
    target = { kind: 'execution', id: 'original_execution' };
  }
  const bodyDigest = hash(canonicalJson(request as Json));
  const originalRequest = { ...request };
  delete originalRequest.expectedStoreId;
  delete originalRequest.commandId;
  return {
    intent: {
      scope: { storeId, workspaceId: 'original_workspace', sessionId: 'original_session' },
      request,
      target,
      subjectId: 'original_subject',
      bodyDigest,
      requestDigest: hash(canonicalJson(originalRequest as Json)),
      draft: { id: hash('draft'), revision: '9223372036854775807', textDigest: hash(content) },
    },
    phase: 'unknown',
  };
}
const kinds = ['run.start', 'input.steer', 'input.follow_up', 'command.cancel', 'execution.cancel'];
function write(path: string, records: ReturnType<typeof row>[]) {
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, records }, null, 2)}\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}
async function reject(work: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  if (code) expect((error as { code?: string }).code).toBe(code);
}

test('v5 retains the exact caller v1 request/Plan/draft/identity bytes through new-Store restore without retargeting', async () => {
  const f = await fixture();
  try {
    const records = kinds.map((kind, index) => row(kind, index, f.storeId));
    records[0]!.intent.request.content = 'escaped "\r\n e\u0301 '.repeat(16000);
    const request = records[0]!.intent.request;
    records[0]!.intent.bodyDigest = hash(canonicalJson(request as Json));
    const canonical = { ...request };
    delete canonical.expectedStoreId;
    delete canonical.commandId;
    records[0]!.intent.requestDigest = hash(canonicalJson(canonical as Json));
    const bytes = write(f.path, records);
    expect(bytes.length).toBeGreaterThan(300000);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(5);
    expect(backup.manifest.assets.callerIntents).toMatchObject({
      path: 'ui/caller-intents.json',
      present: true,
      format: { version: 1 },
      proof: { sha256: hash(bytes.toString()), byteLength: String(bytes.length) },
    });
    expect(readFileSync(join(backup.directory, 'ui/caller-intents.json'))).toEqual(bytes);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const result = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(result.storeId).not.toBe(f.storeId);
    expect(readFileSync(f.path)).toEqual(bytes);
    const restored = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(restored.records).toEqual(records);
    expect(restored.records[0].intent.scope.storeId).toBe(f.storeId);
    expect(restored.records[0].intent.request.extensionInputs[0].input).toEqual({ mode: 'plan' });
    expect(restored.records[0].intent.draft.revision).toBe('9223372036854775807');
  } finally {
    f.close();
  }
});

test('caller structure rejects duplicate IDs, authority extras, wrong target/scope/phase/draft and request bounds without changing source', async () => {
  const f = await fixture();
  try {
    const mutations: ((r: ReturnType<typeof row>) => void)[] = [
      (r) => {
        r.intent.request.token = 'forged';
      },
      (r) => {
        r.intent.request.subjectId = 'forged';
      },
      (r) => {
        r.intent.target.id = 'different';
      },
      (r) => {
        r.intent.scope.storeId = 'different';
      },
      (r) => {
        r.intent.subjectId = 'x'.repeat(257);
      },
      (r) => {
        r.intent.bodyDigest = 'A'.repeat(64);
      },
      (r) => {
        r.intent.requestDigest = '';
      },
      (r) => {
        r.intent.draft.revision = '9223372036854775808';
      },
      (r) => {
        r.intent.draft.revision = '01';
      },
      (r) => {
        r.phase = 'future';
      },
      (r) => {
        r.intent.request.content = 'x'.repeat(262145);
      },
      (r) => {
        r.intent.request.selectedSkills = Array(257).fill('x');
      },
      (r) => {
        r.intent.request.extensionInputs = [
          {
            extensionId: 'builtin.planning',
            definitionVersion: '1',
            input: { mode: 'plan' },
            grant: true,
          },
        ];
      },
    ];
    for (const mutate of mutations) {
      const original = row('run.start');
      mutate(original);
      const bytes = write(f.path, [original]);
      await reject(createProfileBackup(f), 'backup_caller_intents_invalid');
      expect(readFileSync(f.path)).toEqual(bytes);
    }
    for (const records of [
      [row('run.start'), row('command.cancel')],
      Array.from({ length: 129 }, (_, i) => row('run.start', i)),
    ]) {
      const bytes = write(f.path, records);
      await reject(createProfileBackup(f), 'backup_caller_intents_invalid');
      expect(readFileSync(f.path)).toEqual(bytes);
    }
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, records: [{ ...row('run.start'), phase: ['unknown'] }] }),
    );
    writeFileSync(f.path, bytes, { mode: 0o600 });
    await reject(createProfileBackup(f), 'backup_caller_intents_invalid');
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    f.close();
  }
});

test('caller private bytes reject hardlinks, symlinks, non0600, nonprivate parent and oversized/invalid UTF8', async () => {
  const f = await fixture();
  try {
    const bytes = write(f.path, [row('run.start')]);
    linkSync(f.path, join(f.root, 'hardlink'));
    await reject(createProfileBackup(f), 'backup_access_denied');
    rmSync(join(f.root, 'hardlink'));
    rmSync(f.path);
    writeFileSync(join(f.root, 'linked'), bytes, { mode: 0o600 });
    symlinkSync(join(f.root, 'linked'), f.path);
    await reject(createProfileBackup(f));
    rmSync(f.path);
    writeFileSync(f.path, bytes, { mode: 0o600 });
    chmodSync(f.path, 0o400);
    await reject(createProfileBackup(f), 'backup_caller_intents_invalid');
    chmodSync(f.path, 0o600);
    chmodSync(join(f.selected.profilePath, 'ui'), 0o755);
    await reject(createProfileBackup(f), 'backup_access_denied');
    chmodSync(join(f.selected.profilePath, 'ui'), 0o700);
    writeFileSync(f.path, Buffer.alloc(16 * 1024 * 1024 + 1, 32), { mode: 0o600 });
    await reject(createProfileBackup(f), 'backup_caller_intents_invalid');
    writeFileSync(f.path, Buffer.from([0xff]), { mode: 0o600 });
    await reject(createProfileBackup(f), 'backup_caller_intents_invalid');
  } finally {
    f.close();
  }
});

test('v2/v3 remain closed and caller corruption cannot publish restore or alter current bytes', async () => {
  const f = await fixture();
  try {
    const backup = await createProfileBackup(f);
    expect(backup.manifest.assets.callerIntents).toMatchObject({
      present: false,
      proof: null,
      format: null,
    });
    for (const version of [2, 3] as const) {
      const legacy = structuredClone(backup.manifest);
      legacy.version = version;
      delete legacy.assets.callerIntents;
      if (version === 2) delete legacy.assets.tuiRecovery;
      writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(legacy), { mode: 0o600 });
      expect((await inspectProfileBackup(backup)).manifest).toEqual(legacy);
      legacy.assets.callerIntents = backup.manifest.assets.callerIntents;
      writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(legacy), { mode: 0o600 });
      await reject(inspectProfileBackup(backup), 'backup_invalid_manifest');
    }
    const bytes = write(f.path, [row('run.start', 0, f.storeId)]),
      original = await createProfileBackup(f);
    const saved = join(original.directory, 'ui/caller-intents.json');
    writeFileSync(saved, '{}', { mode: 0o600 });
    await reject(
      restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup: original,
        intent: 'replace_with_selected_backup',
      }),
      'backup_asset_mismatch',
    );
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(await inspectProfileRestore({ profile: f.profile })).toBeNull();
    const store = await openSqliteStore(f.profile);
    expect((await store.getMetadata()).storeId).toBe(f.storeId);
    await store.close();
  } finally {
    f.close();
  }
});

test('caller archive fails closed where actual no-follow support is unavailable', async () => {
  const f = await fixture();
  try {
    write(f.path, [row('run.start')]);
    const script = join(f.root, 'no-follow.ts');
    writeFileSync(
      script,
      `import {constants} from 'node:fs'; import {verifyCallerIntentsDocument} from ${JSON.stringify(join(import.meta.dir, '../../../src/maintenance/caller-intents.ts'))}; constants.O_NOFOLLOW=0; try { verifyCallerIntentsDocument(${JSON.stringify(f.path)});process.exit(9); } catch(error) { if(error.code!=='maintenance_platform_unsupported')throw error; }`,
    );
    const result = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    expect(await result.exited).toBe(0);
  } finally {
    f.close();
  }
});

test('caller finite journal accepts exactly 128 records and a large closed extension input without a new business quota', async () => {
  const f = await fixture();
  try {
    const records = Array.from({ length: 128 }, (_, index) => row('run.start', index, f.storeId));
    records[0]!.intent.request.extensionInputs = [
      {
        extensionId: 'fixture.archive',
        definitionVersion: '1',
        input: { complete: 'x'.repeat(10 * 1024 * 1024) },
      },
    ];
    const bytes = write(f.path, records);
    expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(bytes.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    const backup = await createProfileBackup(f);
    expect(readFileSync(join(backup.directory, 'ui/caller-intents.json'))).toEqual(bytes);
    expect(
      (await inspectProfileBackup(backup)).manifest.assets.callerIntents?.proof?.byteLength,
    ).toBe(String(bytes.length));
  } finally {
    f.close();
  }
});

test('v4 requires its asset field and old v2/v3 never whitelist a physical caller file', async () => {
  const f = await fixture();
  try {
    const backup = await createProfileBackup(f),
      ready = join(backup.directory, 'ready.json');
    const missing = structuredClone(backup.manifest);
    delete missing.assets.callerIntents;
    writeFileSync(ready, JSON.stringify(missing), { mode: 0o600 });
    await reject(inspectProfileBackup(backup), 'backup_invalid_manifest');
    mkdirSync(join(backup.directory, 'ui'), { mode: 0o700 });
    write(join(backup.directory, 'ui/caller-intents.json'), [row('run.start')]);
    for (const version of [2, 3] as const) {
      const legacy = structuredClone(backup.manifest);
      legacy.version = version;
      delete legacy.assets.callerIntents;
      if (version === 2) delete legacy.assets.tuiRecovery;
      writeFileSync(ready, JSON.stringify(legacy), { mode: 0o600 });
      await reject(inspectProfileBackup(backup), 'backup_unexpected_asset');
    }
  } finally {
    f.close();
  }
});

test('corrupt caller structure with matching full proof still cannot publish a restore', async () => {
  const f = await fixture();
  try {
    const bytes = write(f.path, [row('run.start', 0, f.storeId)]),
      backup = await createProfileBackup(f);
    const corrupt = Buffer.from(
      JSON.stringify({ version: 1, records: [{ ...row('run.start'), phase: 'authority' }] }),
    );
    writeFileSync(join(backup.directory, 'ui/caller-intents.json'), corrupt, { mode: 0o600 });
    backup.manifest.assets.callerIntents!.proof = {
      sha256: hash(corrupt.toString()),
      byteLength: String(corrupt.length),
    };
    writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(backup.manifest), {
      mode: 0o600,
    });
    await reject(
      restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      }),
      'backup_caller_intents_invalid',
    );
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(await inspectProfileRestore({ profile: f.profile })).toBeNull();
    const store = await openSqliteStore(f.profile);
    expect((await store.getMetadata()).storeId).toBe(f.storeId);
    await store.close();
  } finally {
    f.close();
  }
});

test('closed old v2/v3 restore keeps actual configuration/UI preference bytes unchanged', async () => {
  for (const version of [2, 3] as const) {
    const f = await fixture();
    try {
      const config = Buffer.from(
          '\ufeff// original malformed config\n{"credentialRef":"fixture-original",',
        ),
        preferences = Buffer.from('// original unknown prefs\n{"future":1}\n');
      writeFileSync(join(f.selected.profilePath, 'config.jsonc'), config, { mode: 0o600 });
      writeFileSync(join(f.selected.profilePath, 'ui/preferences.jsonc'), preferences, {
        mode: 0o600,
      });
      const backup = await createProfileBackup(f);
      backup.manifest.version = version;
      delete backup.manifest.assets.callerIntents;
      if (version === 2) delete backup.manifest.assets.tuiRecovery;
      writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(backup.manifest), {
        mode: 0o600,
      });
      await inspectProfileBackup(backup);
      const result = await restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      });
      expect(result.storeId).not.toBe(f.storeId);
      expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(config);
      expect(readFileSync(join(f.selected.profilePath, 'ui/preferences.jsonc'))).toEqual(
        preferences,
      );
      expect(existsSync(join(f.selected.profilePath, 'ui/caller-intents.json'))).toBe(false);
    } finally {
      f.close();
    }
  }
});

function authRow(storeId: string, actionId = 'mcp.auth.login', index = 0) {
  const read = (kind: string) => ({
    identity: { kind, pathDigest: hash(kind), rootIdentity: hash(`${kind}-root`) },
    etag: null,
    error: null,
  });
  const request = {
    expectedStoreId: storeId,
    commandId: `auth_${index}`,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId,
    definitionVersion: '1',
    input: {
      serverId: 'mcp-server',
      expectedReadSet: {
        scopeDigest: hash('scope'),
        user: read('user'),
        workspace: read('workspace'),
        approvalEtag: null,
        bindingEtag: null,
        variablesDigest: hash('variables'),
      },
    },
  };
  const { expectedStoreId: _store, commandId: _command, ...publicRequest } = request;
  return {
    intent: {
      scope: { storeId, sessionId: 'original_session', workspaceId: 'original_workspace' },
      request,
      target: { kind: 'session', id: 'original_session' },
      subjectId: 'original_subject',
      bodyDigest: hash(canonicalJson(request as Json)),
      requestDigest: hash(canonicalJson(publicRequest as Json)),
    },
    phase: 'unknown',
  };
}

test('fixed auth caller v1 selects v13 and restores original full bytes without retagging or authority', async () => {
  const f = await fixture();
  try {
    const records = ['login', 'refresh', 'clear', 'revoke'].map((action, i) =>
      authRow(f.storeId, `mcp.auth.${action}`, i),
    );
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, records }, null, 2)}\n`);
    writeFileSync(f.path, bytes, { mode: 0o600 });
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(13);
    expect(backup.manifest.assets.callerIntents?.proof).toEqual({
      sha256: hash(bytes.toString()),
      byteLength: String(bytes.length),
    });
    expect(backup.manifest.assets.mcpSourceMutationIntents?.present).toBe(false);
    expect(backup.manifest.assets.mcpReconnectionIntents?.present).toBe(false);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    for (const version of [4, 5, 6, 7, 8, 9, 10, 11, 12] as const) {
      const downgraded = structuredClone(backup.manifest);
      downgraded.version = version;
      if (version < 12) delete downgraded.assets.mcpSourceMutationIntents;
      if (version < 11) delete downgraded.assets.mcpReconnectionIntents;
      if (version < 10) delete downgraded.assets.mcpSourceApprovalIntents;
      if (version < 9) delete downgraded.assets.mcpConnectionIntents;
      if (version < 8) delete downgraded.assets.mcpSelectionIntents;
      if (version < 6) delete downgraded.assets.fileRecoveryIntents;
      writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(downgraded), {
        mode: 0o600,
      });
      await reject(inspectProfileBackup(backup), 'backup_caller_intents_invalid');
    }
    writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(backup.manifest), {
      mode: 0o600,
    });
    const result = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(result.storeId).not.toBe(f.storeId);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).records).toEqual(records);
  } finally {
    f.close();
  }
}, 30000);

test('auth grammar is independent and closed; recomputed digests cannot admit arbitrary invokes, malformed reads or Work drafts', async () => {
  const { verifyCallerIntentRecords } = await import('../../../src/maintenance/caller-intents');
  const original = authRow('store');
  expect(() => verifyCallerIntentRecords([original])).toThrow(); // Desktop and legacy default.
  expect(verifyCallerIntentRecords([original], true)).toBe(true);
  const faults = [
    (r: typeof original) => {
      r.intent.request.extensionId = 'other';
    },
    (r: typeof original) => {
      r.intent.request.actionId = 'mcp.source.approve';
    },
    (r: typeof original) => {
      r.intent.request.definitionVersion = '2';
    },
    (r: typeof original) => {
      r.intent.request.input.expectedReadSet.user.identity.kind = 'workspace';
    },
    (r: typeof original) => {
      r.intent.request.input.expectedReadSet.variablesDigest = 'wrong';
    },
    (r: typeof original) => {
      Object.assign(r.intent.request.input, { credential: 'forbidden' });
    },
    (r: typeof original) => {
      Object.assign(r.intent, { draft: { id: hash('d'), revision: '1', textDigest: hash('d') } });
    },
  ];
  for (const fault of faults) {
    const r = structuredClone(original);
    fault(r);
    const { expectedStoreId: _s, commandId: _c, ...publicRequest } = r.intent.request;
    r.intent.bodyDigest = hash(canonicalJson(r.intent.request as Json));
    r.intent.requestDigest = hash(canonicalJson(publicRequest as Json));
    expect(() => verifyCallerIntentRecords([r], true)).toThrow();
  }
  const changed = structuredClone(original);
  changed.intent.request.input.expectedReadSet.scopeDigest = hash('changed');
  expect(() => verifyCallerIntentRecords([changed], true)).toThrow();
}, 5000);
