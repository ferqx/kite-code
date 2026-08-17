import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '@/core/capabilities/catalog';
import { getFeatureFlags } from '@/core/config/features';
import {
  type AdmittedInvocationV1,
  admitAuthorizedToolInvocationV1,
  authorizePolicyEvaluatedToolV1,
  classifyValidatedToolInvocationV1,
  createToolCallSnapshotV1,
  dispatchAdmittedToolInvocationV1,
  evaluateClassifiedToolPolicyV1,
  resolveToolInvocationV1,
  type ToolInvocationDispatchAdapterV1,
  ToolInvocationPersistenceErrorV1,
  validateResolvedToolInvocationV1,
} from '@/core/execution/tool-pipeline';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import type { GovernedToolInvocationInput } from '@/core/harness/tool-runner';
import {
  capabilityResultDigestV1,
  capabilityResultEvidenceDigestV1,
} from '@/core/persistence/capability-artifacts';
import { createProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type { RuntimeEvent } from '@/core/runtime/events';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import type {
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemProviderV1,
} from '@/protocol/workspace-filesystem-provider';
import { ScriptableFakeWorkspaceFilesystemProviderV1 } from '../helpers/workspace-filesystem-provider';

const THREAD_ID = 'thread-workspace-filesystem-pipeline';
const TURN_ID = 'turn-workspace-filesystem-pipeline';
const FIXED_TIME = new Date('2026-08-17T00:00:00.000Z');
const ARTIFACT_REF = Object.freeze({
  artifactId: `pa_${'a'.repeat(64)}`,
  kind: 'filesystem_preimage' as const,
  integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
  byteLength: 42,
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Workspace filesystem Tool Pipeline', () => {
  test('does not enter observe or prepare when intent acknowledgement fails', async () => {
    const workspace = temporaryWorkspace();
    const authority = authorityV1();
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(authority.verifier());

    for (const fixture of [
      {
        toolName: 'read_file',
        args: { path: 'file.txt' },
        operation: operation({ kind: 'read_file', path: 'file.txt' }),
      },
      {
        toolName: 'write_file',
        args: { path: 'file.txt', content: 'after' },
        operation: operation({ kind: 'write_file', path: 'file.txt', content: 'after' }),
      },
    ]) {
      const persistence = runtimePersistence(workspace, {
        accept: () => false,
      });
      const dispatched = dispatchOperation({
        workspace,
        toolCallId: `call-no-ack-${fixture.toolName}`,
        toolName: fixture.toolName,
        args: fixture.args,
        operation: fixture.operation,
        persistence,
        runtime: runtimeV1(workspace, authority, fake),
      });

      await expect(dispatched).rejects.toBeInstanceOf(ToolInvocationPersistenceErrorV1);
    }

    expect(fake.calls()).toEqual({ observe: 0, prepareMutation: 0, commitMutation: 0 });
  });

  test('rejects builtin tool/operation confusion before intent persistence or Provider entry', async () => {
    const workspace = temporaryWorkspace();
    const authority = authorityV1();
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(authority.verifier());
    const persistence = runtimePersistence(workspace);
    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-operation-confusion',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'write_file', path: 'file.txt', content: 'confused' }),
      persistence,
      runtime: runtimeV1(workspace, authority, fake),
    });

    expect(resultOf(dispatched)).toMatchObject({ ok: false });
    expect(resultOf(dispatched).stderr).toContain('recorded admitted builtin capability');
    expect(fake.calls()).toEqual({ observe: 0, prepareMutation: 0, commitMutation: 0 });
    expect(persistence.eventTypes).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
    ]);
  });

  test('filesystem intent persistence failure performs zero Provider calls', async () => {
    const workspace = temporaryWorkspace();
    const authority = authorityV1();
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(authority.verifier());
    const persistence = runtimePersistence(workspace, {
      accept: (events) =>
        !events.some((event) => event.type === 'capability.filesystem_intent_recorded'),
    });
    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-filesystem-intent-rejected',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'read_file', path: 'file.txt' }),
      persistence,
      runtime: runtimeV1(workspace, authority, fake),
    });

    expect(resultOf(dispatched)).toMatchObject({ ok: false });
    expect(resultOf(dispatched).stderr).toContain('intent acknowledgement failed');
    expect(fake.calls()).toEqual({ observe: 0, prepareMutation: 0, commitMutation: 0 });
  });

  test('rejects self-asserted approved_external scope without recorded authorization', async () => {
    const workspace = temporaryWorkspace();
    const authority = authorityV1();
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(authority.verifier());
    const persistence = runtimePersistence(workspace);
    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-unapproved-external-scope',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: {
        kind: 'read_file',
        path: 'file.txt',
        pathScope: 'approved_external',
      },
      persistence,
      runtime: runtimeV1(workspace, authority, fake),
    });

    expect(resultOf(dispatched)).toMatchObject({ ok: false });
    expect(fake.calls()).toEqual({ observe: 0, prepareMutation: 0, commitMutation: 0 });
    expect(persistence.eventTypes).not.toContain('capability.filesystem_intent_recorded');
  });

  test('admits an explicitly approved external search without a filesystem fallback', async () => {
    const workspace = temporaryWorkspace();
    const external = temporaryWorkspace();
    writeFileSync(join(external, 'visible.txt'), 'external needle\n', 'utf8');
    writeFileSync(join(external, '.gitignore'), 'visible.txt\n', 'utf8');
    const authority = authorityV1();
    const local = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
    let observedMatches: readonly { path: string; line: number; text: string }[] = [];
    const provider: WorkspaceFilesystemProviderV1 = {
      observe: async (input) => {
        const result = await local.observe(input);
        if (result.ok && result.observation.kind === 'search_content') {
          observedMatches = result.observation.matches;
        }
        return result;
      },
      prepareMutation: (input) => local.prepareMutation(input),
      commitMutation: (input) => local.commitMutation(input),
    };
    const persistence = runtimePersistence(workspace);

    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-approved-external-search',
      toolName: 'search_content',
      args: { path: external, pattern: 'needle' },
      operation: {
        kind: 'search_content',
        path: external,
        pattern: 'needle',
        pathScope: 'approved_external',
      },
      approvedCall: true,
      persistence,
      runtime: runtimeV1(workspace, authority, provider),
    });

    expect(resultOf(dispatched)).toMatchObject({ ok: true });
    expect(observedMatches).toHaveLength(1);
    expect(observedMatches[0]?.text).toBe('external needle');
  });

  test('preimage Artifact failure occurs after prepare and guarantees zero commit', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace);

    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-preimage-failure',
      toolName: 'write_file',
      args: { path: 'file.txt', content: 'after' },
      operation: operation({ kind: 'write_file', path: 'file.txt', content: 'after' }),
      persistence,
      runtime: runtimeV1(workspace, authority, provider.value, {
        write: () => {
          throw new Error('synthetic Artifact outage');
        },
      }),
    });

    expect(dispatched.kind).toBe('dispatched');
    if (dispatched.kind !== 'dispatched') throw new Error(dispatched.kind);
    expect(dispatched.value.result).toMatchObject({ ok: false });
    expect(dispatched.value.result.stderr).toContain('preimage Artifact');
    expect(provider.calls()).toEqual({ observe: 0, prepareMutation: 1, commitMutation: 0 });
    expect(readFileSync(target, 'utf8')).toBe('before');
    expect(persistence.eventTypes).not.toContain('capability.filesystem_mutation_ready');
  });

  test('mutation-ready acknowledgement failure guarantees zero commit', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace, {
      accept: (events) =>
        !events.some((event) => event.type === 'capability.filesystem_mutation_ready'),
    });

    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-ready-failure',
      toolName: 'write_file',
      args: { path: 'file.txt', content: 'after' },
      operation: operation({ kind: 'write_file', path: 'file.txt', content: 'after' }),
      persistence,
      runtime: runtimeV1(workspace, authority, provider.value),
    });

    expect(dispatched.kind).toBe('dispatched');
    if (dispatched.kind !== 'dispatched') throw new Error(dispatched.kind);
    expect(dispatched.value.result).toMatchObject({ ok: false });
    expect(dispatched.value.result.stderr).toContain('mutation-ready acknowledgement');
    expect(provider.calls()).toEqual({ observe: 0, prepareMutation: 1, commitMutation: 0 });
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  test('durably acknowledges mutation-ready before granting Provider commit', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const persistence = runtimePersistence(workspace);
    const local = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
    let commitObservedReady = false;
    const provider: WorkspaceFilesystemProviderV1 = {
      observe: (input) => local.observe(input),
      prepareMutation: (input) => local.prepareMutation(input),
      commitMutation: (input) => {
        commitObservedReady =
          persistence.eventTypes.at(-1) === 'capability.filesystem_mutation_ready';
        return local.commitMutation(input);
      },
    };

    const dispatched = await dispatchOperation({
      workspace,
      toolCallId: 'call-ready-before-commit',
      toolName: 'write_file',
      args: { path: 'file.txt', content: 'after' },
      operation: operation({ kind: 'write_file', path: 'file.txt', content: 'after' }),
      persistence,
      runtime: runtimeV1(workspace, authority, provider),
    });

    expect(dispatched.kind).toBe('dispatched');
    if (dispatched.kind !== 'dispatched') throw new Error(dispatched.kind);
    expect(dispatched.value.result).toMatchObject({ ok: true });
    expect(commitObservedReady).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(persistence.eventTypes).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
      'capability.filesystem_intent_recorded',
      'capability.filesystem_mutation_ready',
    ]);
  });

  test('edit requires a committed same-actor read and rejects a stale committed read', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace);
    const runtime = runtimeV1(
      workspace,
      authority,
      provider.value,
      undefined,
      persistence.capabilityArtifacts,
    );

    const missingRead = await dispatchOperation({
      workspace,
      toolCallId: 'call-edit-without-read',
      toolName: 'edit_file',
      args: { path: 'file.txt', old_string: 'before', new_string: 'after' },
      operation: operation({
        kind: 'edit_file',
        path: 'file.txt',
        oldString: 'before',
        newString: 'after',
      }),
      persistence,
      runtime,
    });
    expect(resultOf(missingRead)).toMatchObject({ ok: false });
    expect(resultOf(missingRead).stderr).toContain('read before edit_file');
    expect(provider.calls().commitMutation).toBe(0);

    const read = await dispatchOperation({
      workspace,
      toolCallId: 'call-read-for-edit',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'read_file', path: 'file.txt' }),
      persistence,
      runtime,
    });
    const readResult = resultOf(read);
    expect(readResult.filesystemObservation).toBeDefined();
    const readInvocation = read.kind === 'dispatched' ? read.value.recorded.invocationId : '';
    persistence.commitRead(readInvocation, readResult.filesystemObservation!);

    writeFileSync(target, 'intervening', 'utf8');
    const stale = await dispatchOperation({
      workspace,
      toolCallId: 'call-edit-stale-read',
      toolName: 'edit_file',
      args: { path: 'file.txt', old_string: 'before', new_string: 'after' },
      operation: operation({
        kind: 'edit_file',
        path: 'file.txt',
        oldString: 'before',
        newString: 'after',
      }),
      persistence,
      runtime,
    });
    expect(resultOf(stale)).toMatchObject({ ok: false });
    expect(resultOf(stale).stderr).toContain('changed after the committed read');
    expect(provider.calls().commitMutation).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('intervening');
  });

  test('committed same-actor read admits a matching edit', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace);
    const runtime = runtimeV1(
      workspace,
      authority,
      provider.value,
      undefined,
      persistence.capabilityArtifacts,
    );

    const read = await dispatchOperation({
      workspace,
      toolCallId: 'call-current-read',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'read_file', path: 'file.txt' }),
      persistence,
      runtime,
    });
    const readResult = resultOf(read);
    const readInvocation = read.kind === 'dispatched' ? read.value.recorded.invocationId : '';
    persistence.commitRead(readInvocation, readResult.filesystemObservation!);

    const edit = await dispatchOperation({
      workspace,
      toolCallId: 'call-current-edit',
      toolName: 'edit_file',
      args: { path: 'file.txt', old_string: 'before', new_string: 'after' },
      operation: operation({
        kind: 'edit_file',
        path: 'file.txt',
        oldString: 'before',
        newString: 'after',
      }),
      persistence,
      runtime,
    });

    expect(resultOf(edit)).toMatchObject({ ok: true });
    expect(provider.calls().commitMutation).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('after');
  });

  test('edit rejects observation authority whose durable intent targets different lexical bytes', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace);
    const runtime = runtimeV1(
      workspace,
      authority,
      provider.value,
      undefined,
      persistence.capabilityArtifacts,
    );
    const read = await dispatchOperation({
      workspace,
      toolCallId: 'call-mismatched-lexical-read',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'read_file', path: 'file.txt' }),
      persistence,
      runtime,
    });
    const readInvocation = read.kind === 'dispatched' ? read.value.recorded.invocationId : '';
    persistence.commitRead(readInvocation, resultOf(read).filesystemObservation!);
    const prior = persistence.getState().capabilities.invocations[readInvocation]!;
    prior.filesystemIntent = {
      ...prior.filesystemIntent!,
      lexicalTargetDigest: `sha256:${'f'.repeat(64)}`,
    };

    const edit = await dispatchOperation({
      workspace,
      toolCallId: 'call-after-mismatched-lexical-read',
      toolName: 'edit_file',
      args: { path: 'file.txt', old_string: 'before', new_string: 'after' },
      operation: operation({
        kind: 'edit_file',
        path: 'file.txt',
        oldString: 'before',
        newString: 'after',
      }),
      persistence,
      runtime,
    });

    expect(resultOf(edit)).toMatchObject({ ok: false });
    expect(resultOf(edit).stderr).toContain('read before edit_file');
    expect(provider.calls().commitMutation).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  test('edit rejects mutation observation authority with mismatched ready operation evidence', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace);
    const runtime = runtimeV1(
      workspace,
      authority,
      provider.value,
      undefined,
      persistence.capabilityArtifacts,
    );
    const write = await dispatchOperation({
      workspace,
      toolCallId: 'call-mismatched-ready-write',
      toolName: 'write_file',
      args: { path: 'file.txt', content: 'before' },
      operation: operation({ kind: 'write_file', path: 'file.txt', content: 'before' }),
      persistence,
      runtime,
    });
    const writeInvocation = write.kind === 'dispatched' ? write.value.recorded.invocationId : '';
    persistence.commitRead(writeInvocation, resultOf(write).filesystemObservation!);
    const prior = persistence.getState().capabilities.invocations[writeInvocation]!;
    prior.filesystemMutationReady = {
      ...prior.filesystemMutationReady!,
      operationDigest: `sha256:${'f'.repeat(64)}`,
    };

    const edit = await dispatchOperation({
      workspace,
      toolCallId: 'call-after-mismatched-ready-write',
      toolName: 'edit_file',
      args: { path: 'file.txt', old_string: 'before', new_string: 'after' },
      operation: operation({
        kind: 'edit_file',
        path: 'file.txt',
        oldString: 'before',
        newString: 'after',
      }),
      persistence,
      runtime,
    });

    expect(resultOf(edit)).toMatchObject({ ok: false });
    expect(resultOf(edit).stderr).toContain('read before edit_file');
    expect(provider.calls().commitMutation).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  test('edit rejects a committed observation whose Artifact owner binding is mismatched', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const authority = authorityV1();
    const provider = countedLocalProvider(authority);
    const persistence = runtimePersistence(workspace);
    const readRuntime = runtimeV1(
      workspace,
      authority,
      provider.value,
      undefined,
      persistence.capabilityArtifacts,
    );
    const read = await dispatchOperation({
      workspace,
      toolCallId: 'call-owner-bound-read',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'read_file', path: 'file.txt' }),
      persistence,
      runtime: readRuntime,
    });
    const readResult = resultOf(read);
    const readInvocation = read.kind === 'dispatched' ? read.value.recorded.invocationId : '';
    persistence.commitRead(readInvocation, readResult.filesystemObservation!);
    const mismatchedArtifacts = {
      read: persistence.capabilityArtifacts.read,
      readEnvelope: (ref: import('@/protocol/capabilities').CapabilityArtifactRef) => ({
        ...persistence.capabilityArtifacts.readEnvelope(ref),
        invocationId: 'different-invocation',
      }),
    };

    const edit = await dispatchOperation({
      workspace,
      toolCallId: 'call-owner-mismatch-edit',
      toolName: 'edit_file',
      args: { path: 'file.txt', old_string: 'before', new_string: 'after' },
      operation: operation({
        kind: 'edit_file',
        path: 'file.txt',
        oldString: 'before',
        newString: 'after',
      }),
      persistence,
      runtime: runtimeV1(workspace, authority, provider.value, undefined, mismatchedArtifacts),
    });

    expect(resultOf(edit)).toMatchObject({ ok: false });
    expect(resultOf(edit).stderr).toContain('Committed read evidence is missing');
    expect(provider.calls().commitMutation).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('before');
  });

  test('typed Fake denial never falls through to Local filesystem behavior', async () => {
    const workspace = temporaryWorkspace();
    const target = join(workspace, 'file.txt');
    writeFileSync(target, 'untouched', 'utf8');
    const authority = authorityV1();
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(authority.verifier());
    const persistence = runtimePersistence(workspace);
    const runtime = runtimeV1(workspace, authority, fake);

    const read = await dispatchOperation({
      workspace,
      toolCallId: 'call-fake-read',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      operation: operation({ kind: 'read_file', path: 'file.txt' }),
      persistence,
      runtime,
    });
    expect(resultOf(read).stderr).toContain('Scriptable Fake denied observe');

    const write = await dispatchOperation({
      workspace,
      toolCallId: 'call-fake-write',
      toolName: 'write_file',
      args: { path: 'file.txt', content: 'changed' },
      operation: operation({ kind: 'write_file', path: 'file.txt', content: 'changed' }),
      persistence,
      runtime,
    });
    expect(resultOf(write).stderr).toContain('Scriptable Fake denied prepare_mutation');
    expect(fake.calls()).toEqual({ observe: 1, prepareMutation: 1, commitMutation: 0 });
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  test('Pipeline seals the exact current protected projection before Provider entry', async () => {
    const workspace = temporaryWorkspace();
    const authority = authorityV1();
    let boundary:
      | import('@/protocol/workspace-filesystem-provider').WorkspaceFilesystemProtectedBoundaryV1
      | null = null;
    const fake = new ScriptableFakeWorkspaceFilesystemProviderV1(authority.verifier(), {
      observe: ({ grant }) => {
        boundary = grant.protectedBoundary;
        return {
          ok: false,
          failure: { code: 'fake_denied', message: 'projection captured' },
        };
      },
    });
    const persistence = runtimePersistence(workspace);
    const outcome = await dispatchOperation({
      workspace,
      toolCallId: 'call-search-boundary-projection',
      toolName: 'search_files',
      args: { pattern: '*', path: '.' },
      operation: operation({ kind: 'search_files', path: '.', pattern: '*' }),
      persistence,
      runtime: runtimeV1(workspace, authority, fake),
    });

    expect(resultOf(outcome).stderr).toContain('projection captured');
    expect(boundary).not.toBeNull();
    expect(boundary!.excludedSubtrees).toContain('.kite-code');
    expect(boundary!.excludedFiles).toContain('.env');
    expect(boundary!.canonicalWorkspace).toBe(realpathSync(workspace));
    const invocationId = outcome.kind === 'dispatched' ? outcome.value.recorded.invocationId : '';
    expect(
      persistence.getState().capabilities.invocations[invocationId]?.filesystemIntent
        ?.searchBoundaryDigest,
    ).toBe(boundary!.boundaryDigest);
    expect(fake.calls()).toEqual({ observe: 1, prepareMutation: 0, commitMutation: 0 });
  });

  test('sealed protected boundary rejects a gate-to-Provider read symlink swap without disclosure', async () => {
    if (process.platform === 'win32') return;
    const workspace = temporaryWorkspace();
    const visible = join(workspace, 'visible.txt');
    const protectedFile = join(workspace, '.env');
    const alias = join(workspace, 'safe-read.txt');
    writeFileSync(visible, 'visible\n', 'utf8');
    writeFileSync(protectedFile, 'protected-secret\n', 'utf8');
    symlinkSync(visible, alias);
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });
    expect(evaluator.evaluate({ path: 'safe-read.txt', operation: 'read' }).outcome).toBe('allow');

    const authority = authorityV1();
    const local = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
    let providerEntered = false;
    const provider: WorkspaceFilesystemProviderV1 = {
      observe: (input) => {
        providerEntered = true;
        unlinkSync(alias);
        symlinkSync(protectedFile, alias);
        return local.observe(input);
      },
      prepareMutation: (input) => local.prepareMutation(input),
      commitMutation: (input) => local.commitMutation(input),
    };
    const persistence = runtimePersistence(workspace);
    const outcome = await dispatchOperation({
      workspace,
      toolCallId: 'call-protected-read-swap',
      toolName: 'read_file',
      args: { path: 'safe-read.txt' },
      operation: operation({ kind: 'read_file', path: 'safe-read.txt' }),
      persistence,
      runtime: runtimeV1(workspace, authority, provider),
    });

    expect(providerEntered).toBe(true);
    expect(persistence.eventTypes).toContain('capability.filesystem_intent_recorded');
    expect(resultOf(outcome)).toMatchObject({ ok: false });
    expect(resultOf(outcome).stdout).not.toContain('protected-secret');
    expect(resultOf(outcome).stderr).toContain('sealed path boundary');
  });

  test('sealed protected boundary rejects gate-to-Provider write/edit parent swaps with zero mutation', async () => {
    if (process.platform === 'win32') return;
    for (const kind of ['write_file', 'edit_file'] as const) {
      const workspace = temporaryWorkspace();
      const safeDirectory = join(workspace, `safe-${kind}`);
      const movedDirectory = join(workspace, `moved-${kind}`);
      const protectedDirectory = join(workspace, '.kite-code');
      mkdirSync(safeDirectory);
      mkdirSync(protectedDirectory);
      writeFileSync(join(safeDirectory, 'target.txt'), 'safe-before\n', 'utf8');
      writeFileSync(join(protectedDirectory, 'target.txt'), 'protected-before\n', 'utf8');
      const lexicalPath = `safe-${kind}/target.txt`;
      const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });
      expect(evaluator.evaluate({ path: lexicalPath, operation: 'write' }).outcome).toBe('allow');

      const authority = authorityV1();
      const local = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
      let providerEntered = false;
      const provider: WorkspaceFilesystemProviderV1 = {
        observe: (input) => local.observe(input),
        prepareMutation: (input) => {
          providerEntered = true;
          renameSync(safeDirectory, movedDirectory);
          symlinkSync(protectedDirectory, safeDirectory);
          return local.prepareMutation(input);
        },
        commitMutation: (input) => local.commitMutation(input),
      };
      const persistence = runtimePersistence(workspace);
      const args =
        kind === 'write_file'
          ? { path: lexicalPath, content: 'unsafe-after\n' }
          : { path: lexicalPath, old_string: 'protected-before\n', new_string: 'unsafe-after\n' };
      const filesystemOperation: WorkspaceFilesystemOperationV1 =
        kind === 'write_file'
          ? operation({ kind, path: lexicalPath, content: 'unsafe-after\n' })
          : operation({
              kind,
              path: lexicalPath,
              oldString: 'protected-before\n',
              newString: 'unsafe-after\n',
            });
      const outcome = await dispatchOperation({
        workspace,
        toolCallId: `call-protected-${kind}-swap`,
        toolName: kind,
        args,
        operation: filesystemOperation,
        persistence,
        runtime: runtimeV1(workspace, authority, provider),
      });

      expect(providerEntered).toBe(true);
      expect(persistence.eventTypes).toContain('capability.filesystem_intent_recorded');
      expect(persistence.eventTypes).not.toContain('capability.filesystem_mutation_ready');
      expect(resultOf(outcome)).toMatchObject({ ok: false });
      expect(readFileSync(join(protectedDirectory, 'target.txt'), 'utf8')).toBe(
        'protected-before\n',
      );
      expect(readFileSync(join(movedDirectory, 'target.txt'), 'utf8')).toBe('safe-before\n');
    }
  });
});

