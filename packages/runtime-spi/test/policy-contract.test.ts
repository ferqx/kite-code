import { describe, expect, test } from 'bun:test';
import {
  CAPABILITY_POLICY_COMPILATION_SCHEMA_,
  type CapabilityDefinition,
  type CapabilityPolicyCompilation,
  type CapabilityPolicyContext,
  createRuntimeModuleRegistry,
  defineRuntimeModule,
  type RuntimeJsonValue,
} from '@kite-ai/runtime-spi';

const context: CapabilityPolicyContext = Object.freeze({
  workspace: '/tmp/workspace',
  phase: 'building',
});

const compilation: CapabilityPolicyCompilation = Object.freeze({
  schema: CAPABILITY_POLICY_COMPILATION_SCHEMA_,
  operationId: 'builtin:test',
  capabilityRevision: 'revision-1',
  parserRevision: 'parser-1',
  decision: 'allow',
  allowed: true,
  requiresApproval: false,
  risk: 'read',
  reason: 'test fact',
  userVisibleSummary: 'Run test capability.',
  expectedEffects: Object.freeze(['Reads test data']),
  effectiveEffects: Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
  minimumApproval: 'none',
  fullAccessMayBypassApproval: false,
  sameCommandMayBypassApproval: false,
  recovery: Object.freeze({
    disposition: 'redirect' as const,
    maximumAdditionalCalls: 0,
    safeAutomaticRetry: false,
    capabilityIntent: 'builtin:replacement',
  }),
});

describe('runtime SPI policy compiler contract', () => {
  test('keeps policy facts JSON-safe and binds them to one operation identity', () => {
    const definition: CapabilityDefinition = Object.freeze({
      capabilityId: 'builtin:test',
      revision: 'revision-1',
      providerId: 'provider-a',
      title: 'Test capability',
      policyCompiler: (input: RuntimeJsonValue, receivedContext: CapabilityPolicyContext) => {
        expect(input).toEqual({ value: 'test' });
        expect(receivedContext).toEqual(context);
        return compilation;
      },
    });
    const registry = createRuntimeModuleRegistry([
      defineRuntimeModule({
        moduleId: 'module-policy',
        providerId: 'provider-a',
        revision: '1',
        operationIds: ['builtin:test'],
        register: (writer) => writer.registerCapability(definition),
      }),
    ]);
    const compiler = registry.capability('builtin:test')?.policyCompiler;
    expect(compiler?.({ value: 'test' }, context)).toBe(compilation);
    expect(compilation.recovery?.capabilityIntent).toBe('builtin:replacement');
    expect(Object.isFrozen(compilation.recovery)).toBe(true);
    expect(Object.isFrozen(registry.capability('builtin:test'))).toBe(true);
  });

  test('rejects a non-callable policy compiler at the SPI boundary', () => {
    expect(() =>
      createRuntimeModuleRegistry([
        defineRuntimeModule({
          moduleId: 'module-invalid-policy',
          providerId: 'provider-a',
          revision: '1',
          register: (writer) =>
            writer.registerCapability({
              capabilityId: 'builtin:invalid',
              revision: 'revision-1',
              providerId: 'provider-a',
              title: 'Invalid policy',
              policyCompiler: 'not-a-function' as never,
            }),
        }),
      ]),
    ).toThrow('policy compiler is invalid');
  });
});
