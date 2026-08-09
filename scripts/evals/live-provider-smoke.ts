import { generateText } from 'ai';
import type { AgentConfig } from '../../src/core/config';
import { loadAgentConfig } from '../../src/core/config';
import { createChatModel } from '../../src/core/model/factory';

const OPENCODE_GO_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
const OPENCODE_GO_DEFAULT_MODEL = 'deepseek-v4-flash';
const OPENCODE_GO_DEFAULT_PROVIDER_NAME = 'opencode_go';
const OPENCODE_GO_REQUIRED_HOST = 'opencode.ai';

export interface LiveProviderSmokeReportV1 {
  schema: 'LiveProviderSmokeReportV1';
  status: 'passed';
  provider: 'deepseek' | 'opencode-go';
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
  if (input.provider === 'opencode-go' && input.config.providerType !== 'openai-compatible') {
    throw new Error('opencode_go_provider_type_mismatch');
  }
  const startedAt = performance.now();
  const binding = createChatModel(input.config);
  const result = await generateText({
    model: binding.model,
    prompt: 'Reply with exactly OK.',
    temperature: 0,
    maxOutputTokens: input.provider === 'opencode-go' ? 128 : 16,
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

export function resolveOpenCodeGoConfig(): {
  config: AgentConfig;
  credentialSource: LiveProviderSmokeReportV1['credentialSource'];
} {
  const environmentKey = process.env.OPENCODE_API_KEY;
  if (environmentKey) {
    const baseURL = process.env.KITE_OPENCODE_GO_BASE_URL ?? OPENCODE_GO_DEFAULT_BASE_URL;
    const modelName = process.env.KITE_OPENCODE_GO_MODEL ?? OPENCODE_GO_DEFAULT_MODEL;
    assertOpenCodeGoRoute(baseURL, modelName);
    return {
      credentialSource: 'environment',
      config: {
        providerName: OPENCODE_GO_DEFAULT_PROVIDER_NAME,
        providerType: 'openai-compatible',
        apiKey: environmentKey,
        baseURL,
        modelName,
        sandbox: { enabled: true },
      },
    };
  }
  const providerName =
    process.env.KITE_OPENCODE_GO_PROVIDER_NAME ?? OPENCODE_GO_DEFAULT_PROVIDER_NAME;
  const config = loadAgentConfig({ providerName, modelName: OPENCODE_GO_DEFAULT_MODEL });
  if (config.providerType !== 'openai-compatible') {
    throw new Error('opencode_go_provider_type_mismatch');
  }
  assertOpenCodeGoRoute(config.baseURL, config.modelName);
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

function assertOpenCodeGoRoute(endpoint: string, modelName: string): void {
  if (modelName !== OPENCODE_GO_DEFAULT_MODEL) throw new Error('opencode_go_model_mismatch');
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.port !== '' ||
      url.hostname !== OPENCODE_GO_REQUIRED_HOST ||
      !['/zen/go/v1', '/zen/go/v1/'].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('provider_endpoint_unsafe');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'provider_endpoint_unsafe') throw error;
    throw new Error('provider_endpoint_unsafe');
  }
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function main(): Promise<void> {
  const providerIndex = process.argv.indexOf('--provider');
  const selected = providerIndex >= 0 ? process.argv[providerIndex + 1] : 'all';
  if (selected !== 'all' && selected !== 'deepseek' && selected !== 'opencode-go') {
    throw new Error('provider_selection_invalid');
  }
  const reports: LiveProviderSmokeReportV1[] = [];
  if (selected === 'all' || selected === 'deepseek') {
    const resolved = resolveDeepSeekConfig();
    reports.push(await runLiveProviderSmoke({ provider: 'deepseek', ...resolved }));
  }
  if (selected === 'all' || selected === 'opencode-go') {
    const resolved = resolveOpenCodeGoConfig();
    reports.push(await runLiveProviderSmoke({ provider: 'opencode-go', ...resolved }));
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
