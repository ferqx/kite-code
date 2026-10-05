import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
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
    | 'follow_up' = 'planned',
) {
  const dataRoot = mkdtempSync('/private/tmp/kite-run-resume-store-'),
    profile = { dataRoot, profile: 'test' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${dataRoot}`,
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
  if (mode === 'dispatching' || mode === 'tool' || mode === 'completion')
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
  if (mode === 'tool' || mode === 'completion') {
    await store.finishExecution({
      expectedStoreId,
      owner: originalOwner,
      executionId: 'model',
      status: 'succeeded',
      result: {
        content: 'complete fixed result',
        reasoning: '',
        finishReason: mode === 'tool' ? 'tool_calls' : 'stop',
        toolCalls: mode === 'tool' ? [{ id: 'call', name: 'fixture.tool', arguments: '{}' }] : [],
      },
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
  await store.close();
  store = await openSqliteStore(profile);
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
      rmSync(dataRoot, { recursive: true, force: true });
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

for (const mode of ['tool', 'completion'] as const)
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
    const state = await f.store.verifyRunResume(f.input),
      begun = await f.store.beginRunResume({
        ...f.input,
        checkpoint: state.checkpoint!,
        instanceId: 'new',
      });
    f.db.run(
      "CREATE TRIGGER fail_resume_final BEFORE INSERT ON change_event WHEN NEW.type='run.resumed' BEGIN SELECT RAISE(ABORT,'fixture final fault'); END",
    );
    const error = await f.store
      .commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: state.checkpoint!,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
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
