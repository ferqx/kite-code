import { describe, expect, test } from 'bun:test';
import {
  arbitrateCapability,
  CAPABILITY_EXECUTION_MECHANISMS_,
  type CapabilityDefinition,
  createRuntimeModuleRegistry,
  defineRuntimeModule,
  type RuntimeModuleRegistryWriter,
} from '@kite-ai/runtime-spi';

const capability: CapabilityDefinition = {
  capabilityId: 'builtin:test',
  revision: '1',
  providerId: 'provider-a',
  title: 'Test capability',
};

describe('runtime SPI registry ownership', () => {
  test('exports the closed execution-mechanism vocabulary', () => {
    expect(CAPABILITY_EXECUTION_MECHANISMS_).toEqual([
      'catalog',
      'filesystem',
      'git',
      'shell',
      'web',
      'mcp',
      'skill',
      'planning',
      'subagent',
      'user_input',
      'verification',
      'model',
    ]);
    expect(Object.isFrozen(CAPABILITY_EXECUTION_MECHANISMS_)).toBe(true);
  });

  test('freezes exact module, provider, operation, capability, and adapter owners', () => {
    let capturedWriter: RuntimeModuleRegistryWriter | undefined;
    const module = defineRuntimeModule({
      moduleId: 'module-a',
      providerId: 'provider-a',
      revision: '1',
      operationIds: ['builtin:test'],
      register: (registry) => {
        capturedWriter = registry;
        registry.registerCapability(capability);
        registry.registerExecutor({
          providerId: 'provider-a',
          capabilityId: 'builtin:test',
          capabilityRevision: '1',
          executorRevision: '1',
          execute: async (request) => ({
            invocationId: request.invocationId,
            attemptId: 'attempt-1',
            providerId: 'provider-a',
            executorRevision: '1',
            requestDigest: 'digest',
            status: 'succeeded',
            dispatchCertainty: 'attempted',
            cleanupCertainty: 'not_required',
            value: null,
          }),
        });
        registry.registerExecutionAdapter({
          adapterId: 'host-bridge',
          revision: '1',
          create: (value: string) => ({ value }),
        });
      },
    });
    const registry = createRuntimeModuleRegistry([module]);

    expect(registry.moduleIds).toEqual(['module-a']);
    expect(registry.get('module-a')).toBe(module);
    expect(registry.operationOwner('builtin:test')).toBe('module-a');
    expect(registry.capability('builtin:test')).toEqual(capability);
    expect(registry.executor('builtin:test')?.providerId).toBe('provider-a');
    expect(
      registry.requireExecutionAdapter<string, { value: string }>('host-bridge').create('x'),
    ).toEqual({ value: 'x' });
    expect(() =>
      capturedWriter?.registerCapability({ ...capability, capabilityId: 'late' }),
    ).toThrow('frozen');
  });

  test('rejects duplicate module, provider, and operation owners', () => {
    const module = defineRuntimeModule({
      moduleId: 'module-a',
      providerId: 'provider-a',
      revision: '1',
      operationIds: ['builtin:test'],
    });
    expect(() => createRuntimeModuleRegistry([module, module])).toThrow(
      'duplicate runtime module: module-a',
    );
    expect(() =>
      createRuntimeModuleRegistry([
        module,
        defineRuntimeModule({
          moduleId: 'module-b',
          providerId: 'provider-a',
          revision: '1',
        }),
      ]),
    ).toThrow('duplicate runtime provider: provider-a');
    expect(() =>
      createRuntimeModuleRegistry([
        module,
        defineRuntimeModule({
          moduleId: 'module-b',
          revision: '1',
          operationIds: ['builtin:test'],
        }),
      ]),
    ).toThrow('duplicate runtime operation owner: builtin:test');
  });

  test('rejects duplicate registrations and invalid executor bindings', () => {
    const duplicate = (register: (registry: RuntimeModuleRegistryWriter) => void) =>
      defineRuntimeModule({
        moduleId: 'module-a',
        providerId: 'provider-a',
        revision: '1',
        register,
      });
    expect(() =>
      createRuntimeModuleRegistry([
        duplicate((registry) => {
          registry.registerCapability(capability);
          registry.registerCapability(capability);
        }),
      ]),
    ).toThrow('duplicate runtime capability: builtin:test');
    expect(() =>
      createRuntimeModuleRegistry([
        duplicate((registry) => {
          registry.registerExecutor({
            providerId: 'provider-a',
            capabilityId: 'missing',
            capabilityRevision: '1',
            executorRevision: '1',
            execute: async () => {
              throw new Error('unreachable');
            },
          });
        }),
      ]),
    ).toThrow('runtime executor has no capability definition: missing');
    expect(() =>
      createRuntimeModuleRegistry([
        duplicate((registry) => {
          registry.registerExecutionAdapter({
            adapterId: 'bridge',
            revision: '1',
            create: () => 1,
          });
          registry.registerExecutionAdapter({
            adapterId: 'bridge',
            revision: '1',
            create: () => 2,
          });
        }),
      ]),
    ).toThrow('duplicate runtime execution adapter: bridge');
  });

  test('rejects ambiguous visibility metadata and freezes effect facts', () => {
    const moduleWith = (definition: CapabilityDefinition) =>
      defineRuntimeModule({
        moduleId: 'metadata-module',
        providerId: 'provider-a',
        revision: '1',
        operationIds: [definition.capabilityId],
        register: (writer) => writer.registerCapability(definition),
      });
    expect(() =>
      createRuntimeModuleRegistry([moduleWith({ ...capability, visibility: 'model' })]),
    ).toThrow('requires a tool name');
    expect(() =>
      createRuntimeModuleRegistry([
        moduleWith({ ...capability, visibility: 'internal', toolName: 'test' }),
      ]),
    ).toThrow('cannot declare a tool name');
    const registry = createRuntimeModuleRegistry([
      moduleWith({
        ...capability,
        visibility: 'model',
        toolName: 'test',
        description: 'Canonical test tool.',
        effects: { filesystem: 'read', network: 'none', externalState: 'none' },
      }),
    ]);
    expect(Object.isFrozen(registry.capability('builtin:test')?.effects)).toBe(true);
  });

  test('freezes parser, availability, effects, traits, approval, and descriptor contracts', () => {
    const parser = {
      parserRevision: 'parser-1',
      schemaDigest: 'schema-1',
      knownFields: ['query'],
      parse: (value: unknown) => ({ success: true as const, data: value as null }),
      canonicalize: () => null,
      observeUnknownFields: () => ({ schemaRevision: 'parser-1', fields: [], count: 0 }),
    };
    const traits = {
      resourceScopes: [{ kind: 'runtime' as const, key: 'capability' }],
      conflictKeys: [],
      isolation: 'shared' as const,
      interactionBarrier: false,
      concurrencyGroup: 'parallel-read',
      leaseFenceRequired: true,
    };
    const descriptor = {
      capabilityId: 'builtin:test',
      revision: '1',
      kind: 'builtin_tool' as const,
      displayName: 'test',
      description: 'Canonical test tool.',
      descriptionProvenance: 'builtin' as const,
      provider: { type: 'builtin' as const, id: 'provider-a', provenance: 'builtin' as const },
      declaredEffects: {
        filesystem: 'read' as const,
        network: 'none' as const,
        externalState: 'none' as const,
      },
      effectiveEffects: {
        filesystem: 'read' as const,
        network: 'none' as const,
        externalState: 'none' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
      availability: 'available' as const,
      diagnostics: [],
    };
    const registry = createRuntimeModuleRegistry([
      defineRuntimeModule({
        moduleId: 'metadata-module',
        providerId: 'provider-a',
        revision: '1',
        operationIds: ['builtin:test'],
        register: (writer) =>
          writer.registerCapability({
            ...capability,
            visibility: 'model',
            toolName: 'test',
            description: 'Canonical test tool.',
            effects: { filesystem: 'read', network: 'none', externalState: 'none' },
            inputSchema: { type: 'object' },
            inputSchemaDigest: 'schema-1',
            parser,
            availability: () => ({ status: 'available' as const }),
            effectsClassifier: () => ({
              effectClass: 'read_only' as const,
              sideEffect: false,
              classificationReason: 'test',
              risk: 'read' as const,
              effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
            }),
            executionTraitsDeclaration: traits,
            minimumApproval: 'none',
            descriptor,
          }),
      }),
    ]);
    const definition = registry.capability('builtin:test');
    expect(definition?.parser).toBeDefined();
    expect(Object.isFrozen(definition?.parser)).toBe(true);
    expect(Object.isFrozen(definition?.parser?.knownFields)).toBe(true);
    expect(Object.isFrozen(definition?.executionTraitsDeclaration)).toBe(true);
    expect(Object.isFrozen(definition?.descriptor)).toBe(true);
    expect(Object.isFrozen(definition?.descriptor?.provider)).toBe(true);
    expect(Object.isFrozen(definition?.descriptor?.diagnostics)).toBe(true);
    expect(definition?.minimumApproval).toBe('none');
    expect(definition?.availability?.({})).toEqual({ status: 'available' });
    expect(definition?.effectsClassifier?.(null, {})).toMatchObject({
      effectClass: 'read_only',
      sideEffect: false,
    });
    expect(() =>
      createRuntimeModuleRegistry([
        defineRuntimeModule({
          moduleId: 'invalid-descriptor',
          providerId: 'provider-b',
          revision: '1',
          operationIds: ['builtin:other'],
          register: (writer) =>
            writer.registerCapability({
              ...capability,
              capabilityId: 'builtin:other',
              providerId: 'provider-b',
              descriptor: {
                ...descriptor,
                capabilityId: 'builtin:test',
                provider: { ...descriptor.provider, id: 'provider-b' },
              },
            }),
        }),
      ]),
    ).toThrow('descriptor identity mismatch');
  });

  test('arbitrates exact bindings from an immutable snapshot without granting or executing', () => {
    let executions = 0;
    const registry = createRuntimeModuleRegistry([
      defineRuntimeModule({
        moduleId: 'module-a',
        providerId: 'provider-a',
        revision: 'module-1',
        register: (writer) => {
          writer.registerCapability({
            ...capability,
            visibility: 'model',
            toolName: 'test',
            description: 'Canonical test tool.',
            effects: { filesystem: 'read', network: 'none', externalState: 'none' },
            inputSchemaDigest: 'schema-1',
            inputSchema: { type: 'object', properties: {} },
          });
          writer.registerExecutor({
            providerId: 'provider-a',
            capabilityId: capability.capabilityId,
            capabilityRevision: capability.revision,
            executorRevision: 'executor-1',
            execute: async () => {
              executions += 1;
              throw new Error('arbitration must not execute');
            },
          });
        },
      }),
    ]);
    const binding = {
      bindingId: 'binding-1',
      capabilityId: capability.capabilityId,
      capabilityRevision: capability.revision,
      exposedToolName: 'test',
      schemaDigest: 'schema-1',
      issuedForTurnId: 'turn-1',
    } as const;
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities[0]?.definition.inputSchema)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities[0]?.definition.inputSchema?.properties)).toBe(
      true,
    );
    expect(Object.isFrozen(snapshot.capabilities[0]?.definition.effects)).toBe(true);
    expect(arbitrateCapability(snapshot, binding)).toMatchObject({
      status: 'resolved',
      binding,
      definition: { capabilityId: capability.capabilityId },
      executor: { executorRevision: 'executor-1' },
    });
    expect(arbitrateCapability(snapshot, { ...binding, schemaDigest: 'stale' })).toEqual({
      status: 'failed',
      code: 'schema_digest_mismatch',
    });
    expect(arbitrateCapability(snapshot, { ...binding, exposedToolName: 'other' })).toEqual({
      status: 'failed',
      code: 'exposed_tool_name_mismatch',
    });
    expect(executions).toBe(0);
  });
});

