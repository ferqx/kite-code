import { describe, expect, test } from 'bun:test';
import type {
  RuntimeCommand,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostExecutionBridge,
} from '@kite-ai/runtime-host';
import {
  type AdmittedWorkspace,
  createRuntimeWorkspaceAdmission,
} from '../../src/runtime-application/admission';
import {
  createRuntimeWorkspaceContextFactory,
  type RuntimeWorkspaceContext,
} from '../../src/runtime-application/context';
import { createRuntimeExecutionBridgeRouter } from '../../src/runtime-application/router';

function workspace(name: string, digestCharacter: string): AdmittedWorkspace {
  return {
    canonicalPath: `/workspace/${name}`,
    projectId: `project-${name}`,
    workspaceDigest: `sha256:${digestCharacter.repeat(64)}`,
  };
}

function command(
  commandId: string,
  workspacePath: string,
): Extract<RuntimeCommand, { type: 'create_session' }> {
  return {
    schema: 'kite.runtime-command.v1',
    type: 'create_session',
    commandId,
    workspace: workspacePath,
  };
}

function bridge(label: string, calls: string[]): RuntimeHostExecutionBridge {
  return {
    recoverSession: async (sessionId, _publish) => {
      calls.push(`${label}:recover:${sessionId}`);
    },
    inspectCommand: async (
      input: RuntimeCommand,
      _context: RuntimeHostCommandInspectionContext,
    ): Promise<RuntimeHostCommandInspection> => {
      calls.push(`${label}:inspect:${input.commandId}`);
      return {
        kind: 'terminal',
        receipt: {
          status: 'rejected',
          commandId: input.commandId,
          code: 'unsupported',
        },
      };
    },
    query: async (query: RuntimeQuery): Promise<RuntimeQueryResult> => {
      calls.push(`${label}:query:${query.type}`);
      return { status: 'ok', queryType: query.type };
    },
    shutdownSession: async (sessionId, _reason, _publish) => {
      calls.push(`${label}:shutdown:${sessionId}`);
    },
    close: async () => {
      calls.push(`${label}:close`);
    },
  };
}

