import type { UserMcpSettingsView } from '@kite-ai/client';
import type { NativeUserMcpOperation, NativeUserMcpSubmission } from './mcp-bridge';

type Source = UserMcpSettingsView['sources'][number];
const authenticationFailures = new Set([
  'mcp_oauth_login_required',
  'mcp_oauth_reauth_required',
  'mcp_oauth_timeout',
  'mcp_oauth_browser_unavailable',
]);
const messages: Record<string, string> = {
  mcp_name_required: '请填写名称，只使用字母、数字、点、横线或下划线。',
  mcp_http_url_invalid: '请填写不含登录信息或查询参数的 HTTP 地址。',
  mcp_absolute_command_required: '请填写启动命令或可执行文件路径；npm 包名应放在 npx 的参数中。',
  mcp_command_not_found: '找不到启动命令，请先安装对应程序，或填写可执行文件的完整路径。',
  mcp_command_launcher_unsupported:
    '此启动脚本暂不可直接执行，请填写对应可执行文件，例如 node，并将脚本路径放入参数。',
  mcp_working_directory_invalid:
    '工作目录不存在或路径无效，请填写已有目录的完整路径或 ~/ 开头的路径。',
  mcp_environment_invalid: '环境变量名无效，或包含不允许传递的运行时配置；请检查后重试。',
  mcp_environment_duplicate: '环境变量重复，请检查环境变量和传递列表中的名称。',
  mcp_environment_variable_missing: '所引用的系统环境变量未设置，请设置后重新启动应用并连接。',
  mcp_environment_variable_invalid: '所引用的系统环境变量值无效，请检查长度与格式。',
  mcp_headers_invalid: '标头名称无效，或覆盖了连接所需的协议标头，请检查后重试。',
  mcp_headers_duplicate: '标头重复，请检查普通标头、环境变量标头与 Bearer 设置。',
  mcp_secret_requires_environment: '令牌、密钥和敏感标头请通过环境变量引用，填写变量名即可。',
  mcp_form_value_invalid: '配置值包含无效字符，请检查后重试。',
  mcp_arguments_invalid: '启动参数格式无效，请将每个参数分开填写。',
  mcp_configuration_limit: 'MCP 配置信息过大，请减少参数、变量或标头的数量和长度。',
  mcp_connection_timeout: 'MCP 服务未及时响应，请检查启动参数、依赖安装和网络后重试。',
  mcp_scope_unavailable: '暂时无法连接应用服务，请稍后重试。',
  mcp_observation_changed: '配置已变化，请刷新列表后重试。',
  mcp_operation_pending: '请先核对尚未确认的操作结果。',
  mcp_storage_unavailable: '暂时无法保存操作，请重新打开应用后重试。',
  mcp_tools_unavailable: '暂时无法读取工具，请重试；若仍失败，请重新连接服务。',
  mcp_source_changed: '配置已变化，请刷新列表后重试。',
  mcp_source_stale: '配置已变化，请刷新列表后重试。',
  mcp_source_conflict: '服务配置已变化，请重新连接以使用新配置。',
  mcp_source_unavailable: '暂时无法读取配置，请刷新列表后重试。',
  mcp_source_invalid: 'MCP 配置格式不正确，请修正配置后刷新列表。',
  mcp_source_exists: '此名称的 MCP 服务已存在，请使用其他名称。',
  mcp_intent_consumed: '该操作已经提交，请核对原操作结果。',
  mcp_server_disabled: '此服务已停用，请先启用服务再连接。',
  mcp_stdio_asset_unavailable: '当前环境无法启动本地 MCP 服务，请检查应用安装是否完整。',
  mcp_connection_exists: '旧连接尚未释放，请重新连接或清理旧连接。',
  mcp_connection_stop_unknown: '尚未确认旧连接已停止，请先核对原操作结果。',
  mcp_http_not_found: '找不到 MCP 接口（HTTP 404），请核对服务地址和路径。',
  mcp_http_endpoint_unsupported: '该地址不接受 MCP 请求，请填写服务提供方给出的 MCP 接口地址。',
  mcp_http_forbidden: '服务拒绝访问（HTTP 403），请确认当前账号或凭据具有访问权限。',
  mcp_http_timeout: '连接超时，请检查网络和 MCP 服务的运行状态后重试。',
  mcp_http_dns_unavailable: '无法解析服务域名，请检查地址拼写及网络 DNS。',
  mcp_http_request_failed: '无法访问 MCP 服务，请检查网络及服务的运行状态。',
  mcp_http_response_failed: '服务响应未能完成，请检查服务状态后重试。',
  mcp_http_server_error: 'MCP 服务发生内部错误，请稍后重试或联系服务提供方。',
  mcp_http_rate_limited: '服务请求过于频繁，请稍后重试。',
  mcp_http_redirect_denied: '服务地址发生跳转，请填写最终的 MCP 接口地址。',
  mcp_http_destination_denied: '该服务地址不符合网络访问要求，请检查 MCP 地址。',
  mcp_http_configuration_invalid: 'HTTP 连接配置不正确，请检查 MCP 服务地址和配置。',
  mcp_oauth_login_required: '此服务需要登录，请完成登录后再建立连接。',
  mcp_oauth_reauth_required: '登录已失效，请重新登录后再建立连接。',
  mcp_oauth_timeout: '登录已超时，请重新点击“登录”并在浏览器中完成授权。',
  mcp_oauth_browser_unavailable: '无法打开浏览器，请检查系统默认浏览器后重试登录。',
  mcp_credential_store_locked: '系统凭据存储已锁定，请解锁后重试。',
  mcp_credential_store_unavailable: '系统凭据存储暂不可用，请恢复后重试。',
  mcp_credential_binding_expired: '访问凭据已过期，请更新凭据有效期后再连接。',
};

