import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semanticDigest } from '../../../src/json';
import { selectProfile } from '../../../src/profile';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { OwnerRef } from '../../../src/storage/types';

async function denied(p: Promise<unknown>, code: string) {
  const error = await p.catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as { code: string }).code).toBe(code);
}
async function fixture(
  mode:
    | 'planned'
    | 'unstarted'
    | 'started'
    | 'dispatching'
    | 'approval'
    | 'tool'
    | 'completion'
    | 'length'
    | 'follow_up' = 'planned',
  keepOwner = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'kite-run-resume-store-')),
    dataRoot = join(directory, 'data'),
    profile = { dataRoot, profile: 'test' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(dataRoot).href,
    name: 'w',
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: 'create',
    workspaceId: 'w',
    title: 's',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: 'work',
    request:
      mode === 'follow_up'
        ? {
            kind: 'input.follow_up',
            content: 'fixed planned boundary',
            afterRunId: null,
            contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
          }
        : { kind: 'run.start', content: 'fixed planned boundary' },
  });
  const originalOwner = (await store.acquireSessionOwner('s', 'original'))!;
  const configuration = { model: 'fixed', extensionVersion: '1' },
    run =
      mode === 'follow_up'
        ? (
            await store.applyInput({
              expectedStoreId,
              owner: originalOwner,
              commandId: 'work',
              kind: 'follow_up',
              configuration,
            })
          ).run
        : await store.startRun({
            expectedStoreId,
            owner: originalOwner,
            commandId: 'work',
            configuration,
          });
  if (mode !== 'unstarted')
    await store.beginRunRequirementsInitialization({
      expectedStoreId,
      owner: originalOwner,
      runId: run.id,
    });
  if (mode !== 'unstarted' && mode !== 'started') {
    await store.registerRunRequirements({
      expectedStoreId,
      owner: originalOwner,
      runId: run.id,
      requirements: [],
      initialize: true,
    });
    await store.planExecution({
      expectedStoreId,
      owner: originalOwner,
      sessionId: 's',
      runId: run.id,
      executionId: 'model',
      originCommandId: 'work',
      stepId: 'step',
      callId: 'model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: { messages: [], modelId: 'fixed' },
      decisionSource: { kind: 'fixed' },
    });
  }
  if (mode === 'dispatching' || mode === 'tool' || mode === 'completion' || mode === 'length')
    await store.markDispatching({
      expectedStoreId,
      owner: originalOwner,
      executionId: 'model',
      authorization: {
        allowed: true,
        revision: 'fixed',
        definitionVersion: '1',
        inputDigest: await semanticDigest({ messages: [], modelId: 'fixed' }),
      },
      requirements: [],
      freshness: { checked: true, source: { kind: 'fixed' } },
    });
  if (mode === 'tool' || mode === 'completion' || mode === 'length') {
    await store.finishExecution({
      expectedStoreId,
      owner: originalOwner,
      executionId: 'model',
      status: 'succeeded',
      result: {
        content: 'complete fixed result',
        reasoning: '',
        finishReason: mode === 'tool' ? 'tool_calls' : mode === 'length' ? 'length' : 'stop',
        toolCalls: mode === 'tool' ? [{ id: 'call', name: 'fixture.tool', arguments: '{}' }] : [],
      },
      ...(mode === 'tool'
        ? {
            message: {
              role: 'assistant' as const,
              content: 'complete fixed result',
              toolCalls: [{ id: 'call', name: 'fixture.tool', arguments: '{}' }],
              sourceIds: ['model'],
            },
          }
        : {}),
    });
    if (mode === 'tool')
      await store.planExecution({
        expectedStoreId,
        owner: originalOwner,
        sessionId: 's',
        runId: run.id,
        executionId: 'tool',
        originCommandId: 'work',
        stepId: 'step',
        callId: 'call',
        kind: 'tool',
        definitionId: 'fixture.tool',
        definitionVersion: '1',
        input: {},
        decisionSource: { kind: 'model_decision', modelExecutionId: 'model', sources: [] },
      });
  }
  const interaction =
    mode === 'approval'
      ? await store.requestInteraction({
          expectedStoreId,
          owner: originalOwner,
          interactionId: 'original-approval',
          executionId: 'model',
          attempt: 1,
          kind: 'approval',
          definitionId: 'fixed',
          definitionVersion: '1',
          inputDigest: await semanticDigest({ messages: [], modelId: 'fixed' }),
          policyRevision: 'fixed',
          requiredRefs: [],
          source: { kind: 'fixed' },
          request: { description: 'original approval' },
        })
      : null;
  const original = await store.getExecution('model');
  if (!keepOwner) {
    await store.close();
    store = await openSqliteStore(profile);
  }
  const input = {
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: 'resume',
    runId: run.id,
    expectedOwnerGeneration: originalOwner.generation,
  };
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  return {
    store,
    profile,
    configuration,
    run,
    original,
    originalOwner,
    interaction,
    input,
    db,
    async close() {
      db.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('same Store planned resume acquires restricted real root lock then adopts original attempt once', async () => {
  const f = await fixture();
  try {
    const state = await f.store.verifyRunResume(f.input);
    expect(state.checkpoint!.boundary).toBe('before_model_dispatch');
    expect(state.requirementsInitialized).toBe(true);
    const begun = await f.store.beginRunResume({
      ...f.input,
      checkpoint: state.checkpoint!,
      instanceId: 'new',
    });
    expect(begun.command.receipt).toBeNull();
    expect(begun.lease).not.toBeNull();
    await denied(
      f.store.planExecution({
        expectedStoreId: f.input.expectedStoreId,
        owner: begun.lease as unknown as OwnerRef,
        sessionId: 's',
        runId: f.run.id,
        executionId: 'illegal',
        originCommandId: 'work',
        stepId: 'illegal',
        callId: 'illegal',
        kind: 'tool',
        definitionId: 'fixed',
        definitionVersion: '1',
        input: {},
        decisionSource: { kind: 'fixed' },
      }),
      'owner_changed',
    );
    await denied(
      f.store.finishRun({
        expectedStoreId: f.input.expectedStoreId,
        owner: begun.lease as unknown as OwnerRef,
        runId: f.run.id,
        status: 'completed',
        requirements: [],
      }),
      'owner_changed',
    );
    expect((await f.store.getRun(f.run.id))!.isActive).toBe(true);
    const peer = await openSqliteStore(f.profile);
    try {
      await denied(
        peer.beginRunResume({
          ...f.input,
          commandId: 'peer',
          expectedOwnerGeneration: begun.lease!.generation,
          checkpoint: state.checkpoint!,
          instanceId: 'peer',
        }),
        'owner_busy',
      );
    } finally {
      await peer.close();
    }
    expect(await f.store.listAcceptedCommands('s')).toEqual([]);
    await denied(
      f.store.commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: { changed: true },
        checkpoint: state.checkpoint!,
      }),
      'run_configuration_changed',
    );
    const committed = await f.store.commitRunResume({
      expectedStoreId: f.input.expectedStoreId,
      lease: begun.lease!,
      expectedConfiguration: f.configuration,
      checkpoint: state.checkpoint!,
    });
    expect(committed.run.id).toBe(f.run.id);
    expect(committed.command.receipt).toEqual({
      outcome: 'run_resumed',
      runId: f.run.id,
      boundary: 'before_model_dispatch',
      originalCommandId: 'work',
    });
    expect(await f.store.getExecution('model')).toEqual({
      ...f.original!,
      ownerGeneration: committed.owner.generation,
    });
    await denied(
      f.store.finishExecution({
        expectedStoreId: f.input.expectedStoreId,
        owner: f.originalOwner,
        executionId: 'model',
        status: 'cancelled',
        result: { outcome: 'cancelled', content: 'old callback' },
      }),
      'owner_changed',
    );
    expect(
      (
        await f.store.beginRunResume({
          ...f.input,
          checkpoint: state.checkpoint!,
          instanceId: 'again',
        })
      ).lease,
    ).toBeNull();
    await f.store.finishExecution({
      expectedStoreId: f.input.expectedStoreId,
      owner: committed.owner,
      executionId: 'model',
      status: 'cancelled',
      result: { outcome: 'cancelled', content: 'test finish' },
    });
    await f.store.finishRun({
      expectedStoreId: f.input.expectedStoreId,
      owner: committed.owner,
      runId: f.run.id,
      status: 'completed',
      requirements: [],
    });
    expect(await f.store.releaseSessionOwner(committed.owner)).toBe(true);
    expect((await f.store.verifyRunResume(f.input)).command!.receipt).toEqual(
      committed.command.receipt,
    );
    await denied(
      f.store.verifyRunResume({
        ...f.input,
        commandId: 'another',
        expectedOwnerGeneration: committed.owner.generation,
      }),
      'run_not_active',
    );
  } finally {
    await f.close();
  }
});

