import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeCommand,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeHost,
  createRuntimeHostBoundary,
  createRuntimeHostFromRegistry,
  projectRuntimeObservabilityFact,
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHostExecutionAdapterContext,
  runtimeHostStateAssertCurrentRuntimeEvent,
} from '@kite-ai/runtime-host';
import {
  runtimeCommandFromKernelInput,
  translateRuntimeCommandToKernelInput,
} from '@kite-ai/runtime-host/kernel-adapter';
import { createArtifactPort, type RuntimeStorageBoundary } from '@kite-ai/runtime-host/storage';
import type { CapabilityExecutionInvocation, CapabilityExecutionPort } from '@kite-ai/runtime-spi';
import {
  createRuntimeModuleRegistry,
  defineRuntimeModule,
  type RuntimeModuleRegistry,
} from '@kite-ai/runtime-spi';
import { runtimeCommandOwner } from '../src/host/command-router';
import {
  deferred,
  projection,
  TestExecutionBridge,
  testRuntimeModules,
  testStorage,
} from './helpers';

const module = defineRuntimeModule({ moduleId: 'test-module', revision: '1' });

describe('runtime host package boundary', () => {
  test('exposes narrow Kernel policy and observability ports without App authority', () => {
    expect(() =>
      runtimeHostStateAssertCurrentRuntimeEvent({
        type: 'approval.granted',
        approval: { tool: 'shell_execute', command: 'echo hello' },
        grant: 'full_access',
      }),
    ).toThrow();
    expect(
      projectRuntimeObservabilityFact(
        { type: 'turn.completed', turnId: 'turn-1' },
        '2026-08-21T00:00:00.000Z',
      ),
    ).toEqual({
      schema: 'kite.observability-runtime-fact.v1',
      type: 'turn.completed',
      observedAt: '2026-08-21T00:00:00.000Z',
    });
  });

  test('composes contract, kernel, SPI, and storage boundary facts', () => {
    const storage: RuntimeStorageBoundary = {
      adapterId: 'test',
      stateSchemaVersion: 27,
      storeSchemaVersion: 4,
      formatEpoch: 'kite-runtime-saq-v1-2026-08-25',
    };
    expect(createRuntimeHostBoundary({ storage, modules: [module] })).toEqual({
      contractRevision: 'runtime-contract-current',
      deterministicKernel: true,
      storage,
      moduleIds: ['test-module'],
    });
  });

  test('retains injected storage and closes it exactly once', async () => {
    let closes = 0;
    const storage = testStorage(() => {
      closes += 1;
    });
    const host = createRuntimeHost({
      storage,
      modules: testRuntimeModules(() => new TestExecutionBridge()),
    });
    expect(host.storage).toBe(storage);
    expect(host.moduleIds).toEqual(['test-module']);
    await host[Symbol.asyncDispose]();
    await host[Symbol.asyncDispose]();
    expect(closes).toBe(1);
    await expect(
      host.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
    ).rejects.toThrow('disposed');
  });

  test('accepts one prebuilt registry and exact snapshot without taking another snapshot', async () => {
    let adapterSnapshot: unknown;
    let snapshotCalls = 0;
    const bridge = new TestExecutionBridge();
    const modules = [
      defineRuntimeModule({
        moduleId: 'prebuilt-module',
        revision: '1',
        register: (registry) => {
          registry.registerContextSource({
            sourceId: 'prebuilt-context',
            providerId: 'prebuilt-module',
            revision: '1',
            collect: () => [
              {
                fragmentId: 'prebuilt-fragment',
                kind: 'runtime',
                authority: 'runtime',
                content: 'fact',
                tokenEstimate: 1,
                disclosure: 'always',
              },
            ],
          });
          registry.registerExecutionAdapter({
            adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
            revision: '1',
            create: (context: RuntimeHostExecutionAdapterContext) => {
              adapterSnapshot = context.capabilityRegistrySnapshot;
              return bridge;
            },
          });
        },
      }),
    ];
    const registry = createRuntimeModuleRegistry(modules);
    const snapshot = registry.snapshot();
    const prebuiltRegistry = new Proxy(registry, {
      get(target, property, _receiver) {
        if (property === 'snapshot') {
          return () => {
            snapshotCalls += 1;
            return target.snapshot();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeModuleRegistry;
    const host = createRuntimeHostFromRegistry({
      storage: testStorage(),
      moduleRegistry: prebuiltRegistry,
      capabilityRegistrySnapshot: snapshot,
      contextCompiler: {
        compilerId: 'prebuilt-compiler',
        revision: '1',
        compile: async () => ({ selectedFragmentIds: ['prebuilt-fragment'], payload: 'compiled' }),
      },
    });

    expect(host.capabilityRegistrySnapshot).toBe(snapshot);
    expect(adapterSnapshot).toBe(snapshot);
    expect(snapshotCalls).toBe(0);
    await expect(
      host.contextCompilation.compile({
        sessionId: 'session-1',
        projectId: 'project_fixture',
        purpose: 'test',
        tokenBudget: 1,
        committedFacts: {},
      }),
    ).resolves.toEqual({ selectedFragmentIds: ['prebuilt-fragment'], payload: 'compiled' });
    await host[Symbol.asyncDispose]();
  });

  test('rejects a mismatched registry and snapshot before Host composition', () => {
    const createModule = (moduleId: string) =>
      defineRuntimeModule({
        moduleId,
        revision: '1',
        register: (registry) => {
          registry.registerExecutionAdapter({
            adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
            revision: '1',
            create: () => new TestExecutionBridge(),
          });
        },
      });
    const first = createRuntimeModuleRegistry([createModule('first-module')]);
    const second = createRuntimeModuleRegistry([createModule('second-module')]);
    expect(() =>
      createRuntimeHostFromRegistry({
        storage: testStorage(),
        moduleRegistry: first,
        capabilityRegistrySnapshot: second.snapshot(),
      }),
    ).toThrow('does not match');
    void first.dispose();
    void second.dispose();
  });

  test('rejects mutable nested snapshot entries before adapter or capability port creation', () => {
    let adapterCreateCalls = 0;
    let capabilityPortCalls = 0;
    const module = defineRuntimeModule({
      moduleId: 'nested-freeze-module',
      providerId: 'nested-freeze-provider',
      revision: '1',
      operationIds: ['builtin:nested-freeze'],
      register: (registry) => {
        registry.registerCapability({
          capabilityId: 'builtin:nested-freeze',
          revision: '1',
          providerId: 'nested-freeze-provider',
          title: 'Nested freeze fixture',
          visibility: 'model',
          toolName: 'nested_freeze',
          inputSchema: { type: 'object', properties: {} },
          inputSchemaDigest: 'schema-1',
        });
        registry.registerExecutor({
          providerId: 'nested-freeze-provider',
          capabilityId: 'builtin:nested-freeze',
          capabilityRevision: '1',
          executorRevision: '1',
          execute: async (request, context) => {
            capabilityPortCalls += 1;
            return {
              invocationId: request.invocationId,
              attemptId: context.attempt.attemptId,
              providerId: 'nested-freeze-provider',
              executorRevision: '1',
              requestDigest: context.requestDigest,
              status: 'succeeded',
              dispatchCertainty: 'attempted',
              cleanupCertainty: 'not_required',
              value: null,
            };
          },
        });
        registry.registerExecutionAdapter({
          adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
          revision: '1',
          create: () => {
            adapterCreateCalls += 1;
            return new TestExecutionBridge();
          },
        });
      },
    });
    const registry = createRuntimeModuleRegistry([module]);
    const snapshot = registry.snapshot();
    const entry = snapshot.capabilities[0];
    if (!entry) throw new Error('nested freeze fixture capability was not registered');
    const forgedSnapshot = Object.freeze({
      modules: snapshot.modules,
      capabilities: Object.freeze([{ ...entry }]),
      contextSources: snapshot.contextSources,
    });

    expect(() =>
      createRuntimeHostFromRegistry({
        storage: testStorage(),
        moduleRegistry: registry,
        capabilityRegistrySnapshot: forgedSnapshot,
      }),
    ).toThrow('frozen capability snapshot entries');
    expect(adapterCreateCalls).toBe(0);
    expect(capabilityPortCalls).toBe(0);
    void registry.dispose();
  });

  test('rejects mixed module and prebuilt composition inputs', () => {
    const registry = createRuntimeModuleRegistry(
      testRuntimeModules(() => new TestExecutionBridge()),
    );
    expect(() =>
      createRuntimeHost({
        storage: testStorage(),
        modules: [],
        moduleRegistry: registry,
        capabilityRegistrySnapshot: registry.snapshot(),
      } as never),
    ).toThrow('cannot be combined');
    void registry.dispose();
  });

  test('exposes the frozen registry snapshot used by execution and seals registration before start', async () => {
    let executorCalls = 0;
    let capabilityPort: CapabilityExecutionPort | undefined;
    let adapterSnapshot:
      | RuntimeHostExecutionAdapterContext['capabilityRegistrySnapshot']
      | undefined;
    let registerAfterSeal: (() => void) | undefined;
    const capabilityModule = defineRuntimeModule({
      moduleId: 'capability-module',
      providerId: 'capability-provider',
      revision: '1',
      operationIds: ['builtin:fixture'],
      register: (registry) => {
        registerAfterSeal = () =>
          registry.registerCapability({
            capabilityId: 'builtin:late',
            revision: '1',
            providerId: 'capability-provider',
            title: 'Late capability',
          });
        registry.registerCapability({
          capabilityId: 'builtin:fixture',
          revision: 'capability-1',
          providerId: 'capability-provider',
          title: 'Fixture capability',
          toolName: 'fixture',
          visibility: 'model',
          inputSchema: { type: 'object', properties: {} },
          inputSchemaDigest: 'schema-1',
        });
        registry.registerExecutor({
          providerId: 'capability-provider',
          capabilityId: 'builtin:fixture',
          capabilityRevision: 'capability-1',
          executorRevision: 'executor-1',
          execute: async (request, context) => {
            executorCalls += 1;
            return {
              invocationId: request.invocationId,
              attemptId: context.attempt.attemptId,
              providerId: 'capability-provider',
              executorRevision: 'executor-1',
              requestDigest: context.requestDigest,
              status: 'succeeded',
              dispatchCertainty: 'attempted',
              cleanupCertainty: 'not_required',
              value: null,
            };
          },
        });
        registry.registerExecutionAdapter({
          adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
          revision: '1',
          create: (context: RuntimeHostExecutionAdapterContext) => {
            capabilityPort = context.capabilities;
            adapterSnapshot = context.capabilityRegistrySnapshot;
            return new TestExecutionBridge();
          },
        });
      },
      start: async () => {
        expect(registerAfterSeal).toBeDefined();
        expect(registerAfterSeal).toThrow('runtime module registry writer is frozen');
      },
    });
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: [capabilityModule],
    });

    const snapshot = host.capabilityRegistrySnapshot;
    expect(adapterSnapshot).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modules)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(snapshot.capabilities).toHaveLength(1);
    expect(snapshot.capabilities[0]?.definition).toMatchObject({
      capabilityId: 'builtin:fixture',
      revision: 'capability-1',
      providerId: 'capability-provider',
      toolName: 'fixture',
      visibility: 'model',
    });
    expect(snapshot.capabilities[0]?.executor?.executorRevision).toBe('executor-1');

    await host.start();
    const invocation: CapabilityExecutionInvocation = {
      binding: {
        bindingId: 'binding-1',
        capabilityId: 'builtin:fixture',
        capabilityRevision: 'capability-1',
        exposedToolName: 'fixture',
        schemaDigest: 'schema-1',
        issuedForTurnId: 'turn-1',
      },
      request: {
        invocationId: 'invocation-1',
        capabilityId: 'builtin:fixture',
        capabilityRevision: 'capability-1',
        input: {},
      },
      grant: {
        grantId: 'grant-1',
        capabilityId: 'builtin:fixture',
        capabilityRevision: 'capability-1',
        authority: {},
      },
      requestDigest: 'request-digest-1',
      environment: { environmentId: 'test', kind: 'in_process' },
      attempt: { invocationId: 'invocation-1', attemptId: 'attempt-1' },
      signal: new AbortController().signal,
    };
    expect(capabilityPort).toBeDefined();
    await expect(capabilityPort!.invoke(invocation)).resolves.toMatchObject({
      status: 'succeeded',
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
    });
    expect(executorCalls).toBe(1);
    await host[Symbol.asyncDispose]();
  });

  test('requires the registry-selected adapter and owns module lifecycle ordering', async () => {
    expect(() => createRuntimeHost({ storage: testStorage(), modules: [module] })).toThrow(
      'runtime execution adapter is not registered',
    );

    const order: string[] = [];
    const bridge = new TestExecutionBridge();
    bridge.closeImplementation = async () => {
      order.push('bridge:close');
    };
    const host = createRuntimeHost({
      storage: testStorage(() => order.push('storage:close')),
      modules: testRuntimeModules(() => bridge, {
        start: async () => {
          order.push('module:start');
        },
        dispose: async () => {
          order.push('module:dispose');
        },
      }),
    });

    await host.start();
    await host.start();
    expect(order).toEqual(['module:start']);
    await host[Symbol.asyncDispose]();
    expect(order).toEqual(['module:start', 'bridge:close', 'module:dispose', 'storage:close']);
  });

  test('classifies the accepted Host-owned and Kernel-owned command split', () => {
    const command = (type: RuntimeCommand['type']): RuntimeCommand => ({ type }) as RuntimeCommand;
    for (const type of [
      'create_session',
      'resume_session',
      'fork_session',
      'rewind_session',
      'close_session',
      'delete_session',
    ] as const) {
      expect(runtimeCommandOwner(command(type))).toBe('host');
    }
    for (const type of [
      'start_turn',
      'cancel_turn',
      'respond_interaction',
      'set_interaction_mode',
      'compact_session',
    ] as const) {
      expect(runtimeCommandOwner(command(type))).toBe('kernel');
    }
  });

  test('translates Contract commands to a private KernelInput without identity widening', () => {
    const command = startCommand('command-1', 'session-1', 7);
    const input = translateRuntimeCommandToKernelInput(command);
    expect(input).toMatchObject({
      source: 'command',
      sessionId: 'session-1',
      expectedRevision: 7,
      causationId: 'command-1',
      events: [{ type: 'runtime.command_observed', owner: 'kernel', command }],
    });
    expect(runtimeCommandFromKernelInput(input)).toBe(command);
    expect(() => runtimeCommandFromKernelInput({ ...input, sessionId: 'session-2' })).toThrow(
      'invalid',
    );
  });
});

describe('runtime host command and projection authority', () => {
  test('atomically deletes the durable Session, retains its receipt, and never recovers it on replay', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 3));
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    await host.start();
    const deleted = await host.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'delete-1',
      type: 'delete_session',
      sessionId: 'session-1',
      expectedRevision: 3,
    });
    expect(deleted).toEqual({
      status: 'applied',
      commandId: 'delete-1',
      sessionId: 'session-1',
      revision: 3,
    });
    expect(
      (
        await host.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: 'session-1',
        })
      ).status,
    ).toBe('not_found');
    expect(bridge.calls).toEqual([]);

    await expect(
      host.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'delete-1',
        type: 'delete_session',
        sessionId: 'session-1',
        expectedRevision: 3,
      }),
    ).resolves.toEqual({
      status: 'idempotent_replay',
      commandId: 'delete-1',
      sessionId: 'session-1',
      originalRevision: 3,
    });
    expect(bridge.recoveries).toEqual([]);
    await host[Symbol.asyncDispose]();
  });

  test('emits an App-only session projection tombstone without touching Store or work', async () => {
    let storageCloses = 0;
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 3));
    const host = createRuntimeHost({
      storage: testStorage(() => {
        storageCloses += 1;
      }),
      modules: testRuntimeModules(() => bridge),
    });
    await host.start();
    const iterator = host.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_begin' });
    expect((await iterator.next()).value).toMatchObject({
      type: 'session_upsert',
      session: { sessionId: 'session-1', revision: 3 },
    });
    expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_end' });

    expect(host.removeSessionProjection('session-1')).toBe(true);
    expect((await iterator.next()).value).toMatchObject({
      type: 'session_remove',
      sessionId: 'session-1',
    });
    expect(host.removeSessionProjection('session-1')).toBe(false);
    expect(host.isSessionOperationActive('session-1')).toBe(false);
    expect(storageCloses).toBe(0);
    await iterator.return?.();
    await host[Symbol.asyncDispose]();
    expect(storageCloses).toBe(1);
  });

  test('serializes same-session commands in FIFO order', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    const firstGate = deferred();
    const order: string[] = [];
    bridge.commandImplementation = async (command) => {
      order.push(`start:${command.commandId}`);
      if (command.commandId === 'first') await firstGate.promise;
      const revision = command.commandId === 'first' ? 1 : 2;
      bridge.projections.set('session-1', projection('session-1', revision));
      order.push(`finish:${command.commandId}`);
      return {
        status: 'applied',
        commandId: command.commandId,
        sessionId: 'session-1',
        revision,
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    const first = host.command(startCommand('first', 'session-1', 0));
    const second = host.command(startCommand('second', 'session-1', 1));
    await until(() => order.length === 1);
    expect(order).toEqual(['start:first']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
    await host[Symbol.asyncDispose]();
  });

  test('allows different sessions to make progress concurrently', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-a', projection('session-a', 0));
    bridge.projections.set('session-b', projection('session-b', 0));
    const gate = deferred();
    const started: string[] = [];
    bridge.commandImplementation = async (command) => {
      if (command.type !== 'start_turn') throw new Error('unexpected command');
      started.push(command.sessionId);
      await gate.promise;
      bridge.projections.set(command.sessionId, projection(command.sessionId, 1));
      return {
        status: 'applied',
        commandId: command.commandId,
        sessionId: command.sessionId,
        revision: 1,
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    const left = host.command(startCommand('same-command-id', 'session-a', 0));
    const right = host.command(startCommand('same-command-id', 'session-b', 0));
    await until(() => started.length === 2);
    expect(new Set(started)).toEqual(new Set(['session-a', 'session-b']));
    gate.resolve();
    await Promise.all([left, right]);
    expect(bridge.calls).toHaveLength(2);
    await host[Symbol.asyncDispose]();
  });

  test('returns revision conflict before invoking the execution bridge', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 4));
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    expect(await host.command(startCommand('stale', 'session-1', 3))).toEqual({
      status: 'conflict',
      commandId: 'stale',
      code: 'revision_conflict',
      currentRevision: 4,
    });
    expect(bridge.calls).toHaveLength(0);
    await host[Symbol.asyncDispose]();
  });

  test('checks fork source revision before invoking the bridge', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 5));
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    expect(
      await host.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'fork-1',
        type: 'fork_session',
        sourceSessionId: 'session-1',
        sourceRevision: 4,
      }),
    ).toEqual({
      status: 'conflict',
      commandId: 'fork-1',
      code: 'revision_conflict',
      currentRevision: 5,
    });
    expect(bridge.calls).toHaveLength(0);
    await host[Symbol.asyncDispose]();
  });

  test('coalesces identical retries and rejects payload mismatch without re-execution', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    const gate = deferred();
    bridge.commandImplementation = async (command) => {
      await gate.promise;
      bridge.projections.set('session-1', projection('session-1', 1));
      return {
        status: 'applied',
        commandId: command.commandId,
        sessionId: 'session-1',
        revision: 1,
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    const command = startCommand('retry', 'session-1', 0);
    const first = host.command(command);
    const replay = host.command(command);
    const mismatch = host.command({ ...command, input: 'different' });
    expect(await mismatch).toEqual({
      status: 'rejected',
      commandId: 'retry',
      code: 'invalid_command',
    });
    gate.resolve();
    expect(await first).toEqual({
      status: 'applied',
      commandId: 'retry',
      sessionId: 'session-1',
      revision: 1,
    });
    expect(await replay).toEqual({
      status: 'idempotent_replay',
      commandId: 'retry',
      sessionId: 'session-1',
      originalRevision: 1,
    });
    expect(bridge.calls).toHaveLength(1);
    await host[Symbol.asyncDispose]();
  });

  test('queries the last committed projection while a command is incomplete', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 2));
    const gate = deferred();
    bridge.commandImplementation = async (command) => {
      await gate.promise;
      bridge.projections.set('session-1', projection('session-1', 3));
      return {
        status: 'applied',
        commandId: command.commandId,
        sessionId: 'session-1',
        revision: 3,
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    const pending = host.command(startCommand('pending', 'session-1', 2));
    await until(() => bridge.calls.length === 1);
    expect(
      await host.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: 'session-1',
      }),
    ).toMatchObject({ status: 'ok', revision: 2 });
    gate.resolve();
    await pending;
    expect(
      await host.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: 'session-1',
      }),
    ).toMatchObject({ status: 'ok', revision: 3 });
    await host[Symbol.asyncDispose]();
  });

  test('releases the mailbox after dispatch instead of awaiting provider work', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    const providerWork = deferred();
    let providerFinished = false;
    bridge.commandImplementation = async (command) => {
      void providerWork.promise.then(() => {
        providerFinished = true;
      });
      bridge.projections.set('session-1', projection('session-1', 1));
      return {
        status: 'applied',
        commandId: command.commandId,
        sessionId: 'session-1',
        revision: 1,
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    await expect(host.command(startCommand('dispatch', 'session-1', 0))).resolves.toMatchObject({
      status: 'applied',
    });
    expect(providerFinished).toBe(false);
    providerWork.resolve();
    await providerWork.promise;
    await host[Symbol.asyncDispose]();
  });

  test('persists cancellation through the bridge before Host aborts provider work', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    const order: string[] = [];
    bridge.prepareImplementation = async (command) => {
      if (command.type === 'start_turn') {
        bridge.projections.set(command.sessionId, projection(command.sessionId, 1));
        return {
          receipt: applied(command.commandId, command.sessionId, 1),
          execution: {
            sessionId: command.sessionId,
            operationId: command.commandId,
            committedRevision: 1,
            operation: 'turn',
            run: async (signal: AbortSignal) => {
              order.push('provider-started');
              await new Promise<void>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    order.push('host-signal');
                    resolve();
                  },
                  { once: true },
                );
              });
              order.push('cleanup-complete');
            },
          },
        };
      }
      if (command.type === 'cancel_turn') {
        order.push('cancellation-persisted');
        bridge.projections.set(command.sessionId, projection(command.sessionId, 2));
        return { receipt: applied(command.commandId, command.sessionId, 2) };
      }
      throw new Error(`unexpected command: ${command.type}`);
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await host.command(startCommand('turn-1', 'session-1', 0));
    await until(() => order.includes('provider-started'));
    await host.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cancel-1',
      type: 'cancel_turn',
      sessionId: 'session-1',
      expectedRevision: 1,
      turnId: 'turn-1',
    });
    await host.waitForSessionIdle('session-1');

    expect(order).toEqual([
      'provider-started',
      'cancellation-persisted',
      'host-signal',
      'cleanup-complete',
    ]);
    await host[Symbol.asyncDispose]();
  });

  test('fails closed before scheduling when a prepared execution drifts from the applied receipt', async () => {
    const mismatches = [
      {
        execution: {
          sessionId: 'session-2',
          operationId: 'turn-1',
          committedRevision: 1,
          operation: 'turn' as const,
        },
      },
      {
        execution: {
          sessionId: 'session-1',
          operationId: 'turn-2',
          committedRevision: 1,
          operation: 'turn' as const,
        },
      },
      {
        execution: {
          sessionId: 'session-1',
          operationId: 'turn-1',
          committedRevision: 2,
          operation: 'turn' as const,
        },
      },
      {
        execution: {
          sessionId: 'session-1',
          operationId: 'turn-1',
          committedRevision: 1,
          operation: 'compaction' as const,
        },
      },
    ];

    for (const mismatch of mismatches) {
      const bridge = new TestExecutionBridge();
      bridge.projections.set('session-1', projection('session-1', 0));
      let dispatchCalls = 0;
      bridge.prepareImplementation = async (command) => {
        bridge.projections.set('session-1', projection('session-1', 1));
        return {
          receipt: applied(command.commandId, 'session-1', 1),
          execution: {
            ...mismatch.execution,
            run: async () => {
              dispatchCalls += 1;
            },
          },
        };
      };
      const host = createRuntimeHost({
        storage: testStorage(),
        modules: testRuntimeModules(() => bridge),
      });

      await expect(host.command(startCommand('turn-1', 'session-1', 0))).rejects.toThrow(
        'identity',
      );
      expect(dispatchCalls).toBe(0);
      expect(host.isSessionOperationActive('session-1')).toBe(false);
      await host[Symbol.asyncDispose]();
    }
  });

  test('fails closed when the applied receipt identity drifts with its prepared execution', async () => {
    const receipts = [applied('other-command', 'session-1', 1), applied('turn-1', 'session-2', 1)];

    for (const receipt of receipts) {
      const bridge = new TestExecutionBridge();
      bridge.projections.set('session-1', projection('session-1', 0));
      let dispatchCalls = 0;
      bridge.prepareImplementation = async () => ({
        receipt,
        execution: {
          sessionId: receipt.sessionId,
          operationId: 'turn-1',
          committedRevision: receipt.revision,
          operation: 'turn',
          run: async () => {
            dispatchCalls += 1;
          },
        },
      });
      const host = createRuntimeHost({
        storage: testStorage(),
        modules: testRuntimeModules(() => bridge),
      });

      await expect(host.command(startCommand('turn-1', 'session-1', 0))).rejects.toThrow(
        'identity',
      );
      expect(dispatchCalls).toBe(0);
      expect(host.isSessionOperationActive('session-1')).toBe(false);
      await host[Symbol.asyncDispose]();
    }
  });

  test('rejects a prepared execution attached to a non-applied receipt before dispatch', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    let dispatchCalls = 0;
    bridge.prepareImplementation = async (command) => ({
      receipt: {
        status: 'rejected',
        commandId: command.commandId,
        code: 'policy_denied',
      },
      execution: {
        sessionId: 'session-1',
        operationId: command.commandId,
        committedRevision: 1,
        operation: 'turn',
        run: async () => {
          dispatchCalls += 1;
        },
      },
    });
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await expect(host.command(startCommand('turn-1', 'session-1', 0))).rejects.toThrow(
      'applied receipt',
    );
    expect(dispatchCalls).toBe(0);
    expect(host.isSessionOperationActive('session-1')).toBe(false);
    await host[Symbol.asyncDispose]();
  });

  test('dispatches one prepared execution once across idempotent command replay', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    let dispatchCalls = 0;
    bridge.prepareImplementation = async (command) => {
      bridge.projections.set('session-1', projection('session-1', 1));
      return {
        receipt: applied(command.commandId, 'session-1', 1),
        execution: {
          sessionId: 'session-1',
          operationId: command.commandId,
          committedRevision: 1,
          operation: 'turn',
          run: async () => {
            dispatchCalls += 1;
          },
        },
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    const command = startCommand('turn-1', 'session-1', 0);

    await expect(host.command(command)).resolves.toMatchObject({ status: 'applied' });
    await host.waitForSessionIdle('session-1');
    await expect(host.command(command)).resolves.toEqual({
      status: 'idempotent_replay',
      commandId: 'turn-1',
      sessionId: 'session-1',
      originalRevision: 1,
    });
    await host.waitForSessionIdle('session-1');
    expect(dispatchCalls).toBe(1);
    expect(bridge.calls).toHaveLength(1);
    await host[Symbol.asyncDispose]();
  });

  test('authorizes one recovered interaction continuation as the original turn operation', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 1));
    let dispatchCalls = 0;
    bridge.prepareImplementation = async (command) => {
      if (command.type !== 'respond_interaction') {
        throw new Error(`unexpected command: ${command.type}`);
      }
      bridge.projections.set(command.sessionId, projection(command.sessionId, 2));
      return {
        receipt: applied(command.commandId, command.sessionId, 2),
        execution: {
          sessionId: command.sessionId,
          operationId: command.commandId,
          committedRevision: 2,
          operation: 'turn' as const,
          run: async () => {
            dispatchCalls += 1;
          },
        },
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await expect(host.command(respondInteractionCommand())).resolves.toMatchObject({
      status: 'applied',
      revision: 2,
    });
    await host.waitForSessionIdle('session-1');
    expect(dispatchCalls).toBe(1);
    await host[Symbol.asyncDispose]();
  });

  test('keeps the AbortController in Host when execution requests an abort', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    let observedReason: unknown;
    bridge.prepareImplementation = async (command) => {
      if (command.type !== 'start_turn') throw new Error(`unexpected command: ${command.type}`);
      bridge.projections.set(command.sessionId, projection(command.sessionId, 1));
      return {
        receipt: applied(command.commandId, command.sessionId, 1),
        execution: {
          sessionId: command.sessionId,
          operationId: command.commandId,
          committedRevision: 1,
          operation: 'turn',
          run: async (signal: AbortSignal, requestAbort: (reason: string) => void) => {
            requestAbort('deadline reached');
            observedReason = signal.reason;
          },
        },
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await host.command(startCommand('turn-1', 'session-1', 0));
    await host.waitForSessionIdle('session-1');
    expect(observedReason).toBe('deadline reached');
    await host[Symbol.asyncDispose]();
  });

  test('admits at most one successor after cancellation and starts it only after cleanup', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    const cleanup = deferred();
    const order: string[] = [];
    bridge.prepareImplementation = async (command) => {
      if (command.type === 'cancel_turn') {
        bridge.projections.set(command.sessionId, projection(command.sessionId, 2));
        return { receipt: applied(command.commandId, command.sessionId, 2) };
      }
      if (command.type !== 'start_turn') throw new Error(`unexpected command: ${command.type}`);
      const revision = command.commandId === 'turn-1' ? 1 : 3;
      bridge.projections.set(command.sessionId, projection(command.sessionId, revision));
      return {
        receipt: applied(command.commandId, command.sessionId, revision),
        execution: {
          sessionId: command.sessionId,
          operationId: command.commandId,
          committedRevision: revision,
          operation: 'turn',
          run: async (signal: AbortSignal) => {
            if (command.commandId === 'turn-2') {
              order.push('successor-started');
              return;
            }
            order.push('predecessor-started');
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  order.push('predecessor-aborted');
                  resolve();
                },
                { once: true },
              );
            });
            await cleanup.promise;
            order.push('predecessor-cleaned');
          },
        },
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await host.command(startCommand('turn-1', 'session-1', 0));
    await until(() => order.includes('predecessor-started'));
    await host.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cancel-1',
      type: 'cancel_turn',
      sessionId: 'session-1',
      expectedRevision: 1,
      turnId: 'turn-1',
    });
    await host.command(startCommand('turn-2', 'session-1', 2));
    expect(order).toEqual(['predecessor-started', 'predecessor-aborted']);
    expect(await host.command(startCommand('turn-3', 'session-1', 3))).toMatchObject({
      status: 'rejected',
      code: 'runtime_busy',
    });

    cleanup.resolve();
    await host.waitForSessionIdle('session-1');
    expect(order).toEqual([
      'predecessor-started',
      'predecessor-aborted',
      'predecessor-cleaned',
      'successor-started',
    ]);
    expect(bridge.calls.map((command) => command.commandId)).toEqual([
      'turn-1',
      'cancel-1',
      'turn-2',
    ]);
    await host[Symbol.asyncDispose]();
  });

  test('settles a queued operation through its cancellation callback', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    const cleanup = deferred();
    const skipped: string[] = [];
    bridge.prepareImplementation = async (command) => {
      if (command.type === 'cancel_turn') {
        bridge.projections.set(command.sessionId, projection(command.sessionId, 2));
        return { receipt: applied(command.commandId, command.sessionId, 2) };
      }
      if (command.type !== 'start_turn') throw new Error(`unexpected command: ${command.type}`);
      const revision = command.commandId === 'turn-1' ? 1 : 3;
      bridge.projections.set(command.sessionId, projection(command.sessionId, revision));
      return {
        receipt: applied(command.commandId, command.sessionId, revision),
        execution: {
          sessionId: command.sessionId,
          operationId: command.commandId,
          committedRevision: revision,
          operation: 'turn',
          run: async (signal: AbortSignal) => {
            if (command.commandId === 'turn-2') throw new Error('cancelled successor executed');
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            await cleanup.promise;
          },
          cancel: (reason: string) => skipped.push(reason),
        },
      };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await host.command(startCommand('turn-1', 'session-1', 0));
    await until(() => host.isSessionOperationActive('session-1'));
    await host.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cancel-1',
      type: 'cancel_turn',
      sessionId: 'session-1',
      expectedRevision: 1,
      turnId: 'turn-1',
    });
    await host.command(startCommand('turn-2', 'session-1', 2));
    await host.cancelSession('session-1', 'queued successor cancelled');
    cleanup.resolve();
    await host.waitForSessionIdle('session-1');

    expect(skipped).toEqual(['queued successor cancelled']);
    await host[Symbol.asyncDispose]();
  });

  test('closes admission immediately and waits for durable shutdown plus cleanup', async () => {
    const order: string[] = [];
    const cleanup = deferred();
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    bridge.prepareImplementation = async (command) => {
      if (command.type !== 'start_turn') throw new Error(`unexpected command: ${command.type}`);
      bridge.projections.set(command.sessionId, projection(command.sessionId, 1));
      return {
        receipt: applied(command.commandId, command.sessionId, 1),
        execution: {
          sessionId: command.sessionId,
          operationId: command.commandId,
          committedRevision: 1,
          operation: 'turn',
          run: async (signal: AbortSignal) => {
            order.push('provider-started');
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  order.push('host-signal');
                  resolve();
                },
                { once: true },
              ),
            );
            await cleanup.promise;
            order.push('cleanup-complete');
          },
        },
      };
    };
    bridge.shutdownImplementation = async () => {
      order.push('cancellation-persisted');
    };
    bridge.closeImplementation = async () => {
      order.push('bridge-closed');
    };
    const host = createRuntimeHost({
      storage: testStorage(() => order.push('storage-closed')),
      modules: testRuntimeModules(() => bridge),
    });

    await host.command(startCommand('turn-1', 'session-1', 0));
    await until(() => order.includes('provider-started'));
    const firstDispose = host[Symbol.asyncDispose]();
    const secondDispose = host[Symbol.asyncDispose]();
    expect(secondDispose).toBe(firstDispose);
    await expect(
      host.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
    ).rejects.toThrow('disposed');
    await until(() => order.includes('host-signal'));
    expect(order).toEqual(['provider-started', 'cancellation-persisted', 'host-signal']);

    cleanup.resolve();
    await firstDispose;
    expect(order).toEqual([
      'provider-started',
      'cancellation-persisted',
      'host-signal',
      'cleanup-complete',
      'bridge-closed',
      'storage-closed',
    ]);
  });

  test('runs restart recovery once before the first execution dispatch', async () => {
    const order: string[] = [];
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    bridge.recoverImplementation = async () => {
      order.push('recovered');
    };
    bridge.prepareImplementation = async (command) => {
      order.push(`prepared:${command.commandId}`);
      const revision = command.commandId === 'turn-1' ? 1 : 2;
      bridge.projections.set('session-1', projection('session-1', revision));
      return { receipt: applied(command.commandId, 'session-1', revision) };
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await host.command(startCommand('turn-1', 'session-1', 0));
    await host.command(startCommand('turn-2', 'session-1', 1));
    expect(order).toEqual(['recovered', 'prepared:turn-1', 'prepared:turn-2']);
    expect(bridge.recoveries).toEqual(['session-1']);
    await host[Symbol.asyncDispose]();
  });

  test('fails closed before bridge dispatch when restart recovery fails', async () => {
    const bridge = new TestExecutionBridge();
    bridge.projections.set('session-1', projection('session-1', 0));
    bridge.recoverImplementation = async () => {
      throw new Error('recovery evidence unavailable');
    };
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });

    await expect(host.command(startCommand('turn-1', 'session-1', 0))).rejects.toThrow(
      'recovery evidence unavailable',
    );
    expect(bridge.calls).toEqual([]);
    await host[Symbol.asyncDispose]();
  });
});