describe('runtime SPI module lifecycle', () => {
  test('starts in declaration order and disposes in reverse order exactly once', async () => {
    const calls: string[] = [];
    const module = (id: string) =>
      defineRuntimeModule({
        moduleId: id,
        revision: '1',
        start: async () => {
          calls.push(`start:${id}`);
        },
        dispose: async () => {
          calls.push(`dispose:${id}`);
        },
      });
    const registry = createRuntimeModuleRegistry([module('a'), module('b')]);
    await registry.start();
    await registry.start();
    expect(registry.state).toBe('started');
    await registry.dispose();
    await registry.dispose();
    expect(registry.state).toBe('disposed');
    expect(calls).toEqual(['start:a', 'start:b', 'dispose:b', 'dispose:a']);
  });

  test('fails closed and rolls every module back after partial startup', async () => {
    const calls: string[] = [];
    const first = defineRuntimeModule({
      moduleId: 'first',
      revision: '1',
      start: async () => {
        calls.push('start:first');
      },
      dispose: async () => {
        calls.push('dispose:first');
      },
    });
    const second = defineRuntimeModule({
      moduleId: 'second',
      revision: '1',
      start: async () => {
        calls.push('start:second');
        throw new Error('startup failed');
      },
      dispose: async () => {
        calls.push('dispose:second');
      },
    });
    const registry = createRuntimeModuleRegistry([first, second]);
    await expect(registry.start()).rejects.toThrow('startup failed');
    expect(registry.state).toBe('disposed');
    expect(calls).toEqual(['start:first', 'start:second', 'dispose:second', 'dispose:first']);
  });

  test('bounds module disposal', async () => {
    const registry = createRuntimeModuleRegistry(
      [
        defineRuntimeModule({
          moduleId: 'never-disposes',
          revision: '1',
          dispose: () => new Promise<void>(() => undefined),
        }),
      ],
      { lifecycleTimeoutMs: 5 },
    );
    await expect(registry.dispose()).rejects.toThrow('runtime module disposal failed');
    expect(registry.state).toBe('disposed');
  });
});