test('unstarted initialization may enter once; started initializer closure cannot replay', async () => {
  const f = await fixture('unstarted');
  try {
    const state = await f.store.verifyRunResume(f.input);
    expect(state.checkpoint!.initializationState).toBe('unstarted');
    const begun = await f.store.beginRunResume({
      ...f.input,
      checkpoint: state.checkpoint!,
      instanceId: 'new',
    });
    const committed = await f.store.commitRunResume({
      expectedStoreId: f.input.expectedStoreId,
      lease: begun.lease!,
      expectedConfiguration: f.configuration,
      checkpoint: state.checkpoint!,
    });
    await f.store.beginRunRequirementsInitialization({
      expectedStoreId: f.input.expectedStoreId,
      owner: committed.owner,
      runId: f.run.id,
    });
    await denied(
      f.store.beginRunRequirementsInitialization({
        expectedStoreId: f.input.expectedStoreId,
        owner: committed.owner,
        runId: f.run.id,
      }),
      'run_initialization_state_changed',
    );
    await f.store.registerRunRequirements({
      expectedStoreId: f.input.expectedStoreId,
      owner: committed.owner,
      runId: f.run.id,
      requirements: [],
      initialize: true,
    });
  } finally {
    await f.close();
  }
  const started = await fixture('started');
  try {
    await denied(started.store.verifyRunResume(started.input), 'run_initialization_incomplete');
    expect(await started.store.getCommand('resume')).toBeNull();
  } finally {
    await started.close();
  }
});