function admittedInvocation(input: {
  workspace: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  approvedCall?: boolean;
}): Readonly<AdmittedInvocationV1> {
  const snapshot = createToolCallSnapshotV1({
    toolCallId: input.toolCallId,
    name: input.toolName,
    rawArguments: input.args,
    createdAtTurnId: TURN_ID,
  });
  if (!snapshot.ok) throw new Error(snapshot.failure.code);
  const catalogRevision = createSnapshot([]).revision;
  const resolved = resolveToolInvocationV1(snapshot.value, {
    currentTurnId: TURN_ID,
    catalogRevision,
    availabilityContext: {
      workspace: input.workspace,
      phase: 'building',
      hasTaskAdapter: true,
      availableSkillIds: [],
      featureFlags: getFeatureFlags(),
    },
    bindings: [],
    descriptors: [],
    disclosures: [],
  });
  if (!resolved.ok) throw new Error(resolved.failure.code);
  const validated = validateResolvedToolInvocationV1(resolved.value);
  if (!validated.ok) throw new Error(validated.failure.code);
  const classified = classifyValidatedToolInvocationV1(validated.value);
  if (!classified.ok) throw new Error(classified.failure.code);
  const policyContext = {
    phase: 'building' as const,
    workspace: input.workspace,
    threadId: THREAD_ID,
    authorization: { mode: 'default' as const, commandGrants: {} },
    interactionMode: 'accept_edits' as const,
    planKind: 'building_without_plan' as const,
    circuitBreakerTripped: false,
    callStatus: input.approvedCall ? ('approved' as const) : ('queued' as const),
    gates: {
      recoveryAdmission: 'admitted' as const,
      boundedCancellation: 'admitted' as const,
      executionBoundary: 'admitted' as const,
      skillCapabilityCeiling: 'admitted' as const,
    },
  };
  const policy = evaluateClassifiedToolPolicyV1(classified.value, policyContext);
  if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
  const authorization = authorizePolicyEvaluatedToolV1(policy.value, policyContext);
  if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);
  const admission = admitAuthorizedToolInvocationV1(authorization.value, {
    reservationRequired: false,
    reservationIds: [],
    freshness: 'current',
  });
  if (admission.kind !== 'continue') throw new Error(admission.terminal.kind);
  return admission.value;
}

