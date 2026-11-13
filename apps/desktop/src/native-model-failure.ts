const modelFailures = {
  model_authentication_required: {
    summary: '无认证',
    text: '无认证。请在「设置 → 提供商与模型」检查所选提供商的认证配置，或选择其他可用模型。',
  },
  model_access_denied: {
    summary: '提供商拒绝访问模型',
    text: '提供商拒绝了对所选模型的访问。请检查账号的模型权限，或选择其他可用模型。',
  },
  credential_unavailable: {
    summary: '无法读取模型凭据',
    text: '无法读取所选提供商已配置的凭据。请在「设置 → 提供商与模型」检查凭据配置。',
  },
  model_credentials_locked: {
    summary: '本机凭据库拒绝读取',
    text: '本机凭据库已锁定或尚未允许当前版本读取。请解锁凭据库，或在「设置 → 提供商与模型」重新保存连接后再试。',
  },
  model_credentials_backend_unavailable: {
    summary: '本机凭据库不可用',
    text: '系统凭据服务未运行或不可用。请恢复系统凭据服务后重新发送。',
  },
  codex_auth_required: {
    summary: '无认证',
    text: '无认证。请在 Codex 中登录对应账号，或选择其他可用模型。',
  },
  codex_auth_expired: {
    summary: 'Codex 登录已过期',
    text: 'Codex 登录已过期。请在 Codex 中重新登录后再试。',
  },
  codex_auth_invalid: {
    summary: 'Codex 登录信息无效',
    text: 'Codex 登录信息无效。请在 Codex 中重新登录后再试。',
  },
  codex_auth_unavailable: {
    summary: '无法读取 Codex 登录信息',
    text: '无法读取 Codex 登录信息。请检查本机 Codex 登录状态后再试。',
  },
};

/** Public copy is selected only from known codes, never from a provider response body. */
export function nativeModelFailure(code: unknown) {
  return typeof code === 'string' && Object.hasOwn(modelFailures, code)
    ? { ...modelFailures[code as keyof typeof modelFailures], reasonCode: code }
    : undefined;
}
