import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CallerCommandRequest } from '@kite-ai/client';
import { canonicalCallerCommandRequest } from '@kite-ai/client';
import { answerRequestDigest, validateAnswerRecord } from '../electron/answer-journal';
import {
  callerDigest,
  callerTarget,
  callerTextDigest,
  validateCallerRecord,
} from '../electron/caller-journal';
import { parseConfigurationRecord } from '../electron/configuration-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';

const scope = {
  storeId: 'original-store',
  workspaceId: 'workspace',
  rootSessionId: 'root-session',
};
const [mode, profileJson, bunExecutable, bunSha256, helperPath, helperSha256] = process.argv.slice(
  2,
) as string[];
const profileInput = JSON.parse(profileJson!);
const profile = selectProfile(profileInput).profilePath;
const acquire = () =>
  acquireDesktopProfileAccess({
    profile: profileInput,
    bunExecutable: bunExecutable!,
    bunSha256: bunSha256!,
    helperPath: helperPath!,
    helperSha256: helperSha256!,
  });
const open = async () => openPrivateData(profile, await acquire());
const assertEmptyMcpTable = (db: DatabaseSync) => {
  assert.equal(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_intents'").get()
      ?.sql,
    'CREATE TABLE mcp_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)',
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM mcp_intents').get()!.count, 0);
};
if (mode === 'denied') {
  await assert.rejects(acquire(), new RegExp(process.argv[8]!));
  console.log('private-lease-denied');
} else if (mode === 'worker') {
  const data = await open();
  process.send!('ready');
  process.on('message', () => {
    try {
      data.save(scope, 1, process.pid.toString());
      process.send!('saved');
    } catch (error) {
      process.send!((error as Error).message);
    } finally {
      data.close();
      process.disconnect!();
    }
  });
} else {
  const root = join(profile, '..');
  try {
    assert.throws(
      () => openPrivateData(profile, Object.freeze({ close() {} })),
      /profile_access_unavailable/,
    );
    const protectedLease = await acquire();
    let data = openPrivateData(profile, protectedLease);
    assert.throws(() => protectedLease.close(), /profile_access_in_use/);
    const draft = data.save(scope, 0, '原文\n🙂\u0000exact');
    assert.equal(draft.revision, 1);
    const originalClose = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = () => {
      throw Error('actual_database_close_failure');
    };
    assert.throws(() => data.close(), /draft_storage_unavailable/);
    assert.throws(() => protectedLease.close(), /profile_access_in_use/);
    DatabaseSync.prototype.close = function () {
      assert.throws(() => protectedLease.close(), /profile_access_in_use/);
      return originalClose.call(this);
    };
    data.close();
    DatabaseSync.prototype.close = originalClose;
    assert.throws(() => openPrivateData(profile, protectedLease), /profile_access_unavailable/);
    protectedLease.close();
    data = await open();
    assert.deepEqual(data.read(scope), draft);
    assert.equal(lstatSync(join(profile, 'desktop-private/data.sqlite')).mode & 0o077, 0);
    data.close();
    const children = [0, 1].map(() =>
      fork(
        process.argv[1]!,
        ['worker', profileJson!, bunExecutable!, bunSha256!, helperPath!, helperSha256!],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      ),
    );
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once('message', (value) => {
              assert.equal(value, 'ready');
              resolve();
            });
            child.once('error', reject);
          }),
      ),
    );
    const results = children.map(
      (child) =>
        new Promise<unknown>((resolve, reject) => {
          child.once('message', resolve);
          child.once('error', reject);
        }),
    );
    for (const child of children) child.send('go');
    assert.deepEqual((await Promise.all(results)).sort(), ['draft_revision_conflict', 'saved']);
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise<void>((r) => child.once('exit', () => r())),
      ),
    );
    data = await open();
    assert.equal(data.read(scope).revision, 2);
    for (let i = 0; i < 132; i++)
      data.save({ ...scope, rootSessionId: `root-${i}` }, 0, 'retained');
    const page = data.list();
    assert.equal(page.drafts.length, 100);
    assert.ok(page.nextId);
    assert.equal(data.list(page.nextId!).drafts.length, 33);
    const input = {
      expectedStoreId: 'original-store',
      workspaceId: 'workspace',
      commandId: 'create',
      sessionId: 'new',
      title: 'new',
    };
    assert.equal(data.begin(input).created, true);
    data.finish('create', 'unknown');
    data.close();
    data = await open();
    assert.equal(data.begin(input).created, false);
    assert.equal(data.creations()[0]!.phase, 'unknown');
    assert.throws(() => data.begin({ ...input, sessionId: 'another' }), /creation_intent_conflict/);
    data.finish('create', 'created');
    assert.equal(data.finish('create', 'unknown').phase, 'created');
    data.close();
    const recovery = {
      observationId: 1,
      storeId: 'original-store',
      sessionId: 'root-session',
      kind: 'run' as const,
      targetId: 'original-run',
      originalCommandId: 'original-work',
      commandId: 'recover-original',
      phase: 'submitting' as const,
    };
    data = await open();
    assert.equal(data.beginRecovery(recovery).created, true);
    data.close();
    data = await open();
    assert.equal(data.recoveries()[0]!.phase, 'submitting');
    data.finishRecovery(recovery.commandId, 'outcome_unknown');
    assert.equal(data.beginRecovery(recovery).created, false);
    assert.throws(
      () => data.beginRecovery({ ...recovery, targetId: 'other' }),
      /recovery_intent_conflict/,
    );
    assert.throws(
      () => data.beginRecovery({ ...recovery, commandId: 'new-command' }),
      /recovery_intent_pending/,
    );
    data.finishRecovery(recovery.commandId, 'resumed');
    assert.equal(data.finishRecovery(recovery.commandId, 'outcome_unknown').phase, 'resumed');
    assert.equal(data.recoveries().length, 0);
    data.close();
    const answerRow = (index: number) => {
      const request = {
        expectedStoreId: scope.storeId,
        commandId: `answer-${index}`,
        expectedRevision: '9007199254740993',
        answer: { kind: 'question' as const, answers: { full: '原🙂é\r\ncomplete' } },
      };
      return validateAnswerRecord({
        intent: {
          scope: {
            storeId: scope.storeId,
            sessionId: scope.rootSessionId,
            workspaceId: scope.workspaceId,
            contextSelectionId: 'original-selection',
          },
          subjectId: 'local-user',
          interaction: {
            id: `question-${index}`,
            sessionId: scope.rootSessionId,
            executionId: `execution-${index}`,
            runId: 'original-run',
            revision: request.expectedRevision,
            kind: 'question',
            attempt: 1,
            definitionId: 'fixture.question',
            definitionVersion: '1',
            inputDigest: 'digest',
            policyRevision: 'policy',
          },
          observationDigest: '0'.repeat(64),
          request,
          bodyDigest: callerDigest(request),
          requestDigest: answerRequestDigest(`question-${index}`, request),
        },
        phase: 'submitting',
      });
    };
    data = await open();
    const answer = answerRow(0);
    assert.equal(data.beginAnswer(answer).created, true);
    data.close();
    data = await open();
    assert.deepEqual(data.answers(), [answer]);
    assert.equal(data.beginAnswer(answer).created, false);
    assert.throws(
      () => data.beginAnswer({ ...answer, intent: { ...answer.intent, subjectId: 'other' } }),
      /answer_intent_conflict/,
    );
    const duplicate = answerRow(1);
    duplicate.intent.interaction.id = answer.intent.interaction.id;
    duplicate.intent.requestDigest = answerRequestDigest(
      duplicate.intent.interaction.id,
      duplicate.intent.request,
    );
    assert.throws(() => data.beginAnswer(duplicate), /answer_intent_conflict/);
    assert.equal(data.finishAnswer('answer-0', 'unknown').phase, 'unknown');
    for (let index = 1; index < 128; index++) data.beginAnswer(answerRow(index));
    assert.throws(() => data.beginAnswer(answerRow(128)), /answer_capacity_exceeded/);
    data.close();
    data = await open();
    assert.equal(data.answers().length, 128);
    assert.deepEqual(
      data.answers().find((row) => row.intent.request.commandId === 'answer-0')!.intent,
      answer.intent,
    );
    assert.equal(data.finishAnswer('answer-0', 'accepted').phase, 'accepted');
    assert.equal(data.finishAnswer('answer-0', 'unknown').phase, 'unknown');
    data.close();
    const privatePath = join(profile, 'desktop-private/data.sqlite');
    const legacy = new DatabaseSync(privatePath);
    assertEmptyMcpTable(legacy);
    legacy.exec(
      'DROP TABLE mcp_intents; DROP TABLE configuration_intents; DROP TABLE model_routes; DROP TABLE answer_intents; DROP TABLE file_recovery_intents; DROP TABLE caller_intents; DROP TABLE recovery_intents; PRAGMA user_version=1',
    );
    legacy.close();
    data = await open();
    assert.equal(data.read(scope).revision, 2);
    assert.equal(data.begin(input).value.phase, 'created');
    assert.equal(data.beginRecovery(recovery).created, true);
    data.close();
    const version2 = new DatabaseSync(privatePath);
    assertEmptyMcpTable(version2);
    version2.exec(
      'DROP TABLE mcp_intents; DROP TABLE configuration_intents; DROP TABLE model_routes; DROP TABLE answer_intents; DROP TABLE file_recovery_intents; DROP TABLE caller_intents; PRAGMA user_version=2',
    );
    version2.close();
    data = await open();
    assert.equal(data.read(scope).revision, 2);
    assert.equal(data.begin(input).value.phase, 'created');
    assert.equal(data.recoveries()[0]!.commandId, recovery.commandId);
    const callerScope = {
      storeId: scope.storeId,
      workspaceId: scope.workspaceId,
      sessionId: scope.rootSessionId,
    };
    const callerRow = (commandId: string, extra = '') => {
      const request: CallerCommandRequest = {
        kind: 'run.start',
        commandId,
        expectedStoreId: scope.storeId,
        content: '原🙂é\r\n',
        ...(extra
          ? {
              extensionInputs: [
                {
                  extensionId: 'builtin.planning',
                  definitionVersion: '1',
                  input: { mode: 'plan', full: extra },
                },
              ],
            }
          : {}),
      };
      return validateCallerRecord({
        intent: {
          scope: callerScope,
          request,
          target: callerTarget(callerScope, request),
          subjectId: 'local-user',
          bodyDigest: callerDigest(request),
          requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
        },
        phase: 'submitting',
      });
    };
    const caller = callerRow('caller-original');
    assert.equal(data.beginCaller(caller).created, true);
    data.close();
    data = await open();
    assert.equal(data.beginCaller(caller).created, false);
    assert.deepEqual(data.callers()[0]!.intent.request, caller.intent.request);
    assert.throws(() => data.clearCaller('caller-original'), /caller_clear_unconfirmed/);
    for (let i = 1; i < 128; i++) data.beginCaller(callerRow(`caller-${i}`));
    assert.equal(data.callers().length, 128);
    assert.throws(() => data.beginCaller(callerRow('caller-overflow')), /caller_capacity_exceeded/);
    assert.equal(data.callers().length, 128);
    assert.throws(
      () => data.beginCaller({ ...caller, intent: { ...caller.intent, subjectId: 'other' } }),
      /caller_intent_conflict/,
    );
    data.finishCaller('caller-original', 'applied');
    assert.equal(data.finishCaller('caller-original', 'unknown').phase, 'applied');
    data.clearCaller('caller-original');
    for (let i = 1; i < 128; i++) {
      data.finishCaller(`caller-${i}`, 'rejected');
      data.clearCaller(`caller-${i}`);
    }
    const large = '中'.repeat(400000);
    let largeRows = 0;
    for (let i = 0; i < 20; i++) {
      try {
        data.beginCaller(callerRow(`large-${i}`, large));
        largeRows++;
      } catch (error) {
        assert.match((error as Error).message, /caller_capacity_exceeded/);
        break;
      }
    }
    assert.equal(largeRows, 13);
    assert.equal(data.callers().length, 13);
    const largeRequest = data.callers()[0]!.intent.request;
    if (largeRequest.kind !== 'run.start') throw Error('actual_large_kind');
    const fullInput = largeRequest.extensionInputs?.[0]?.input;
    if (
      !fullInput ||
      typeof fullInput !== 'object' ||
      Array.isArray(fullInput) ||
      !('full' in fullInput)
    )
      throw Error('actual_large_input');
    assert.equal(fullInput.full, large);
    assert.throws(
      () => data.beginCaller(callerRow('large-overflow', large)),
      /caller_capacity_exceeded/,
    );
    for (const row of data.callers()) {
      data.finishCaller(row.intent.request.commandId, 'rejected');
      data.clearCaller(row.intent.request.commandId);
    }
    data.beginCaller(caller);
    data.close();
    let callerCorrupt = new DatabaseSync(privatePath);
    const intactCaller = String(
      callerCorrupt
        .prepare('SELECT state FROM caller_intents WHERE command_id=?')
        .get('caller-original')!.state,
    );
    callerCorrupt
      .prepare('UPDATE caller_intents SET state=? WHERE command_id=?')
      .run('{bad', 'caller-original');
    callerCorrupt.close();
    const badCallerBytes = readFileSync(privatePath);
    data = await open();
    assert.throws(() => data.callers(), /caller_storage_unavailable|draft_storage_unavailable/);
    assert.throws(
      () => data.beginCaller(callerRow('bad-replacement')),
      /caller_storage_unavailable|draft_storage_unavailable/,
    );
    data.close();
    assert.deepEqual(readFileSync(privatePath), badCallerBytes);
    callerCorrupt = new DatabaseSync(privatePath);
    callerCorrupt
      .prepare('UPDATE caller_intents SET state=? WHERE command_id=?')
      .run(intactCaller, 'caller-original');
    callerCorrupt.close();
    data = await open();
    const providerOriginal = parseConfigurationRecord({
      kind: 'provider',
      input: {
        expectedStoreId: scope.storeId,
        commandId: 'provider-original',
        expectedReadSet: {
          userEtag: 'a'.repeat(64),
          workspaceEtag: null,
          explicitDigest: 'b'.repeat(64),
          effectiveDigest: 'c'.repeat(64),
        },
        operation: {
          provider: 'openai',
          connectionId: null,
          baseURL: 'https://provider.invalid/v1',
          modelNames: ['模型雪🙂é'],
          credential: 'replace',
        },
      },
      state: {
        kind: 'settings.providers.submission',
        commandId: 'provider-original',
        storeId: scope.storeId,
        observationId: 1,
        operation: {
          provider: 'openai',
          connectionId: null,
          baseURL: 'https://provider.invalid/v1',
          modelNames: ['模型雪🙂é'],
          credential: 'replace',
        },
        phase: 'unknown',
      },
    });
    if (providerOriginal.kind !== 'provider') throw Error('actual_provider_record');
    data.saveConfiguration(providerOriginal);
    data.rememberModelRoute(scope.storeId, scope.rootSessionId, 'model-original');
    data.rememberModelRoute('other-store', scope.rootSessionId, 'model-other');
    assert.throws(
      () =>
        data.saveConfiguration({
          ...providerOriginal,
          input: { ...providerOriginal.input, secret: 'never-persist-key' },
        } as never),
      /draft_storage_unavailable/,
    );
    data.close();
    data = await open();
    assert.deepEqual(data.configurations(), [providerOriginal]);
    assert.equal(data.modelRoute(scope.storeId, scope.rootSessionId), 'model-original');
    assert.equal(data.modelRoute('other-store', scope.rootSessionId), 'model-other');
    assert.equal(data.modelRoute(scope.storeId, 'other-session'), undefined);
    assert.throws(
      () =>
        data.saveConfiguration({
          ...providerOriginal,
          input: {
            ...providerOriginal.input,
            expectedReadSet: {
              ...providerOriginal.input.expectedReadSet,
              effectiveDigest: 'd'.repeat(64),
            },
          },
        }),
      /configuration_storage_unavailable/,
    );
    data.saveConfiguration({
      ...providerOriginal,
      state: { ...providerOriginal.state, phase: 'applied' },
    });
    assert.deepEqual(data.configurations(), []);
    data.saveConfiguration(providerOriginal);
    data.close();
    let configurationDb = new DatabaseSync(privatePath);
    assert.equal(configurationDb.prepare('PRAGMA user_version').get()!.user_version, 7);
    assertEmptyMcpTable(configurationDb);
    const originalConfiguration = configurationDb
      .prepare('SELECT state FROM configuration_intents WHERE command_id=?')
      .get('provider-original')!.state as string;
    assert.equal(originalConfiguration.includes('"secret"'), false);
    assert.equal(originalConfiguration.includes('never-persist-key'), false);
    configurationDb
      .prepare('UPDATE configuration_intents SET state=? WHERE command_id=?')
      .run('{bad', 'provider-original');
    configurationDb.close();
    const brokenConfigurationBytes = readFileSync(privatePath);
    data = await open();
    assert.throws(() => data.configurations(), /draft_storage_unavailable/);
    assert.throws(
      () =>
        data.saveConfiguration({
          ...providerOriginal,
          input: { ...providerOriginal.input, commandId: 'replacement' },
          state: { ...providerOriginal.state, commandId: 'replacement' },
        }),
      /draft_storage_unavailable/,
    );
    data.close();
    assert.deepEqual(readFileSync(privatePath), brokenConfigurationBytes);
    configurationDb = new DatabaseSync(privatePath);
    configurationDb
      .prepare('UPDATE configuration_intents SET state=? WHERE command_id=?')
      .run(originalConfiguration, 'provider-original');
    const oldTables = [
      'drafts',
      'creations',
      'recovery_intents',
      'caller_intents',
      'file_recovery_intents',
      'answer_intents',
    ];
    const oldRows = oldTables.map((table) =>
      configurationDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    assertEmptyMcpTable(configurationDb);
    configurationDb.exec(
      'DROP TABLE mcp_intents; DROP TABLE configuration_intents; DROP TABLE model_routes; PRAGMA user_version=5',
    );
    configurationDb.close();
    data = await open();
    assert.deepEqual(data.configurations(), []);
    assert.equal(data.modelRoute(scope.storeId, scope.rootSessionId), undefined);
    assert.deepEqual(data.callers()[0]!.intent, caller.intent);
    data.close();
    configurationDb = new DatabaseSync(privatePath);
    assert.equal(configurationDb.prepare('PRAGMA user_version').get()!.user_version, 7);
    assertEmptyMcpTable(configurationDb);
    assert.deepEqual(
      oldTables.map((table) =>
        configurationDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
      oldRows,
    );
    configurationDb.close();
    data = await open();
    data.close();
    let corrupt = new DatabaseSync(privatePath);
    const intact = String(
      corrupt
        .prepare('SELECT state FROM recovery_intents WHERE command_id=?')
        .get(recovery.commandId)!.state,
    );
    corrupt
      .prepare('UPDATE recovery_intents SET state=? WHERE command_id=?')
      .run(JSON.stringify({ ...JSON.parse(intact), phase: 'invented' }), recovery.commandId);
    corrupt.close();
    const corruptBytes = readFileSync(privatePath);
    data = await open();
    assert.throws(() => data.recoveries(), /recovery_storage_unavailable/);
    data.close();
    assert.deepEqual(readFileSync(privatePath), corruptBytes);
    corrupt = new DatabaseSync(privatePath);
    corrupt
      .prepare('UPDATE recovery_intents SET state=? WHERE command_id=?')
      .run(intact, recovery.commandId);
    corrupt.close();
    let raw = new DatabaseSync(privatePath);
    raw.exec('PRAGMA user_version=77');
    raw.close();
    const unknownBytes = readFileSync(privatePath);
    data = await open();
    assert.throws(() => data.read(scope), /draft_storage_unavailable/);
    data.close();
    assert.deepEqual(readFileSync(privatePath), unknownBytes);
    raw = new DatabaseSync(privatePath);
    raw.exec('PRAGMA user_version=7');
    raw.prepare('UPDATE drafts SET content=? WHERE id=?').run('{}', draft.id);
    raw.close();
    const damagedRowBytes = readFileSync(privatePath);
    data = await open();
    assert.throws(
      () => data.save(scope, 2, 'overwrite corrupted row'),
      /draft_storage_unavailable/,
    );
    data.close();
    assert.deepEqual(readFileSync(privatePath), damagedRowBytes);
    const alias = join(root, 'db-hardlink');
    linkSync(privatePath, alias);
    data = await open();
    assert.throws(() => data.read(scope), /draft_storage_unavailable/);
    data.close();
    unlinkSync(alias);
    const path = join(profile, 'desktop-private/data.sqlite'),
      bad = Buffer.from('not sqlite: preserve original bytes');
    writeFileSync(path, bad);
    data = await open();
    assert.throws(() => data.read(scope), /draft_storage_unavailable/);
    assert.throws(() => data.save(scope, 0, ''), /draft_storage_unavailable/);
    assert.deepEqual(readFileSync(path), bad);
    data.close();
    console.log('private-node-qualified');
  } finally {
    // The invoking qualification owns and removes the isolated profile root.
  }
}
