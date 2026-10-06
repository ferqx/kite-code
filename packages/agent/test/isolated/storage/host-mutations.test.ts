import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

async function rejected(work: Promise<unknown>, code: string) {
  let actual: unknown;
  try {
    await work;
  } catch (error) {
    actual = error;
  }
  expect((actual as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-host-journal-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const db = new Database(join(dataRoot, 'new', 'core.db'));
  const digest = (body: unknown) =>
    createHmac('sha256', randomBytes(32))
      .update(canonicalJson(body as never))
      .digest('hex');
  return {
    profile,
    store,
    db,
    dataRoot,
    expectedStoreId,
    digest,
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
test('two real Workers journal one host intent; only created permits effect, pending retry never redoes unknown I/O and final facts cannot be overwritten', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    const secret = 'disposable-secret-not-stored';
    const input = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'credential',
      subjectId: 'owner',
      kind: 'credential.put' as const,
      scope: 'user',
      requestDigest: f.digest({ secret }),
      safeRequest: { scope: 'user', persistence: 'temporary' },
    };
    const [one, two] = await Promise.all([
      f.store.beginHostMutation(input),
      peer.beginHostMutation(input),
    ]);
    expect([one, two].filter((r) => r.created)).toHaveLength(1);
    const ledger = join(f.dataRoot, 'effect-ledger');
    for (const result of [one, two]) if (result.created) appendFileSync(ledger, 'effect\n');
    expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    f.db.run(
      "CREATE TRIGGER journal_fault BEFORE UPDATE ON host_mutation BEGIN SELECT RAISE(ABORT,'terminal commit fault'); END",
    );
    let failed = false;
    try {
      await f.store.finishHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: input.commandId,
        subjectId: 'owner',
        requestDigest: input.requestDigest,
        state: 'applied',
        receipt: {
          status: 'applied',
          opaqueRef: 'credential:00000000-0000-0000-0000-000000000001',
          persistence: 'temporary',
        },
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const retry = await peer.beginHostMutation(input);
    expect(retry.created).toBe(false);
    expect(retry.record.state).toBe('pending');
    expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    f.db.run('DROP TRIGGER journal_fault');
    const terminal = {
      expectedStoreId: f.expectedStoreId,
      commandId: input.commandId,
      subjectId: 'owner',
      requestDigest: input.requestDigest,
      state: 'outcome_unknown' as const,
      receipt: { status: 'outcome_unknown', code: 'credential_unavailable' },
    };
    const record = await f.store.finishHostMutation(terminal);
    expect(await peer.finishHostMutation(terminal)).toEqual(record);
    await rejected(
      peer.finishHostMutation({
        ...terminal,
        state: 'failed',
        receipt: { status: 'failed', code: 'credential_unavailable' },
      }),
      'host_mutation_terminal_conflict',
    );
    expect(
      await f.store.getHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: 'credential',
        subjectId: 'owner',
      }),
    ).toEqual(record);
    expect(JSON.stringify(f.db.query('SELECT * FROM host_mutation').all())).not.toContain(secret);
    expect(f.db.query('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
  } finally {
    await peer.close();
    await f.close();
  }
});
test('host journal rejects foreign Store/subject, conflicting ID, unsafe metadata and credential plaintext with zero business effects', async () => {
  const f = await fixture();
  try {
    const base = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'mutation',
      subjectId: 'owner',
      kind: 'config.user.write' as const,
      scope: 'user',
      requestDigest: 'a'.repeat(64),
      safeRequest: { scope: 'user', ifMatch: 'missing', operationCount: 1 },
    };
    await rejected(
      f.store.beginHostMutation({ ...base, expectedStoreId: 'wrong' }),
      'store_identity_mismatch',
    );
    expect(f.db.query('SELECT count(*) AS n FROM host_mutation').get()).toEqual({ n: 0 });
    const original = await f.store.beginHostMutation(base);
    expect(original.created).toBe(true);
    await rejected(
      f.store.beginHostMutation({ ...base, subjectId: 'intruder' }),
      'host_mutation_conflict',
    );
    await rejected(
      f.store.beginHostMutation({ ...base, requestDigest: 'b'.repeat(64) }),
      'host_mutation_conflict',
    );
    await rejected(
      f.store.beginHostMutation({
        ...base,
        safeRequest: { ...base.safeRequest, operationCount: 2 },
      }),
      'host_mutation_conflict',
    );
    await rejected(
      f.store.getHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: base.commandId,
        subjectId: 'intruder',
      }),
      'host_mutation_scope_denied',
    );
    await rejected(
      f.store.beginHostMutation({
        ...base,
        commandId: 'unsafe',
        safeRequest: { ...base.safeRequest, operations: [{ secret: 'bad' }] },
      }),
      'invalid_host_mutation',
    );
    await rejected(
      f.store.beginHostMutation({
        ...base,
        commandId: 'credential',
        kind: 'credential.put',
        safeRequest: { scope: 'user', persistence: 'temporary', secret: 'never-store' },
      }),
      'invalid_host_mutation',
    );
    await rejected(
      f.store.beginHostMutation({
        ...base,
        commandId: 'revoke',
        kind: 'credential.revoke',
        safeRequest: { scope: 'user', persistence: 'temporary', opaqueRef: 'plain-secret' },
      }),
      'invalid_host_mutation',
    );
    const put = {
      ...base,
      commandId: 'put',
      kind: 'credential.put' as const,
      safeRequest: { scope: 'user', persistence: 'temporary' },
    };
    await f.store.beginHostMutation(put);
    await rejected(
      f.store.finishHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: 'put',
        subjectId: 'owner',
        requestDigest: put.requestDigest,
        state: 'applied',
        receipt: { secret: 'never-store' },
      }),
      'invalid_host_mutation',
    );
    await rejected(
      f.store.finishHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: 'put',
        subjectId: 'owner',
        requestDigest: put.requestDigest,
        state: 'applied',
        receipt: { opaqueRef: 'plain-secret' },
      }),
      'invalid_host_mutation',
    );
    expect(
      (
        await f.store.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          commandId: 'put',
          subjectId: 'owner',
        })
      )?.state,
    ).toBe('pending');
    expect(JSON.stringify(f.db.query('SELECT * FROM host_mutation').all())).not.toContain(
      'never-store',
    );
  } finally {
    await f.close();
  }
});
test('workspace writes/repair use accurate Workspace identity and readonly journal queries never rebind old Store records', async () => {
  const f = await fixture();
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.store.createWorkspace({
      expectedStoreId: f.expectedStoreId,
      id: 'w',
      rootUri: 'file:///disposable',
      name: 'w',
    });
    const input = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'repair',
      subjectId: 'owner',
      kind: 'config.repair' as const,
      scope: 'w',
      requestDigest: 'c'.repeat(64),
      safeRequest: { scope: 'workspace', workspaceId: 'w', ifMatch: 'broken-content-hash' },
    };
    await rejected(
      f.store.beginHostMutation({ ...input, scope: 'workspace' }),
      'invalid_host_mutation',
    );
    await rejected(
      f.store.beginHostMutation({
        ...input,
        scope: 'missing',
        safeRequest: { ...input.safeRequest, workspaceId: 'missing' },
      }),
      'invalid_host_mutation',
    );
    await f.store.beginHostMutation(input);
    const final = await f.store.finishHostMutation({
      ...input,
      state: 'applied',
      receipt: { status: 'applied', etag: 'new-content-hash' },
    });
    await f.store.close();
    reader = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    expect(
      await reader.getHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: 'repair',
        subjectId: 'owner',
      }),
    ).toEqual(final);
    await rejected(reader.beginHostMutation(input), 'read_only');
    f.db.run("UPDATE host_mutation SET origin_store_id='old-origin' WHERE id='repair'");
    await rejected(
      reader.getHostMutation({
        expectedStoreId: f.expectedStoreId,
        commandId: 'repair',
        subjectId: 'owner',
      }),
      'host_mutation_scope_denied',
    );
  } finally {
    await reader?.close();
    await f.close();
  }
});

