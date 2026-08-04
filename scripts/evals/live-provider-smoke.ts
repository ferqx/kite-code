import { generateText } from 'ai';
import type { AgentConfig } from '../../src/core/config';
import { loadAgentConfig } from '../../src/core/config';
import { createChatModel } from '../../src/core/model/factory';

const QWEN_DEFAULT_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const QWEN_DEFAULT_MODEL = 'qwen3.6-flash';
const QWEN_REQUIRED_HOST = 'token-plan.cn-beijing.maas.aliyuncs.com';

export interface LiveProviderSmokeReportV1 {
  schema: 'LiveProviderSmokeReportV1';
  status: 'passed';
  provider: 'deepseek' | 'qwen-openai-compatible';
  providerType: 'deepseek' | 'openai-compatible';
  model: string;
  durationMs: number;
  responseNonEmpty: true;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  contentLogged: false;
  credentialSource: 'environment' | 'local_config';
}

export async function runLiveProviderSmoke(input: {
  provider: LiveProviderSmokeReportV1['provider'];
  config: AgentConfig;
  credentialSource: LiveProviderSmokeReportV1['credentialSource'];
  timeoutMs?: number;
}): Promise<LiveProviderSmokeReportV1> {
  if (!input.config.apiKey) throw new Error('provider_credential_missing');
  if (input.provider === 'deepseek' && input.config.providerType !== 'deepseek') {
    throw new Error('deepseek_provider_type_mismatch');
  }
  if (
    input.provider === 'qwen-openai-compatible' &&
    input.config.providerType !== 'openai-compatible'
  ) {
    throw new Error('qwen_provider_type_mismatch');
  }
  const startedAt = performance.now();
  const binding = createChatModel(input.config);
  const result = await generateText({
    model: binding.model,
    prompt: 'Reply with one short acknowledgement.',
    temperature: 0,
    maxOutputTokens: 16,
    providerOptions: binding.compactionProviderOptions,
    abortSignal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  });
  if (!result.text.trim()) throw new Error('provider_response_empty');
  return {
    schema: 'LiveProviderSmokeReportV1',
    status: 'passed',
    provider: input.provider,
    providerType: input.config.providerType === 'deepseek' ? 'deepseek' : 'openai-compatible',
    model: input.config.modelName,
    durationMs: Math.round(performance.now() - startedAt),
    responseNonEmpty: true,
    usage: {
      inputTokens: finiteOrNull(result.usage.inputTokens),
      outputTokens: finiteOrNull(result.usage.outputTokens),
      totalTokens: finiteOrNull(result.usage.totalTokens),
    },
    contentLogged: false,
    credentialSource: input.credentialSource,
  };
}

function resolveDeepSeekConfig(): {
  config: AgentConfig;
  credentialSource: LiveProviderSmokeReportV1['credentialSource'];
} {
  const environmentKey = process.env.DEEPSEEK_API_KEY;
  if (environmentKey) {
    return {
      credentialSource: 'environment',
      config: {
        providerName: 'deepseek',
        providerType: 'deepseek',
        apiKey: environmentKey,
        baseURL: 'https://api.deepseek.com/v1',
        modelName: 'deepseek-v4-flash',
        sandbox: { enabled: true },
      },
    };
  }
  const config = loadAgentConfig({ providerName: 'deepseek', modelName: 'deepseek-v4-flash' });
  if (
    config.providerType !== 'deepseek' ||
    config.modelName !== 'deepseek-v4-flash' ||
    !isExactDeepSeekEndpoint(config.baseURL)
  ) {
    throw new Error('deepseek_route_mismatch');
  }
  return { config, credentialSource: 'local_config' };
}

export function resolveQwenConfig(): {
  config: AgentConfig;
  credentialSource: LiveProviderSmokeReportV1['credentialSource'];
} {
  const environmentKey = process.env.DASHSCOPE_API_KEY;
  if (environmentKey) {
    const baseURL = process.env.KITE_QWEN_BASE_URL ?? QWEN_DEFAULT_BASE_URL;
    const modelName = process.env.KITE_QWEN_MODEL ?? QWEN_DEFAULT_MODEL;
    assertQwenRoute(baseURL, modelName);
    return {
      credentialSource: 'environment',
      config: {
        providerName: 'qwen-openai-compatible',
        providerType: 'openai-compatible',
        apiKey: environmentKey,
        baseURL,
        modelName,
        sandbox: { enabled: true },
      },
    };
  }
  const providerName = process.env.KITE_QWEN_PROVIDER_NAME;
  if (!providerName) throw new Error('qwen_credential_missing');
  const config = loadAgentConfig({ providerName });
  if (config.providerType !== 'openai-compatible') throw new Error('qwen_provider_type_mismatch');
  assertQwenRoute(config.baseURL, config.modelName);
  return { config, credentialSource: 'local_config' };
}

function isExactDeepSeekEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.deepseek.com' &&
      url.port === '' &&
      (url.pathname === '/' || url.pathname === '/v1' || url.pathname === '/v1/') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function assertQwenRoute(endpoint: string, modelName: string): void {
  if (!/^qwen[-a-z0-9.]*$/i.test(modelName)) throw new Error('qwen_model_mismatch');
  const value = endpoint;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.hostname !== QWEN_REQUIRED_HOST ||
    !['/compatible-mode/v1', '/compatible-mode/v1/'].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('provider_endpoint_unsafe');
  }
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function main(): Promise<void> {
  const providerIndex = process.argv.indexOf('--provider');
  const selected = providerIndex >= 0 ? process.argv[providerIndex + 1] : 'all';
  if (selected !== 'all' && selected !== 'deepseek' && selected !== 'qwen') {
    throw new Error('provider_selection_invalid');
  }
  const reports: LiveProviderSmokeReportV1[] = [];
  if (selected === 'all' || selected === 'deepseek') {
    const resolved = resolveDeepSeekConfig();
    reports.push(await runLiveProviderSmoke({ provider: 'deepseek', ...resolved }));
  }
  if (selected === 'all' || selected === 'qwen') {
    const resolved = resolveQwenConfig();
    reports.push(await runLiveProviderSmoke({ provider: 'qwen-openai-compatible', ...resolved }));
  }
  for (const report of reports) console.log(JSON.stringify(report));
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(
      JSON.stringify({
        schema: 'LiveProviderSmokeReportV1',
        status: 'failed',
        reason: 'provider_smoke_failed',
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}