function dispatchOperation(input: {
  workspace: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  approvedCall?: boolean;
  operation: WorkspaceFilesystemOperationV1;
  persistence: ReturnType<typeof runtimePersistence>;
  runtime: NonNullable<Parameters<typeof dispatchAdmittedToolInvocationV1>[2]['filesystemRuntime']>;
}) {
  const admitted = admittedInvocation(input);
  const adapter: ToolInvocationDispatchAdapterV1 = {
    dispatch: async (invocation) => {
      await invocation.beforeDispatch?.();
      const result = await invocation.workspaceFilesystem!.dispatch(input.operation);
      return providerResult(result, input.operation.kind);
    },
  };
  return dispatchAdmittedToolInvocationV1(
    admitted,
    governedInput(input),
    {
      threadId: THREAD_ID,
      toolCallId: input.toolCallId,
      now: () => FIXED_TIME,
      persistence: input.persistence,
      filesystemRuntime: input.runtime,
    },
    adapter,
  );
}

function governedInput(input: {
  workspace: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): GovernedToolInvocationInput {
  return {
    workspace: input.workspace,
    request: {
      source: 'builtin',
      id: input.toolCallId,
      name: input.toolName,
      args: input.args,
      reason: 'PS-01 Pipeline test',
      protectedCommand: '',
    } as GovernedToolInvocationInput['request'],
  };
}

function providerResult(
  result: Awaited<
    ReturnType<NonNullable<GovernedToolInvocationInput['workspaceFilesystem']>['dispatch']>
  >,
  command: string,
): ToolExecutionResult {
  if (!result.ok) {
    return {
      ok: false,
      command,
      exitCode: -1,
      stdout: '',
      stderr: result.failure.message,
      status: 'error',
    };
  }
  return {
    ok: true,
    command,
    exitCode: 0,
    stdout: result.observation.kind,
    stderr: '',
    status: 'success',
    ...(result.filesystemObservation
      ? { filesystemObservation: result.filesystemObservation }
      : {}),
  };
}

function resultOf(outcome: Awaited<ReturnType<typeof dispatchOperation>>): ToolExecutionResult {
  if (outcome.kind !== 'dispatched') throw new Error(outcome.kind);
  return outcome.value.result;
}

function runtimePersistence(
  workspace: string,
  options: { accept?: (events: RuntimeEvent[]) => boolean } = {},
) {
  let state = createInitialRuntimeState({
    threadId: THREAD_ID,
    userId: 'test',
    workspace,
  });
  const eventTypes: RuntimeEvent['type'][] = [];
  const artifacts = new Map<
    string,
    {
      invocationId: string;
      result: import('@/protocol/capabilities').CapabilityResult;
    }
  >();
  const capabilityArtifacts = {
    read: (ref: import('@/protocol/capabilities').CapabilityArtifactRef) => {
      const value = artifacts.get(ref.artifactId);
      if (!value) throw new Error('missing test Artifact');
      return value.result;
    },
    readEnvelope: (ref: import('@/protocol/capabilities').CapabilityArtifactRef) => {
      const value = artifacts.get(ref.artifactId);
      if (!value) throw new Error('missing test Artifact');
      return {
        artifactFormatVersion: 2 as const,
        invocationId: value.invocationId,
        result: value.result,
      };
    },
  };
  return {
    eventTypes,
    capabilityArtifacts,
    getState: () => state,
    persistEvents: async (events: RuntimeEvent[]) => {
      if (options.accept && !options.accept(events)) return false;
      for (const event of events) {
        eventTypes.push(event.type);
        state = reduceRuntimeState(state, event);
      }
      return true;
    },
    commitRead(
      invocationId: string,
      observation: NonNullable<ToolExecutionResult['filesystemObservation']>,
    ) {
      const artifact = {
        artifactId: `pa_${invocationId.slice(0, 64).padEnd(64, 'a')}`,
        kind: 'capability_result' as const,
        integrityIdentifier: `hmac-sha256:${'e'.repeat(64)}`,
        byteLength: 1,
      };
      const result = {
        status: 'success',
        content: [],
        structuredContent: { filesystemObservation: observation },
      } satisfies import('@/protocol/capabilities').CapabilityResult;
      artifacts.set(artifact.artifactId, { invocationId, result });
      state = reduceRuntimeState(state, {
        type: 'capability.execution_succeeded',
        invocationId,
        resultDigest: capabilityResultDigestV1(result),
        evidenceDigest: capabilityResultEvidenceDigestV1(result),
        finishedAt: '2026-08-17T00:00:01.000Z',
        artifact,
        filesystemObservation: observation,
      });
    },
  } satisfies {
    eventTypes: RuntimeEvent['type'][];
    capabilityArtifacts: {
      read(
        ref: import('@/protocol/capabilities').CapabilityArtifactRef,
      ): import('@/protocol/capabilities').CapabilityResult;
      readEnvelope(ref: import('@/protocol/capabilities').CapabilityArtifactRef): {
        artifactFormatVersion: 2;
        invocationId: string;
        result: import('@/protocol/capabilities').CapabilityResult;
      };
    };
    getState(): Readonly<RuntimeState>;
    persistEvents(events: RuntimeEvent[]): Promise<boolean>;
    commitRead(
      invocationId: string,
      observation: NonNullable<ToolExecutionResult['filesystemObservation']>,
    ): void;
  };
}

function authorityV1(): WorkspaceFilesystemGrantAuthorityV1 {
  let grant = 0;
  return new WorkspaceFilesystemGrantAuthorityV1({
    integrityKey: new Uint8Array(32).fill(7),
    now: () => FIXED_TIME.getTime(),
    idSource: () => `pipeline-grant-${++grant}`,
  });
}

function runtimeV1(
  workspace: string,
  authority: WorkspaceFilesystemGrantAuthorityV1,
  provider: WorkspaceFilesystemProviderV1,
  preimageArtifacts: {
    write: NonNullable<
      Parameters<typeof dispatchAdmittedToolInvocationV1>[2]['filesystemRuntime']
    >['preimageArtifacts']['write'];
  } = { write: () => ARTIFACT_REF },
  capabilityArtifacts?: import('@/core/persistence/capability-artifacts').CapabilityArtifactReaderV1,
) {
  return {
    canonicalWorkspace: realpathSync(workspace),
    provider,
    grants: authority,
    preimageArtifacts,
    ...(capabilityArtifacts ? { capabilityArtifacts } : {}),
    grantTtlMs: 1_000,
  };
}

function countedLocalProvider(authority: WorkspaceFilesystemGrantAuthorityV1) {
  const local = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
  const count = { observe: 0, prepareMutation: 0, commitMutation: 0 };
  const value: WorkspaceFilesystemProviderV1 = {
    observe: (input) => {
      count.observe++;
      return local.observe(input);
    },
    prepareMutation: (input) => {
      count.prepareMutation++;
      return local.prepareMutation(input);
    },
    commitMutation: (input) => {
      count.commitMutation++;
      return local.commitMutation(input);
    },
  };
  return {
    value,
    calls: () => Object.freeze({ ...count }),
  };
}

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-workspace-pipeline-'));
  roots.push(workspace);
  return workspace;
}

function operation(
  input: WithoutPathScope<WorkspaceFilesystemOperationV1>,
): WorkspaceFilesystemOperationV1 {
  return { ...input, pathScope: 'workspace_only' } as WorkspaceFilesystemOperationV1;
}

type WithoutPathScope<Operation> = Operation extends unknown ? Omit<Operation, 'pathScope'> : never;