test('model Settings journal marker is closed data, original read set and operation cannot be substituted under the same ID', async () => {
  const f = await fixture();
  const readSet = {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'b'.repeat(64),
    effectiveDigest: 'c'.repeat(64),
  };
  const marker = {
    expectedReadSet: readSet,
    operation: { kind: 'enabled', modelId: 'model-a', enabled: false },
  };
  const input = {
    expectedStoreId: f.expectedStoreId,
    subjectId: 'owner',
    commandId: 'models',
    kind: 'config.user.write' as const,
    scope: 'user',
    requestDigest: f.digest(marker),
    safeRequest: {
      scope: 'user',
      ifMatch: readSet.userEtag,
      operationCount: 1,
      modelSettings: marker,
    },
  };
  try {
    expect((await f.store.beginHostMutation(input)).created).toBe(true);
    await rejected(
      f.store.beginHostMutation({
        ...input,
        safeRequest: {
          ...input.safeRequest,
          modelSettings: { ...marker, operation: { ...marker.operation, modelId: 'other' } },
        },
      }),
      'host_mutation_conflict',
    );
    for (const reasoningEffort of ['high', null] as const) {
      const selected = {
        ...marker,
        operation: { kind: 'effort', modelId: 'model-a', reasoningEffort },
      };
      const request = {
        ...input,
        commandId: `effort-${reasoningEffort}`,
        requestDigest: f.digest(selected),
        safeRequest: { ...input.safeRequest, modelSettings: selected },
      };
      expect((await f.store.beginHostMutation(request)).created).toBe(true);
      expect((await f.store.beginHostMutation(request)).created).toBe(false);
      await rejected(
        f.store.beginHostMutation({
          ...request,
          safeRequest: {
            ...request.safeRequest,
            modelSettings: {
              ...selected,
              operation: { ...selected.operation, reasoningEffort: 'low' },
            },
          },
        }),
        'host_mutation_conflict',
      );
    }
    const bads: import('../../../src/storage/types').Json[] = [
      {
        ...input.safeRequest,
        modelSettings: { ...marker, operation: { kind: 'effort', modelId: 'model-a' } },
      },
      { ...input.safeRequest, purpose: 'arbitrary' },
      { ...input.safeRequest, modelSettings: { ...marker, secret: 'private' } },
      {
        ...input.safeRequest,
        modelSettings: { ...marker, operation: { ...marker.operation, subjectId: 'forged' } },
      },
      {
        ...input.safeRequest,
        modelSettings: {
          ...marker,
          expectedReadSet: { ...readSet, workspaceEtag: 'd'.repeat(64) },
        },
      },
      { ...input.safeRequest, ifMatch: 'd'.repeat(64) },
      {
        ...input.safeRequest,
        modelSettings: { ...marker, expectedReadSet: { ...readSet, effectiveDigest: 'malformed' } },
      },
      ...['ultra', 1].map((reasoningEffort) => ({
        ...input.safeRequest,
        modelSettings: {
          ...marker,
          operation: { kind: 'effort', modelId: 'model-a', reasoningEffort },
        },
      })),
      {
        ...input.safeRequest,
        modelSettings: {
          ...marker,
          operation: { kind: 'effort', modelId: 'model-a', reasoningEffort: null, hidden: true },
        },
      },
    ];
    for (const [index, safeRequest] of bads.entries()) {
      const commandId = `invalid-marker-${index}`;
      await rejected(
        f.store.beginHostMutation({ ...input, commandId, safeRequest }),
        'invalid_host_mutation',
      );
      expect(
        await f.store.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          commandId,
        }),
      ).toBeNull();
    }
    expect(
      (
        await f.store.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          commandId: 'models',
        })
      )?.safeRequest,
    ).toEqual(input.safeRequest);
  } finally {
    await f.close();
  }
});