test('dispatching original Model never becomes a resume checkpoint', async () => {
  const f = await fixture('dispatching');
  try {
    await denied(f.store.verifyRunResume(f.input), 'run_resume_checkpoint_unavailable');
    expect(await f.store.getCommand('resume')).toBeNull();
    expect(await f.store.getExecution('model')).toEqual(f.original);
  } finally {
    await f.close();
  }
});

test('read preflight rejects identity and actor without writes; preparation cancellation stops commit only', async () => {
  const f = await fixture();
  try {
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await denied(
      f.store.verifyRunResume({ ...f.input, subjectId: 'foreign' }),
      'permission_denied',
    );
    await denied(
      f.store.verifyRunResume({ ...f.input, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await denied(
      f.store.verifyRunResume({ ...f.input, expectedOwnerGeneration: '99' }),
      'owner_changed',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const state = await f.store.verifyRunResume(f.input),
      begun = await f.store.beginRunResume({
        ...f.input,
        checkpoint: state.checkpoint!,
        instanceId: 'new',
      });
    await f.store.cancelCommand({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-preparation',
      targetCommandId: 'resume',
    });
    await denied(
      f.store.commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: state.checkpoint!,
      }),
      'run_resume_cancelled',
    );
    expect((await f.store.getCommand('resume'))!.status).toBe('accepted');
    expect((await f.store.getCommand('resume'))!.receipt).toBeNull();
    expect((await f.store.getCommand('work'))!.cancelRequestedAt).toBeNull();
    expect(await f.store.getExecution('model')).toEqual(f.original);
    await f.store.releaseRunResumeLease(begun.lease!);
    expect(
      (
        await f.store.beginRunResume({
          ...f.input,
          checkpoint: state.checkpoint!,
          instanceId: 'repeat',
        })
      ).lease,
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('faulted preparation and changed original selection atomically refuse resume', async () => {
  const f = await fixture();
  try {
    const state = await f.store.verifyRunResume(f.input),
      cursor = (await f.store.getMetadata()).lastChangeCursor;
    f.db.run(
      "CREATE TRIGGER fail_resume BEFORE INSERT ON change_event WHEN NEW.type='run.resume_prepared' BEGIN SELECT RAISE(ABORT,'fixture fault'); END",
    );
    const error = await f.store
      .beginRunResume({ ...f.input, checkpoint: state.checkpoint!, instanceId: 'new' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(await f.store.getCommand('resume')).toBeNull();
    expect((await f.store.getSession('s'))!.ownerGeneration).toBe(f.input.expectedOwnerGeneration);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    f.db.run('DROP TRIGGER fail_resume');
    // SQL fault injection represents stale/corrupt scope, not evidence that a business rewind is permitted in an active Run.
    f.db.run("UPDATE run SET context_selection_id='foreign-selection' WHERE id=?", [f.run.id]);
    await denied(f.store.verifyRunResume(f.input), 'context_selection_changed');
  } finally {
    await f.close();
  }
});

test('planned approval resumes its exact pending authority without changing Interaction or attempt', async () => {
  const f = await fixture('approval');
  try {
    const state = await f.store.verifyRunResume(f.input);
    expect(state.run.status).toBe('waiting_interaction');
    const begun = await f.store.beginRunResume({
      ...f.input,
      checkpoint: state.checkpoint!,
      instanceId: 'new',
    });
    const committed = await f.store.commitRunResume({
      expectedStoreId: f.input.expectedStoreId,
      lease: begun.lease!,
      expectedConfiguration: f.configuration,
      checkpoint: state.checkpoint!,
    });
    expect(
      await f.store.getInteraction({
        expectedStoreId: f.input.expectedStoreId,
        interactionId: 'original-approval',
        sessionId: 's',
      }),
    ).toEqual(f.interaction);
    expect(committed.executions.find((e) => e.id === 'model')!.attempt).toBe(f.original!.attempt);
    expect(committed.run.status).toBe('waiting_interaction');
  } finally {
    await f.close();
  }
});

for (const mode of ['tool', 'completion', 'length'] as const)
  test(`complete original Model ${mode} checkpoint preserves successful result and only adopts pending attempt`, async () => {
    const f = await fixture(mode);
    try {
      const originalTool = await f.store.getExecution('tool');
      const state = await f.store.verifyRunResume(f.input);
      expect(state.checkpoint!.boundary).toBe(mode === 'tool' ? 'tool_calls' : 'completion');
      const begun = await f.store.beginRunResume({
          ...f.input,
          checkpoint: state.checkpoint!,
          instanceId: 'new',
        }),
        committed = await f.store.commitRunResume({
          expectedStoreId: f.input.expectedStoreId,
          lease: begun.lease!,
          expectedConfiguration: f.configuration,
          checkpoint: state.checkpoint!,
        });
      expect(await f.store.getExecution('model')).toEqual(f.original);
      if (mode === 'tool')
        expect(await f.store.getExecution('tool')).toEqual({
          ...originalTool!,
          ownerGeneration: committed.owner.generation,
        });
      expect((await f.store.getView('s')).executions).toHaveLength(mode === 'tool' ? 2 : 1);
      expect(committed.run.id).toBe(f.run.id);
    } finally {
      await f.close();
    }
  });

test('a length result with tool calls cannot qualify a resume checkpoint', async () => {
  const f = await fixture('tool');
  try {
    // Explicit corruption injection: production Execution never publishes length with calls.
    f.db.run(
      "UPDATE execution SET result_json=json_set(result_json,'$.finishReason','length') WHERE id='model'",
    );
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await denied(f.store.verifyRunResume(f.input), 'run_resume_checkpoint_unavailable');
    expect(await f.store.getCommand('resume')).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('ordinary follow-up Run captures its selection and resumes the same Run and Command', async () => {
  const f = await fixture('follow_up');
  try {
    const state = await f.store.verifyRunResume(f.input);
    expect(state.originalCommand.kind).toBe('input.follow_up');
    expect(state.checkpoint!.contextSelectionId).toBe(state.session.contextSelectionId);
    const begun = await f.store.beginRunResume({
        ...f.input,
        checkpoint: state.checkpoint!,
        instanceId: 'new',
      }),
      committed = await f.store.commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: state.checkpoint!,
      });
    expect(committed.run.id).toBe(f.run.id);
    expect(committed.originalCommand.id).toBe('work');
  } finally {
    await f.close();
  }
});

test('wrong root and original Run cancellation reject before preparing an intent', async () => {
  const f = await fixture();
  try {
    await f.store.createSession({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 'other',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'other-create',
      title: 'other',
    });
    await denied(f.store.verifyRunResume({ ...f.input, sessionId: 'other' }), 'run_not_found');
    await f.store.cancelWork({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-original',
      kind: 'run.cancel',
      runId: f.run.id,
    });
    await denied(f.store.verifyRunResume(f.input), 'cancelled_before_dispatch');
    expect(await f.store.getCommand('resume')).toBeNull();
  } finally {
    await f.close();
  }
});

test('final event fault rolls back all planned adoption and applied receipt atomically', async () => {
  const f = await fixture();
  try {
    // Install before preflight so the fault tests the final SQL commit itself,
    // rather than invalidating the certified schema protocol between its phases.
    f.db.run(
      "CREATE TRIGGER fail_resume_final BEFORE INSERT ON change_event WHEN NEW.type='run.resumed' BEGIN SELECT RAISE(ABORT,'fixture final fault'); END",
    );
    const state = await f.store.verifyRunResume(f.input),
      begun = await f.store.beginRunResume({
        ...f.input,
        checkpoint: state.checkpoint!,
        instanceId: 'new',
      });
    const error = await f.store
      .commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: state.checkpoint!,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('fixture final fault');
    expect(await f.store.getExecution('model')).toEqual(f.original);
    expect((await f.store.getCommand('resume'))!.status).toBe('accepted');
    expect((await f.store.getCommand('resume'))!.receipt).toBeNull();
    f.db.run('DROP TRIGGER fail_resume_final');
    await f.store.releaseRunResumeLease(begun.lease!);
  } finally {
    await f.close();
  }
});

test('delete during preparation preserves finite independent accepted receipt and rejects final adoption', async () => {
  const f = await fixture();
  try {
    const state = await f.store.verifyRunResume(f.input),
      begun = await f.store.beginRunResume({
        ...f.input,
        checkpoint: state.checkpoint!,
        instanceId: 'new',
      });
    await f.store.deleteSession({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'delete',
      ifRevision: state.session.controlRevision,
    });
    expect((await f.store.getCommand('resume'))!.status).toBe('accepted');
    expect((await f.store.getCommand('resume'))!.receipt).toBeNull();
    await denied(
      f.store.commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: state.checkpoint!,
      }),
      'run_resume_cancelled',
    );
    await f.store.releaseRunResumeLease(begun.lease!);
  } finally {
    await f.close();
  }
});

for (const phase of ['preflight', 'lease'] as const)
  test(`raw SQL drift without change events invalidates the ${phase} validation snapshot`, async () => {
    const f = await fixture('tool');
    try {
      const state = await f.store.verifyRunResume(f.input);
      const begun =
        phase === 'lease'
          ? await f.store.beginRunResume({
              ...f.input,
              checkpoint: state.checkpoint!,
              instanceId: 'new',
            })
          : null;
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      f.db.run(
        "UPDATE execution SET result_json=json_set(result_json,'$.content','changed outside the owner') WHERE id='model'",
      );
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      if (begun) {
        await denied(
          f.store.commitRunResume({
            expectedStoreId: f.input.expectedStoreId,
            lease: begun.lease!,
            expectedConfiguration: f.configuration,
            checkpoint: state.checkpoint!,
          }),
          'run_resume_checkpoint_changed',
        );
        expect((await f.store.getCommand('resume'))!.status).toBe('accepted');
        await f.store.releaseRunResumeLease(begun.lease!);
      } else {
        await denied(
          f.store.beginRunResume({ ...f.input, checkpoint: state.checkpoint!, instanceId: 'new' }),
          'run_resume_checkpoint_changed',
        );
        expect(await f.store.getCommand('resume')).toBeNull();
      }
    } finally {
      await f.close();
    }
  });

for (const mode of ['planned', 'approval', 'tool', 'completion'] as const)
  test(`owner-loss reconciliation durably interrupts and safely resumes original ${mode} boundary`, async () => {
    const f = await fixture(mode);
    try {
      const reconciled = await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
      expect(reconciled.outcome).toBe('reconciled');
      expect(await f.store.getRun(f.run.id)).toMatchObject({
        status: 'interrupted',
        isActive: false,
        reason: 'owner_lost',
      });
      const observed = await f.store.getView('s');
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      expect(await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' })).toEqual(
        reconciled,
      );
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      const input = { ...f.input, expectedOwnerGeneration: reconciled.report!.generation };
      const state = await f.store.verifyRunResume(input);
      expect(state.run.id).toBe(f.run.id);
      expect(await f.store.getView('s')).toEqual(observed);
      if (f.interaction)
        expect(
          await f.store.getInteraction({
            expectedStoreId: f.input.expectedStoreId,
            sessionId: 's',
            interactionId: f.interaction.id,
          }),
        ).toEqual({ ...f.interaction, state: 'cancelled' });
      expect(
        observed.executions.every(
          (row) => !['planned', 'dispatching', 'running'].includes(row.status),
        ),
      ).toBe(true);
      const begun = await f.store.beginRunResume({
        ...input,
        checkpoint: state.checkpoint!,
        instanceId: 'resumed',
      });
      expect(await f.store.getRun(f.run.id)).toMatchObject({
        status: 'interrupted',
        isActive: false,
      });
      expect((await f.store.verifyRunResume(input)).command?.id).toBe(input.commandId);
      if (mode === 'tool') {
        const page = await f.store.readRunResumeExecutionPage({
          expectedStoreId: input.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          runId: f.run.id,
          modelExecutionId: 'model',
          kind: 'model_tools',
        });
        expect(page.items.map((row) => row.executionId)).toEqual(['tool']);
      }
      const committed = await f.store.commitRunResume({
        expectedStoreId: input.expectedStoreId,
        lease: begun.lease!,
        checkpoint: state.checkpoint!,
        expectedConfiguration: f.configuration,
      });
      expect(committed.run.id).toBe(f.run.id);
      expect(committed.run.isActive).toBe(true);
      if (f.interaction)
        expect(
          await f.store.getInteraction({
            expectedStoreId: input.expectedStoreId,
            sessionId: 's',
            interactionId: f.interaction.id,
          }),
        ).toEqual(f.interaction);

      expect(f.db.query('SELECT count(*) AS n FROM session_reconciliation').get()).toEqual({
        n: 0,
      });
    } finally {
      await f.close();
    }
  });

test('observed interruption never makes generic unknown or explicit abandonment resumable', async () => {
  const unknown = await fixture('tool');
  try {
    unknown.db.run("UPDATE execution SET state='outcome_unknown' WHERE id='tool'");
    const reconciled = await unknown.store.reconcileSession({
      ...unknown.input,
      commandId: 'reconcile',
    });
    await denied(
      unknown.store.verifyRunResume({
        ...unknown.input,
        expectedOwnerGeneration: reconciled.report!.generation,
      }),
      'run_resume_checkpoint_unavailable',
    );
  } finally {
    await unknown.close();
  }
  const abandoned = await fixture('dispatching');
  try {
    const reconciled = await abandoned.store.reconcileSession({
      ...abandoned.input,
      commandId: 'reconcile',
    });
    const report = await abandoned.store.recoverSession({
      ...abandoned.input,
      commandId: 'abandon',
      expectedOwnerGeneration: reconciled.report!.generation,
      decision: 'interrupt',
    });
    await denied(
      abandoned.store.verifyRunResume({
        ...abandoned.input,
        expectedOwnerGeneration: report.generation,
      }),
      'run_not_active',
    );
  } finally {
    await abandoned.close();
  }
});

for (const damage of [
  'invalid_json',
  'missing',
  'future',
  'duplicate',
  'digest',
  'frontier_drift',
] as const)
  test(`reconciliation checkpoint ${damage} is rejected without changing interrupted facts`, async () => {
    const f = await fixture('tool');
    try {
      const result = await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
      const raw = f.db
        .query<{ checkpoint_json: string }, []>(
          'SELECT checkpoint_json FROM session_reconciliation',
        )
        .get()!;
      const checkpoint = JSON.parse(raw.checkpoint_json);
      if (damage === 'missing') delete checkpoint.sessions;
      if (damage === 'future') checkpoint.version = 2;
      if (damage === 'duplicate') checkpoint.runs.push(checkpoint.runs[0]);
      if (damage === 'digest') checkpoint.digest = '0'.repeat(64);
      if (damage === 'frontier_drift')
        f.db.run("UPDATE run SET reason='changed' WHERE id=?", [f.run.id]);
      else
        f.db.run('UPDATE session_reconciliation SET checkpoint_json=?', [
          damage === 'invalid_json' ? 'broken' : JSON.stringify(checkpoint),
        ]);
      const before = await f.store.getView('s');
      const error = await f.store
        .verifyRunResume({ ...f.input, expectedOwnerGeneration: result.report!.generation })
        .catch((error) => error);
      expect(error.code).toBe(
        damage === 'frontier_drift'
          ? 'run_resume_checkpoint_changed'
          : 'run_resume_checkpoint_unavailable',
      );
      expect(await f.store.getView('s')).toEqual(before);
    } finally {
      await f.close();
    }
  });

test('session reconciliation checks actual same-process and peer locks, stale generations, cold readers and missing lock', async () => {
  const f = await fixture('planned', true);
  const peer = await openSqliteStore(f.profile);
  try {
    const input = { ...f.input, commandId: 'reconcile-lock' };
    const before = await peer.getView('s');
    expect((await f.store.reconcileSession(input)).outcome).toBe('owner_held');
    expect((await peer.reconcileSession(input)).outcome).toBe('owner_held');
    await denied(
      peer.reconcileSession({ ...input, expectedOwnerGeneration: '0' }),
      'owner_changed',
    );
    expect(await peer.getView('s')).toEqual(before);
    await f.store.close();
    const first = await peer.reconcileSession(input);
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(await cold.getRun(f.run.id)).toMatchObject({ status: 'interrupted', isActive: false });
      expect((await cold.getView('s')).messages).toEqual(before.messages);
    } finally {
      await cold.close();
    }
    expect(await peer.reconcileSession(input)).toEqual(first);
    const after = await peer.getView('s');
    await denied(peer.reconcileSession({ ...input, commandId: 'stale' }), 'owner_changed');
    expect(await peer.getView('s')).toEqual(after);
    rmSync(join(selectProfile(f.profile).coordinationPath, 'session-s.lock'));
    const noWork = await peer
      .reconcileSession({
        ...input,
        commandId: 'missing',
        expectedOwnerGeneration: first.report!.generation,
      })
      .catch((error) => error);
    expect(noWork.outcome).toBe('unchanged');
    expect(await peer.getView('s')).toEqual(after);
    expect(await peer.getCommand('missing')).toBeNull();
  } finally {
    await peer.close();
    await f.close();
  }
});

test('missing original owner lock never proves an active execution has stopped', async () => {
  const f = await fixture('planned');
  try {
    const before = await f.store.getView('s');
    rmSync(join(selectProfile(f.profile).coordinationPath, 'session-s.lock'));
    const error = await f.store
      .reconcileSession({ ...f.input, commandId: 'missing' })
      .catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(await f.store.getView('s')).toEqual(before);
    expect(await f.store.getCommand('missing')).toBeNull();
  } finally {
    await f.close();
  }
});

test('owner-loss settles original unanswered presentation but retains accepted decisions and independent new work', async () => {
  const f = await fixture('approval');
  try {
    await f.store.acceptCommand({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'new-independent',
      request: { kind: 'run.start', content: 'A separately accepted new task' },
    });
    f.db.run("UPDATE interaction SET state='answered',answer_json=? WHERE id=?", [
      '{"kind":"approval","decision":"approve"}',
      f.interaction!.id,
    ]);
    const original = f.db
      .query('SELECT * FROM interaction WHERE id=?')
      .get(f.interaction!.id) as Record<string, unknown>;
    const result = await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
    expect(result.report!.cancelledExecutionIds).toContain('model');
    expect(await f.store.getCommand('new-independent')).toMatchObject({
      status: 'accepted',
      cancelRequestedAt: null,
    });
    const current = f.db.query('SELECT * FROM interaction WHERE id=?').get(f.interaction!.id);
    expect(current).toEqual({ ...original, state: 'cancelled' });
  } finally {
    await f.close();
  }
  const accepted = await fixture('approval');
  try {
    accepted.db.run(
      "UPDATE interaction SET state='answered',accepted_decision_revision=revision,answer_json=? WHERE id=?",
      ['{"kind":"approval","decision":"approve"}', accepted.interaction!.id],
    );
    const original = accepted.db
      .query('SELECT * FROM interaction WHERE id=?')
      .get(accepted.interaction!.id);
    await accepted.store.reconcileSession({ ...accepted.input, commandId: 'reconcile' });
    expect(
      accepted.db.query('SELECT * FROM interaction WHERE id=?').get(accepted.interaction!.id),
    ).toEqual(original);
  } finally {
    await accepted.close();
  }
});

test('new ordinary work refuses true unknown before accepting its command or calling a Model', async () => {
  const f = await fixture('tool');
  let calls = 0;
  const runtime = createRuntime({
    store: f.store,
    modelId: 'new',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    model: {
      async *stream() {
        calls++;
        yield { type: 'text_delta', text: 'new' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    f.db.run("UPDATE execution SET state='outcome_unknown' WHERE id='tool'");
    await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
    const before = await f.store.getView('s');
    const checkpoint = f.db.query('SELECT * FROM session_reconciliation').get();
    await denied(
      runtime.submitCommand({
        expectedStoreId: f.input.expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'new',
        request: { kind: 'run.start', content: 'New independent task' },
      }),
      'session_recovery_required',
    );
    expect(await f.store.getCommand('new')).toBeNull();
    expect(await f.store.getView('s')).toEqual(before);
    expect(f.db.query('SELECT * FROM session_reconciliation').get()).toEqual(checkpoint);
    expect(calls).toBe(0);
  } finally {
    await runtime.close();
    await f.close();
  }
});

for (const action of ['resume', 'abandon', 'new_task'] as const)
  test(`title-only renames preserve v1 reconciliation evidence for ${action}`, async () => {
    const f = await fixture('tool');
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const reconciled = await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
      const saved = f.db.query('SELECT checkpoint_json FROM session_reconciliation').get();
      expect(
        JSON.parse(String((saved as { checkpoint_json: string }).checkpoint_json)).version,
      ).toBe(1);
      for (const commandId of ['rename-once', 'rename-twice']) {
        const rename = {
          expectedStoreId: f.input.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId,
          ifRevision: (await f.store.getSession('s'))!.controlRevision,
          title: commandId,
        };
        await f.store.renameSession(rename);
        await f.store.renameSession(rename); // Receipt retries do not create another revision.
      }
      expect(f.db.query('SELECT checkpoint_json FROM session_reconciliation').get()).toEqual(saved);
      const input = { ...f.input, expectedOwnerGeneration: reconciled.report!.generation };
      if (action === 'resume') {
        const state = await f.store.verifyRunResume(input);
        const begun = await f.store.beginRunResume({
          ...input,
          checkpoint: state.checkpoint!,
          instanceId: 'resumed',
        });
        await f.store.commitRunResume({
          expectedStoreId: input.expectedStoreId,
          lease: begun.lease!,
          checkpoint: state.checkpoint!,
          expectedConfiguration: f.configuration,
        });
        expect((await f.store.getExecution('tool'))!.status).toBe('planned');
      } else {
        runtime = createRuntime({
          store: f.store,
          modelId: 'new',
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'test' };
            },
          },
          model: {
            async *stream() {
              yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
            },
          },
        });
        if (action === 'abandon')
          await runtime.recoverSession({ ...input, commandId: 'abandon', decision: 'interrupt' });
        else
          await runtime.submitCommand({
            expectedStoreId: input.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            commandId: 'new',
            request: { kind: 'run.start', content: 'A new independent task' },
          });
        expect(
          (await f.store.listMessages('s')).filter((message) => message.toolCallId === 'call'),
        ).toHaveLength(1);
        expect((await f.store.getExecution('tool'))!.status).toBe('cancelled');
      }
      expect((await f.store.getSession('s'))!.title).toBe('rename-twice');
      expect(f.db.query('SELECT count(*) AS n FROM session_reconciliation').get()).toEqual({
        n: 0,
      });
    } finally {
      await runtime?.close();
      await f.close();
    }
  });

for (const change of ['stop', 'selection', 'other_control', 'untrusted_rename'] as const)
  test(`title reconciliation allowance cannot conceal ${change}`, async () => {
    const f = await fixture();
    try {
      const reconciled = await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
      await f.store.renameSession({
        expectedStoreId: f.input.expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'rename',
        title: 'renamed',
        ifRevision: (await f.store.getSession('s'))!.controlRevision,
      });
      if (change === 'stop')
        await f.store.cancelWork({
          expectedStoreId: f.input.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'stop',
          kind: 'run.cancel',
          runId: f.run.id,
        });
      else if (change === 'selection')
        await f.store.selectContext({
          expectedStoreId: f.input.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'rewind',
          boundary: null,
          expectedContextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
        });
      else if (change === 'other_control')
        f.db.run("UPDATE session SET control_revision=control_revision+1 WHERE id='s'");
      else f.db.run("UPDATE command SET subject_id='another' WHERE id='rename'");
      const before = await f.store.getView('s');
      await denied(
        f.store.verifyRunResume({
          ...f.input,
          expectedOwnerGeneration: reconciled.report!.generation,
        }),
        change === 'selection' ? 'run_not_active' : 'run_resume_checkpoint_changed',
      );
      if (change === 'selection')
        expect(f.db.query('SELECT count(*) AS n FROM session_reconciliation').get()).toEqual({
          n: 0,
        });
      expect(await f.store.getView('s')).toEqual(before);
    } finally {
      await f.close();
    }
  });

test('ordinary owner acquisition cannot bypass a reconciled history boundary', async () => {
  const f = await fixture('tool');
  try {
    await f.store.acceptCommand({
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'queued',
      request: { kind: 'run.start', content: 'New independent task' },
    });
    await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
    const before = await f.store.getView('s');
    await denied(f.store.acquireSessionOwner('s', 'ordinary-dispatcher'), 'recovery_required');
    expect(await f.store.getView('s')).toEqual(before);
    expect((await f.store.getCommand('queued'))!.status).toBe('accepted');
    expect(f.db.query('SELECT count(*) AS n FROM session_reconciliation').get()).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
});

test('retrying preaccepted work cannot retire a reconciled unknown outcome', async () => {
  const f = await fixture('tool');
  let calls = 0;
  const runtime = createRuntime({
    store: f.store,
    modelId: 'new',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    model: {
      async *stream() {
        calls++;
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    const input = {
      expectedStoreId: f.input.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'queued',
      request: { kind: 'run.start' as const, content: 'New independent task' },
    };
    await f.store.acceptCommand(input);
    f.db.run("UPDATE execution SET state='outcome_unknown' WHERE id='tool'");
    await f.store.reconcileSession({ ...f.input, commandId: 'reconcile' });
    const before = await f.store.getView('s');
    await denied(runtime.submitCommand(input), 'session_recovery_required');
    expect(await f.store.getView('s')).toEqual(before);
    expect((await f.store.getCommand('queued'))!.status).toBe('accepted');
    expect(calls).toBe(0);
  } finally {
    await runtime.close();
    await f.close();
  }
});
