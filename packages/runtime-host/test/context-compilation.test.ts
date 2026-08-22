import { describe, expect, test } from 'bun:test';
import { createRuntimeHost } from '@kite/runtime-host';
import {
  type ContextCompilerPortV1,
  type ContextFragmentCandidateV1,
  type ContextSourceRequestV1,
  defineRuntimeModuleV1,
  type RuntimeModuleV1,
} from '@kite/runtime-spi';
import { TestExecutionBridge, testRuntimeModules, testStorage } from './helpers';

function contextModule(
  collect: (request: ContextSourceRequestV1) => readonly ContextFragmentCandidateV1[],
): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: 'context-module',
    providerId: 'context-provider',
    revision: '1',
    register: (registry) => {
      registry.registerContextSource({
        sourceId: 'context-source',
        providerId: 'context-provider',
        revision: '1',
        collect,
      });
    },
  });
}

describe('runtime Host Context compilation mechanism', () => {
  test('collects pure sources and delegates selection without interpreting content', async () => {
    let collections = 0;
    let compilations = 0;
    let externalCalls = 0;
    const compiler: ContextCompilerPortV1 = {
      compilerId: 'builtin-test-compiler',
      revision: '1',
      compile: async (request) => {
        compilations += 1;
        expect(request).toEqual({
          purpose: 'model',
          tokenBudget: 8,
          candidates: [
            {
              fragmentId: 'opaque-1',
              kind: 'opaque-builtin-kind',
              authority: 'external',
              content: 'opaque payload',
              tokenEstimate: 3,
              disclosure: 'selected',
            },
          ],
        });
        return { selectedFragmentIds: ['opaque-1'], payload: { opaque: true } };
      },
    };
    const module = contextModule((request) => {
      collections += 1;
      expect(request).toEqual({
        sessionId: 'session-1',
        purpose: 'model',
        committedFacts: { fact: 'committed' },
      });
      return [
        {
          fragmentId: 'opaque-1',
          kind: 'opaque-builtin-kind',
          authority: 'external',
          content: 'opaque payload',
          tokenEstimate: 3,
          disclosure: 'selected',
        },
      ];
    });
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: [...testRuntimeModules(() => new TestExecutionBridge()), module],
      contextCompiler: compiler,
    });
    expect(
      await host.contextCompilation.compile({
        sessionId: 'session-1',
        purpose: 'model',
        tokenBudget: 8,
        committedFacts: { fact: 'committed' },
      }),
    ).toEqual({ selectedFragmentIds: ['opaque-1'], payload: { opaque: true } });
    expect({ collections, compilations, externalCalls }).toEqual({
      collections: 1,
      compilations: 1,
      externalCalls: 0,
    });
    await host[Symbol.asyncDispose]();
    externalCalls += 0;
  });

  test('fails closed before or after the compiler when boundaries are invalid', async () => {
    let compilations = 0;
    const compiler: ContextCompilerPortV1 = {
      compilerId: 'invalid-test-compiler',
      revision: '1',
      compile: async () => {
        compilations += 1;
        return { selectedFragmentIds: ['missing'], payload: null };
      },
    };
    const duplicate = contextModule(() => [
      {
        fragmentId: 'duplicate',
        kind: 'one',
        authority: 'project',
        content: 'one',
        tokenEstimate: 1,
        disclosure: 'always',
      },
      {
        fragmentId: 'duplicate',
        kind: 'two',
        authority: 'user',
        content: 'two',
        tokenEstimate: 1,
        disclosure: 'selected',
      },
    ]);
    const duplicateHost = createRuntimeHost({
      storage: testStorage(),
      modules: [...testRuntimeModules(() => new TestExecutionBridge()), duplicate],
      contextCompiler: compiler,
    });
    await expect(
      duplicateHost.contextCompilation.compile({
        sessionId: 'session-1',
        purpose: 'model',
        tokenBudget: 4,
        committedFacts: {},
      }),
    ).rejects.toThrow('candidate is invalid');
    expect(compilations).toBe(0);
    await duplicateHost[Symbol.asyncDispose]();

    const valid = contextModule(() => [
      {
        fragmentId: 'available',
        kind: 'opaque',
        authority: 'runtime',
        content: 'value',
        tokenEstimate: 1,
        disclosure: 'always',
      },
    ]);
    const invalidCompilerHost = createRuntimeHost({
      storage: testStorage(),
      modules: [...testRuntimeModules(() => new TestExecutionBridge()), valid],
      contextCompiler: compiler,
    });
    await expect(
      invalidCompilerHost.contextCompilation.compile({
        sessionId: 'session-1',
        purpose: 'model',
        tokenBudget: 4,
        committedFacts: {},
      }),
    ).rejects.toThrow('selected an invalid fragment');
    expect(compilations).toBe(1);
    await invalidCompilerHost[Symbol.asyncDispose]();
  });

  test('rejects Context compilation when no Builtin compiler is composed', async () => {
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => new TestExecutionBridge()),
    });
    await expect(
      host.contextCompilation.compile({
        sessionId: 'session-1',
        purpose: 'model',
        tokenBudget: 1,
        committedFacts: {},
      }),
    ).rejects.toThrow('unavailable');
    await host[Symbol.asyncDispose]();
  });
});