describe('RuntimeWorkspaceContextFactory and bridge router', () => {
  test('keeps two Workspace contexts isolated and routes by Session identity', async () => {
    const calls: string[] = [];
    const admitted = new Map<string, AdmittedWorkspace>();
    const contexts = createRuntimeWorkspaceContextFactory({
      create: async (input) => {
        calls.push(`create:${input.projectId}`);
        const context: RuntimeWorkspaceContext = {
          admission: input,
          bridge: bridge(input.projectId, calls),
          close: async () => {
            calls.push(`close:${input.projectId}`);
          },
        };
        return context;
      },
      resolveWorkspaceForSession: async (sessionId) => admitted.get(sessionId),
    });
    const admission = createRuntimeWorkspaceAdmission({
      admitForCreate: async (requested) => {
        const value = requested.endsWith('b') ? workspace('b', 'b') : workspace('a', 'a');
        return value;
      },
      resolveForSession: async (sessionId) => admitted.get(sessionId),
    });
    const router = createRuntimeExecutionBridgeRouter({ contexts, admission });

    const a = workspace('a', 'a');
    const b = workspace('b', 'b');
    admitted.set('session-a', a);
    admitted.set('session-b', b);
    await router.bindSession('session-a', a);
    await router.bindSession('session-b', b);
    await router.recoverSession('session-a', (_notification: RuntimeNotification) => undefined);
    await router.recoverSession('session-b', (_notification: RuntimeNotification) => undefined);

    expect(calls).toEqual([
      'create:project-a',
      'create:project-b',
      'project-a:recover:session-a',
      'project-b:recover:session-b',
    ]);
    expect(
      (
        await router.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_context_status',
          sessionId: 'session-b',
        })
      ).status,
    ).toBe('ok');
    expect(calls.at(-1)).toBe('project-b:query:get_context_status');

    await router.close();
    expect(calls.slice(-2)).toEqual(['close:project-a', 'close:project-b']);
  });

  test('admits create through the injected Workspace resolver without a global current Workspace', async () => {
    const calls: string[] = [];
    const contexts = createRuntimeWorkspaceContextFactory({
      create: async (input) => ({
        admission: input,
        bridge: bridge(input.projectId, calls),
        close: async () => undefined,
      }),
      resolveWorkspaceForSession: async () => undefined,
    });
    const router = createRuntimeExecutionBridgeRouter({
      contexts,
      admission: createRuntimeWorkspaceAdmission({
        admitForCreate: async () => workspace('created', 'c'),
        resolveForSession: async () => undefined,
      }),
    });
    const result = await router.inspectCommand(command('create-1', '/requested/workspace'), {
      targetSessionId: 'session-created',
    });
    expect(result.kind).toBe('terminal');
    expect(calls).toEqual(['project-created:inspect:create-1']);
  });

  test('rejects create when its target Session is already bound to another Workspace', async () => {
    const existing = workspace('existing', 'e');
    const requested = workspace('requested', 'f');
    const factory = createRuntimeWorkspaceContextFactory({
      create: async (input) => ({
        admission: input,
        bridge: bridge(input.projectId, []),
        close: async () => undefined,
      }),
      resolveWorkspaceForSession: async (sessionId) =>
        sessionId === 'existing-session' ? existing : undefined,
    });
    const router = createRuntimeExecutionBridgeRouter({
      contexts: factory,
      admission: createRuntimeWorkspaceAdmission({
        admitForCreate: async () => requested,
        resolveForSession: async () => undefined,
      }),
    });

    await expect(
      router.inspectCommand(command('create-conflict', requested.canonicalPath), {
        targetSessionId: 'existing-session',
      }),
    ).rejects.toMatchObject({ code: 'workspace_context_unavailable' });
    await router.close();
  });

  test('closes a context that finishes after factory shutdown and rejects the pending create', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closeCalls = 0;
    const admitted = workspace('late', 'd');
    const factory = createRuntimeWorkspaceContextFactory({
      create: async (input) => {
        await gate;
        return {
          admission: input,
          bridge: bridge('late', []),
          close: async () => {
            closeCalls += 1;
          },
        };
      },
      resolveWorkspaceForSession: async () => undefined,
    });
    const pending = factory.create(admitted);
    const closing = factory.close?.();
    release();

    await expect(pending).rejects.toMatchObject({ code: 'workspace_context_closed' });
    await closing;
    expect(closeCalls).toBe(1);
    expect(await factory.resolveForSession('late-session')).toBeUndefined();
  });

  test('linearizes concurrent Session bindings and rejects a conflicting Workspace', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let creates = 0;
    const factory = createRuntimeWorkspaceContextFactory({
      create: async (input) => {
        creates += 1;
        await gate;
        return {
          admission: input,
          bridge: bridge(input.projectId, []),
          close: async () => undefined,
        };
      },
      resolveWorkspaceForSession: async () => undefined,
    });
    const first = factory.bindSession?.('shared-session', workspace('a', 'a'));
    await Promise.resolve();
    const conflicting = factory.bindSession?.('shared-session', workspace('b', 'b'));
    await expect(conflicting).rejects.toMatchObject({
      code: 'workspace_context_identity_mismatch',
    });
    release();
    await first;
    expect(creates).toBe(1);
    expect((await factory.resolveForSession('shared-session'))?.admission.projectId).toBe(
      'project-a',
    );
  });

  test('rejects conflicting canonical facts while the same Workspace digest is creating', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = workspace('same-digest', 'd');
    const conflicting = {
      ...first,
      canonicalPath: '/workspace/different-path',
      projectId: 'project-different',
    };
    const factory = createRuntimeWorkspaceContextFactory({
      create: async (input) => {
        await gate;
        return {
          admission: input,
          bridge: bridge(input.projectId, []),
          close: async () => undefined,
        };
      },
      resolveWorkspaceForSession: async () => undefined,
    });
    const creating = factory.create(first);
    await Promise.resolve();
    await expect(factory.create(conflicting)).rejects.toMatchObject({
      code: 'workspace_context_identity_mismatch',
    });
    release();
    await creating;
    await factory.close?.();
  });

  test('rejects a persisted fork target bound to a different source Workspace', async () => {
    const source = workspace('source', 'a');
    const target = workspace('target', 'b');
    const persisted = new Map([
      ['source-session', source],
      ['target-session', target],
    ]);
    const factory = createRuntimeWorkspaceContextFactory({
      create: async (input) => ({
        admission: input,
        bridge: bridge(input.projectId, []),
        close: async () => undefined,
      }),
      resolveWorkspaceForSession: async (sessionId) => persisted.get(sessionId),
    });
    const router = createRuntimeExecutionBridgeRouter({ contexts: factory });

    await expect(
      router.inspectCommand(
        {
          schema: 'kite.runtime-command.v1',
          type: 'fork_session',
          commandId: 'fork-cross-workspace',
          sourceSessionId: 'source-session',
          sourceRevision: 1,
        },
        { targetSessionId: 'target-session' },
      ),
    ).rejects.toMatchObject({ code: 'workspace_context_unavailable' });
    await router.close();
  });

  test('fails an in-flight bind when the router closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = createRuntimeWorkspaceContextFactory({
      create: async (input) => {
        await gate;
        return {
          admission: input,
          bridge: bridge(input.projectId, []),
          close: async () => undefined,
        };
      },
      resolveWorkspaceForSession: async () => undefined,
    });
    const router = createRuntimeExecutionBridgeRouter({ contexts: factory });
    const pending = router.bindSession('closing-session', workspace('closing', 'c'));
    const closing = router.close();
    release();

    await expect(pending).rejects.toMatchObject({ code: 'runtime_bridge_closed' });
    await closing;
  });
});
