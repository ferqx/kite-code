import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ToolSet } from 'ai';
import { type AgentConfig, getFeatureFlags } from '@/core/config';
import { createApprovedProviderDataAdmissionV1 } from '@/core/config/provider-data-admission';
import type { AIMessage, BaseMessage } from '@/core/messages';
import type { ModelProviderOptions, SupportedChatModel } from '@/core/model/factory';
import { createInstalledModelInvocationGatewayV1 } from '@/core/model/invocation-composition';
import {
  computeModelInvocationPrivateDigestV1,
  type ModelInvocationGatewayV1,
  normalizedModelResponseToAIMessageV1,
} from '@/core/model/invocation-gateway';
import { compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import { createAgentKernel } from '@/core/runtime/kernel';
import { createRuntimeSecretDetectorV1 } from '@/core/session-logger/content-inspector';

const EVAL_RUNTIME_PREFIX = 'kite-model-eval-';

/**
 * Explicit durable composition for live evals and provider smoke tests. These
 * scripts exercise the same Gateway evidence ordering as production and own
 * no SDK dispatch escape hatch.
 */
export class ModelInvocationEvalSessionV1 {
  readonly #runtimeDirectory: string;
  readonly #kernel: ReturnType<typeof createAgentKernel>;
  readonly #gateway: ModelInvocationGatewayV1;
  #closed = false;

  constructor(workspace: string, gateway?: ModelInvocationGatewayV1) {
    this.#gateway = gateway ?? createInstalledModelInvocationGatewayV1();
    this.#runtimeDirectory = mkdtempSync(join(tmpdir(), EVAL_RUNTIME_PREFIX));
    this.#kernel = createAgentKernel({
      threadId: `eval-${randomUUID()}`,
      userId: 'live-eval',
      workspace,
      storePath: join(this.#runtimeDirectory, 'runtime.db'),
      interactionMode: 'full',
      phase: 'building',
      sandboxAvailable: false,
    });
  }

  async invoke(input: {
    purpose?: 'primary_agent' | 'context_compaction';
    config: AgentConfig;
    model: SupportedChatModel;
    messages: readonly BaseMessage[];
    tools?: ToolSet;
    maxOutputTokens: number;
    providerOptions?: ModelProviderOptions;
    signal?: AbortSignal;
  }): Promise<AIMessage> {
    if (this.#closed) throw new Error('Model eval invocation session is closed.');
    const purpose = input.purpose ?? 'primary_agent';
    const tools = input.tools ?? {};
    const compiled = compileModelSurfaceV1({
      purpose,
      config: input.config,
      model: input.model,
      messages: input.messages,
      tools,
      maxOutputTokens: input.maxOutputTokens,
      providerOptions: input.providerOptions,
      transport: 'generate',
    });
    const flags = getFeatureFlags(input.config);
    const providerDataAdmission = flags.providerDataPolicyV1
      ? createApprovedProviderDataAdmissionV1(
          input.config,
          new Date(),
          createRuntimeSecretDetectorV1({ knownSecrets: [input.config.apiKey] }),
        )
      : undefined;
    const pending = await this.#gateway.invoke({
      model: input.model,
      compiled,
      persistence: {
        getState: () => this.#kernel.getState(),
        persistEvents: async (events) =>
          this.#kernel.processEventBatch(events).length === events.length,
      },
      provenance: {
        promptContractVersion: 'live-eval-model-surface-v1',
        projectionEnvironmentDigest: computeModelInvocationPrivateDigestV1(
          'kite.live-eval.projection-environment.v1',
          { purpose },
        ),
        capabilityBindingDigest: computeModelInvocationPrivateDigestV1(
          'kite.live-eval.capability-binding.v1',
          { toolNames: Object.keys(tools) },
        ),
      },
      providerDataAdmission,
      providerDataPolicyRequired: flags.providerDataPolicyV1,
      resourceKind: purpose === 'context_compaction' ? 'compaction' : 'model',
      signal: input.signal,
    });
    return normalizedModelResponseToAIMessageV1(await pending.commit());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#kernel.close();
    if (!basename(this.#runtimeDirectory).startsWith(EVAL_RUNTIME_PREFIX)) {
      throw new Error('Refusing to remove an unexpected eval Runtime directory.');
    }
    rmSync(this.#runtimeDirectory, { recursive: true, force: true });
  }
}