test('Provider journal preserves the original family, endpoint and read set; closed user intent cannot acquire Workspace or secret authority', async () => {
  const f = await fixture();
  const readSet = {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'b'.repeat(64),
    effectiveDigest: 'c'.repeat(64),
  };
  const marker = {
    expectedReadSet: readSet,
    operation: {
      provider: 'openai',
      connectionId: null,
      baseURL: 'https://provider.invalid/v1',
      modelNames: ['actual-雪🙂'],
      credential: 'replace',
    },
  };
  const input = {
    expectedStoreId: f.expectedStoreId,
    subjectId: 'owner',
    commandId: 'provider',
    kind: 'config.user.write' as const,
    scope: 'user',
    requestDigest: f.digest(marker),
    safeRequest: {
      scope: 'user',
      ifMatch: readSet.userEtag,
      operationCount: 1,
      providerSettings: marker,
    },
  };
  try {
    for (const provider of ['openai', 'deepseek', 'compatible', 'ollama']) {
      const request = {
        ...input,
        commandId: `provider-${provider}`,
        safeRequest: {
          ...input.safeRequest,
          providerSettings: { ...marker, operation: { ...marker.operation, provider } },
        },
      };
      expect((await f.store.beginHostMutation(request)).created).toBe(true);
      expect((await f.store.beginHostMutation(request)).created).toBe(false);
    }
    await f.store.beginHostMutation(input);
    await rejected(
      f.store.beginHostMutation({ ...input, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    for (const providerSettings of [
      { ...marker, operation: { ...marker.operation, baseURL: 'https://other.invalid/v1' } },
      { ...marker, expectedReadSet: { ...readSet, effectiveDigest: 'd'.repeat(64) } },
    ])
      await rejected(
        f.store.beginHostMutation({
          ...input,
          safeRequest: { ...input.safeRequest, providerSettings },
        }),
        'host_mutation_conflict',
      );
    const bads = [
      { ...input.safeRequest, providerSettings: { ...marker, secret: 'never-store' } },
      {
        ...input.safeRequest,
        providerSettings: {
          ...marker,
          operation: {
            ...marker.operation,
            credentialRef: 'credential:00000000-0000-0000-0000-000000000001',
          },
        },
      },
      {
        ...input.safeRequest,
        providerSettings: {
          ...marker,
          operation: {
            ...marker.operation,
            baseURL: 'https://provider.invalid/v1?key=never-store',
          },
        },
      },
      {
        ...input.safeRequest,
        modelSettings: { expectedReadSet: readSet, operation: { kind: 'default', modelId: 'a' } },
      },
    ];
    for (const [index, safeRequest] of bads.entries()) {
      const commandId = `bad-provider-${index}`;
      await rejected(
        f.store.beginHostMutation({ ...input, commandId, safeRequest }),
        'invalid_host_mutation',
      );
      expect(
        await f.store.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          commandId,
        }),
      ).toBeNull();
    }
    await f.store.createWorkspace({
      expectedStoreId: f.expectedStoreId,
      id: 'w',
      rootUri: 'file:///disposable',
      name: 'w',
    });
    await rejected(
      f.store.beginHostMutation({
        ...input,
        commandId: 'workspace-provider',
        kind: 'config.workspace.write',
        scope: 'w',
        safeRequest: {
          ...input.safeRequest,
          scope: 'workspace',
          workspaceId: 'w',
          providerSettings: {
            ...marker,
            expectedReadSet: { ...readSet, workspaceEtag: readSet.userEtag },
          },
        },
      }),
      'invalid_host_mutation',
    );
    expect(
      (
        await f.store.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          commandId: input.commandId,
        })
      )?.safeRequest,
    ).toEqual(input.safeRequest);
    expect(JSON.stringify(f.db.query('SELECT * FROM host_mutation').all())).not.toContain(
      'never-store',
    );
  } finally {
    await f.close();
  }
});

