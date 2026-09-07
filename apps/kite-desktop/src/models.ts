import type { AppModelProviderType, ProviderModelSnapshot } from '@kite-ai/kite-app-contract';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client/protocol';

export interface ProviderInput {
  provider: AppModelProviderType;
  apiKey: string;
  baseURL: string;
  modelName: string;
}

const errors: Record<string, string> = {
  invalid_request: '配置无效，请检查 Provider、地址和密钥。',
  credential_unavailable: 'Provider 拒绝了密钥，请重新输入。',
  not_found: '地址没有提供模型列表，可检查地址或手动填写模型名称。',
  model_required: '未发现模型，请手动填写模型名称后保存。',
  provider_incompatible: '服务返回的模型列表不兼容，请检查地址。',
  temporarily_unavailable: '无法连接或保存配置，请检查服务后再试。',
};

/** Secrets stay in the exact native write, never in the presentation snapshot. */
export async function saveProvider(
  connection: Pick<KiteAppServerConnection, 'credential'>,
  input: ProviderInput,
  refresh: () => Promise<ProviderModelSnapshot>,
): Promise<void> {
  let result: Awaited<ReturnType<KiteAppServerConnection['credential']['writeProviderCredential']>>;
  try {
    result = await connection.credential.writeProviderCredential({
      schema: 'kite.local-runtime-credential-request.v1',
      mutationId: crypto.randomUUID(),
      operation: 'write_provider_api_key',
      providerId: input.provider,
      apiKey: input.apiKey,
      ...(input.baseURL.trim() ? { baseURL: input.baseURL.trim() } : {}),
      ...(input.modelName.trim() ? { modelName: input.modelName.trim() } : {}),
    });
  } catch {
    await refresh().catch(() => undefined);
    throw new Error('配置提交结果未知。请刷新并检查当前配置，再决定是否重新保存。');
  } finally {
    input.apiKey = '';
  }
  await refresh();
  if (result.outcome === 'outcome_unknown')
    throw new Error('配置提交结果未知。已查询当前配置，请检查后再决定是否重新保存。');
  if (result.outcome !== 'applied')
    throw new Error(errors[result.errorCode ?? ''] ?? '配置未保存，请检查当前状态。');
}