export function mcpSettingsError(
  code?: string,
  operation?: NativeUserMcpOperation,
  source?: Source,
): string {
  const connection = operation?.kind === 'connect' || operation?.kind === 'reconnect';
  if (code === 'mcp_connection_timeout' && source?.transport === 'http')
    return messages.mcp_http_timeout!;
  if (code === 'mcp_http_unauthorized')
    return source?.authentication.loginAllowed
      ? messages.mcp_oauth_login_required!
      : '服务未接受访问凭据（HTTP 401），请核对凭据和服务的访问要求。';
  if (code && messages[code]) return messages[code];
  if (connection)
    return source?.transport === 'stdio'
      ? '本地 MCP 服务未能启动，请检查命令路径、依赖和启动配置。'
      : '未能建立 MCP 连接，请确认填写的是 MCP 接口地址，并检查服务和网络。';
  if (operation?.kind === 'login' || operation?.kind === 'authRefresh')
    return '登录未能完成，请重新发起登录并在浏览器中完成授权。';
  if (operation?.kind === 'add' || operation?.kind === 'enabled' || operation?.kind === 'remove')
    return '未能保存 MCP 配置，请检查配置文件是否可写后重试。';
  if (operation?.kind === 'refresh') return '未能刷新工具目录，请重试或重新连接服务。';
  if (operation?.kind === 'disconnect') return '未能清理连接，请重试；结果未知时请先核对原操作。';
  return '操作未能完成，请检查服务配置后重试。';
}

export type McpFeedbackNotice = {
  key: string;
  row: NativeUserMcpSubmission;
  failures: NativeUserMcpSubmission[];
};

const sourceKey = (row: NativeUserMcpSubmission) =>
  JSON.stringify([
    row.storeId,
    row.association,
    row.legacy
      ? row.commandId
      : row.operation.kind === 'add'
        ? ['add', row.operation.name]
        : row.operation.serverId,
  ]);

/** Fold confirmed failures only. Every unconfirmed original retains its independent recovery action. */
export function mcpFeedbackNotices(
  rows: readonly NativeUserMcpSubmission[],
  sources: readonly Source[],
  dismissed: readonly string[],
): McpFeedbackNotice[] {
  const latest = new Map(
    rows
      .filter((row) => ['completed', 'cancelled', 'failed'].includes(row.phase))
      .map((row) => [sourceKey(row), row]),
  );
  const failures = new Map<string, NativeUserMcpSubmission[]>();
  for (const row of rows)
    if (row.phase === 'failed' && !dismissed.includes(row.commandId)) {
      const key = sourceKey(row);
      failures.set(key, [...(failures.get(key) ?? []), row]);
    }
  const notices: McpFeedbackNotice[] = [];
  for (const row of rows) {
    if (dismissed.includes(row.commandId) || row.phase === 'completed' || row.phase === 'cancelled')
      continue;
    if (
      (row.phase === 'pending' || row.phase === 'submitting') &&
      row.association === 'current' &&
      !row.legacy
    )
      continue;
    if (row.phase === 'failed') {
      const key = sourceKey(row);
      if (latest.get(key)?.commandId !== row.commandId) continue;
      const serverId = 'serverId' in row.operation ? row.operation.serverId : undefined;
      const source = sources.find((source) => source.id === serverId);
      if (
        source &&
        ((authenticationFailures.has(row.error ?? '') &&
          source.authentication.status === 'present') ||
          (['connect', 'reconnect'].includes(row.operation.kind) &&
            source.connection.state === 'ready'))
      )
        continue;
      notices.push({ key: `failure/${key}`, row, failures: failures.get(key) ?? [row] });
    } else notices.push({ key: row.commandId, row, failures: [] });
  }
  return notices;
}
