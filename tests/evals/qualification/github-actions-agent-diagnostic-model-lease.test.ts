import { describe, expect, test } from 'bun:test';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { generateText } from 'ai';
import {
  acquireGitHubActionsDiagnosticModelLeaseV1,
  GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1,
  GITHUB_ACTIONS_DIAGNOSTIC_QWEN_MODEL_V1,
  GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1,
} from '../../../scripts/evals/qualification/github-actions-agent-diagnostic-model-lease-v1';

function successfulProviderResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'diagnostic-test',
      object: 'chat.completion',
      created: 0,
      model: GITHUB_ACTIONS_DIAGNOSTIC_QWEN_MODEL_V1,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'safe' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('GitHub Actions diagnostic model lease', () => {
  test('consumes the secret once and acknowledges only captured Provider fetch entry', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      calls.push({ url, redirect: init?.redirect });
      return Promise.resolve(successfulProviderResponse());
    }) as typeof globalThis.fetch;
    try {
      const environment: NodeJS.ProcessEnv = {
        [GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]: 'lease-test-sentinel',
      };
      const lease = acquireGitHubActionsDiagnosticModelLeaseV1(environment);
      expect(lease).toBeDefined();
      expect(environment[GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]).toBeUndefined();

      const binding = lease!.bind('auto_compaction_cancel');
      const entry = binding.waitForNextTransportEntry(0);
      const model = binding.model.model;
      if (typeof model === 'string') throw new Error('test model unexpectedly unresolved');
      await generateText({
        model,
        prompt: 'safe synthetic request',
        maxOutputTokens: 600,
        maxRetries: 0,
      });
      await entry;

      expect(binding.transportProofKind).toBe('provider_fetch');
      expect(binding.transportEntries()).toBe(1);
      expect(calls).toEqual([
        {
          url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
          redirect: 'error',
        },
      ]);
      expect(() => lease!.bind('auto_compaction_cancel')).toThrow(
        'diagnostic_case_binding_unavailable',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('denies a case over its source-owned output cap before any Provider fetch', async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((_: RequestInfo | URL, _init?: RequestInit) => {
      fetches += 1;
      return Promise.resolve(successfulProviderResponse());
    }) as typeof globalThis.fetch;
    try {
      const lease = acquireGitHubActionsDiagnosticModelLeaseV1({
        [GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]: 'lease-test-sentinel',
      });
      const binding = lease!.bind('auto_compaction_success');
      const model = binding.model.model;
      if (typeof model === 'string') throw new Error('test model unexpectedly unresolved');
      await expect(
        generateText({
          model,
          prompt: 'safe synthetic request',
          maxOutputTokens:
            GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_success.maxOutputTokens + 1,
          maxRetries: 0,
        }),
      ).rejects.toThrow('diagnostic_provider_request_denied');
      expect(fetches).toBe(0);
      expect(binding.transportEntries()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('enforces the fixed 2 + 2 + 1 case inventory before a sixth fetch can occur', async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((_: RequestInfo | URL, _init?: RequestInit) => {
      fetches += 1;
      return Promise.resolve(successfulProviderResponse());
    }) as typeof globalThis.fetch;
    try {
      const lease = acquireGitHubActionsDiagnosticModelLeaseV1({
        [GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]: 'lease-test-sentinel',
      });
      if (!lease) throw new Error('test lease unavailable');
      const agentRead = lease.bind('agent_read');
      const autoSuccess = lease.bind('auto_compaction_success');
      const autoCancel = lease.bind('auto_compaction_cancel');
      const invoke = async (binding: typeof agentRead, maxOutputTokens: number) => {
        const model = binding.model.model;
        if (typeof model === 'string') throw new Error('test model unexpectedly unresolved');
        await generateText({
          model,
          prompt: 'safe synthetic request',
          maxOutputTokens,
          maxRetries: 0,
        });
      };

      await invoke(
        agentRead,
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxOutputTokens,
      );
      await invoke(
        agentRead,
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxOutputTokens,
      );
      await invoke(
        autoSuccess,
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_success.maxOutputTokens,
      );
      await invoke(
        autoSuccess,
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_success.maxOutputTokens,
      );
      await invoke(
        autoCancel,
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_cancel.maxOutputTokens,
      );
      expect(fetches).toBe(5);
      await expect(
        invoke(agentRead, GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxOutputTokens),
      ).rejects.toThrow('diagnostic_case_provider_attempt_quota_exceeded');
      expect(fetches).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('denies an abort-ignoring adapter before it can make a late platform fetch', async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((_: RequestInfo | URL, _init?: RequestInit) => {
      fetches += 1;
      return Promise.resolve(successfulProviderResponse());
    }) as typeof globalThis.fetch;
    try {
      const lease = acquireGitHubActionsDiagnosticModelLeaseV1({
        [GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]: 'lease-test-sentinel',
      });
      if (!lease) throw new Error('test lease unavailable');
      const binding = lease.bind('agent_read');
      const baseModel = binding.model.model;
      if (typeof baseModel === 'string') throw new Error('test model unexpectedly unresolved');
      const baseModelV4 = baseModel as LanguageModelV4;
      let markEntered: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const delayedAdapter: LanguageModelV4 = {
        specificationVersion: baseModelV4.specificationVersion,
        provider: baseModelV4.provider,
        modelId: baseModelV4.modelId,
        supportedUrls: baseModelV4.supportedUrls,
        async doGenerate(
          options: LanguageModelV4CallOptions,
        ): Promise<LanguageModelV4GenerateResult> {
          markEntered?.();
          await new Promise((resolve) => setTimeout(resolve, 1));
          return await baseModelV4.doGenerate(options);
        },
        doStream: (options: LanguageModelV4CallOptions) => baseModelV4.doStream(options),
      };
      const controller = new AbortController();
      const operation = generateText({
        model: delayedAdapter,
        prompt: 'safe synthetic request',
        maxOutputTokens: GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxOutputTokens,
        maxRetries: 0,
        abortSignal: controller.signal,
      });
      await entered;
      controller.abort('test deadline');
      await expect(operation).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fetches).toBe(0);
      expect(binding.transportEntries()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