describe('runtime host storage ports', () => {
  test('keeps typed artifact namespaces exact and rejects cross-namespace lookup', () => {
    const capability = { read: () => 'capability' };
    const model = { read: () => 'model' };
    const artifacts = createArtifactPort([
      { namespace: 'capability-result', access: capability },
      { namespace: 'model-surface', access: model },
    ]);
    expect(artifacts.listNamespaces()).toEqual(['capability-result', 'model-surface']);
    expect(artifacts.getNamespace<typeof capability>('capability-result')).toBe(capability);
    expect(artifacts.getNamespace('subagent-continuation')).toBeNull();
    expect(() =>
      createArtifactPort([
        { namespace: 'same', access: capability },
        { namespace: 'same', access: model },
      ]),
    ).toThrow('duplicated');
  });
});

function startCommand(
  commandId: string,
  sessionId: string,
  expectedRevision: number,
): Extract<RuntimeCommand, { type: 'start_turn' }> {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'start_turn',
    sessionId,
    expectedRevision,
    input: commandId,
  };
}

function respondInteractionCommand(): Extract<RuntimeCommand, { type: 'respond_interaction' }> {
  const interaction = {
    kind: 'approval' as const,
    interactionId: 'approval-1',
    sessionRevision: 1,
    generation: 0,
    command: 'bun test',
    grants: ['approve_once' as const],
  };
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'respond-1',
    type: 'respond_interaction',
    sessionId: 'session-1',
    expectedRevision: 1,
    interaction,
    response: { kind: 'approval', decision: 'approve_once' },
  };
}

function applied(commandId: string, sessionId: string, revision: number) {
  return {
    status: 'applied' as const,
    commandId,
    sessionId,
    revision,
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
}