test('Provider terminal journal distinguishes stored-unpublished, uncertain vault and published config using its original marker', async () => {
  const f = await fixture();
  const input = {
    expectedStoreId: f.expectedStoreId,
    subjectId: 'owner',
    commandId: 'split',
    kind: 'config.user.write' as const,
    scope: 'user',
    requestDigest: 'a'.repeat(64),
    safeRequest: {
      scope: 'user',
      ifMatch: 'b'.repeat(64),
      operationCount: 1,
      providerSettings: {
        expectedReadSet: {
          userEtag: 'b'.repeat(64),
          workspaceEtag: null,
          explicitDigest: 'c'.repeat(64),
          effectiveDigest: 'd'.repeat(64),
        },
        operation: {
          provider: 'openai',
          connectionId: null,
          baseURL: 'https://provider.invalid/v1',
          modelNames: ['actual'],
          credential: 'replace',
        },
      },
    },
  };
  const opaqueRef = 'credential:00000000-0000-0000-0000-000000000001';
  try {
    await f.store.beginHostMutation(input);
    const finish = {
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: input.commandId,
      requestDigest: input.requestDigest,
    };
    const split = {
      ...finish,
      state: 'failed' as const,
      receipt: {
        status: 'failed',
        code: 'configuration_read_set_conflict',
        credentialState: 'stored',
        configurationState: 'not_attempted',
        opaqueRef,
      },
    };
    await rejected(
      f.store.finishHostMutation({
        ...split,
        receipt: {
          status: 'failed',
          code: split.receipt.code,
          credentialState: 'stored',
          configurationState: 'not_attempted',
        },
      }),
      'invalid_host_mutation',
    );
    const stored = await f.store.finishHostMutation(split);
    expect(stored.receipt).toEqual(split.receipt);
    expect(await f.store.finishHostMutation(split)).toEqual(stored);
    expect((await f.store.beginHostMutation(input)).created).toBe(false);
    await rejected(
      f.store.finishHostMutation({
        ...finish,
        state: 'applied',
        receipt: {
          status: 'applied',
          etag: 'e'.repeat(64),
          credentialState: 'stored',
          configurationState: 'published',
          opaqueRef,
        },
      }),
      'host_mutation_terminal_conflict',
    );
    await f.store.beginHostMutation({ ...input, commandId: 'unknown' });
    const uncertain = {
      ...finish,
      commandId: 'unknown',
      state: 'outcome_unknown' as const,
      receipt: {
        status: 'outcome_unknown',
        code: 'credential_unavailable',
        credentialState: 'outcome_unknown',
        configurationState: 'not_attempted',
      },
    };
    await rejected(
      f.store.finishHostMutation({
        ...uncertain,
        state: 'failed',
        receipt: { ...uncertain.receipt, status: 'failed' },
      }),
      'invalid_host_mutation',
    );
    await rejected(
      f.store.finishHostMutation({
        ...uncertain,
        receipt: { ...uncertain.receipt, credentialState: 'unchanged' },
      }),
      'invalid_host_mutation',
    );
    expect((await f.store.finishHostMutation(uncertain)).receipt).toEqual(uncertain.receipt);
    await f.store.beginHostMutation({ ...input, commandId: 'published' });
    const published = {
      ...finish,
      commandId: 'published',
      state: 'applied' as const,
      receipt: {
        status: 'applied',
        etag: 'e'.repeat(64),
        credentialState: 'unchanged',
        configurationState: 'published',
      },
    };
    await rejected(
      f.store.finishHostMutation({
        ...published,
        receipt: { ...published.receipt, configurationState: 'not_attempted' },
      }),
      'invalid_host_mutation',
    );
    expect((await f.store.finishHostMutation(published)).receipt).toEqual(published.receipt);
    await f.store.beginHostMutation({
      ...input,
      commandId: 'generic',
      safeRequest: { scope: 'user', ifMatch: input.safeRequest.ifMatch, operationCount: 1 },
    });
    await rejected(
      f.store.finishHostMutation({ ...published, commandId: 'generic' }),
      'invalid_host_mutation',
    );
    expect(
      (
        await f.store.getHostMutation({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          commandId: 'generic',
        })
      )?.state,
    ).toBe('pending');
  } finally {
    await f.close();
  }
});
