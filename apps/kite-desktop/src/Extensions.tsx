import type { AppMcpServer } from '@kite-ai/kite-app-contract';
import { Button } from '@kite-ai/kite-client-ui';
import { useEffect, useState } from 'react';
import type { DesktopClient, DesktopView } from './client';

const configLabels: Record<AppMcpServer['configStatus'], string> = {
  ready: '已就绪',
  pending_approval: '等待项目配置批准',
  rejected: '配置已拒绝',
  disabled: '已禁用',
  invalid: '配置无效',
  store_corrupt: '配置存储损坏',
  store_unavailable: '配置存储不可用',
};
const healthLabels: Record<AppMcpServer['health'], string> = {
  disconnected: '未连接',
  discovering: '发现工具中',
  connecting: '连接中',
  ready: '已连接',
  degraded: '部分可用',
  half_open: '恢复检查中',
  circuit_open: '暂时熔断',
  quarantined: '已隔离',
  failed: '连接失败',
};
const authLabels: Record<AppMcpServer['authStatus'], string> = {
  not_required: '无需认证',
  authenticated: '已认证',
  authorizing: '认证中',
  refreshing: '刷新认证中',
  login_required: '需要认证',
  reauth_required: '需要重新认证',
  error: '认证失败',
};

export function Extensions({
  client,
  view,
  busy,
  act,
  section,
}: {
  client: DesktopClient;
  view: DesktopView;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
  section: 'mcp' | 'skills';
}) {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!view.connected) return;
    let current = true;
    setLoading(true);
    client.clearError();
    const request = section === 'mcp' ? client.refreshMcp() : client.refreshSkills();
    void request
      .catch((error) => {
        if (current) client.report(error);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, section, view.connected]);
  return (
    <section className="extension-settings" aria-label={section === 'mcp' ? 'MCP' : 'Skills'}>
      <div className="settings-section-heading">
        <h2>{section === 'mcp' ? 'MCP' : 'Skills'}</h2>
        <Button
          disabled={busy || loading || !view.connected}
          onClick={() =>
            void act(() => (section === 'mcp' ? client.refreshMcp() : client.refreshSkills()))
          }
        >
          {busy || loading ? '正在处理…' : '刷新状态'}
        </Button>
      </div>
      {!view.connected ? (
        <p>连接项目后查看扩展。</p>
      ) : section === 'mcp' ? (
        !view.mcp ? (
          <p>尚未取得 MCP 状态。</p>
        ) : !view.mcp.servers.length ? (
          <p>当前项目没有配置 MCP Server。</p>
        ) : (
          view.mcp.servers.map((server) => {
            const canOperate =
              server.effective && server.enabled && server.configStatus === 'ready';
            const needsAuth = ['login_required', 'reauth_required', 'error'].includes(
              server.authStatus,
            );
            const authenticating =
              server.authStatus === 'authorizing' || server.authStatus === 'refreshing';
            return (
              <section className="extension-card" key={`${server.key.source}:${server.key.name}`}>
                <div className="settings-section-heading">
                  <strong>{server.key.name}</strong>
                  <span>{healthLabels[server.health]}</span>
                </div>
                <p>
                  {server.key.source === 'project'
                    ? '项目'
                    : server.key.source === 'user'
                      ? '用户'
                      : '显式配置'}{' '}
                  · {server.transport} · {authLabels[server.authStatus]}
                </p>
                {server.configStatus !== 'ready' && (
                  <p>配置状态：{configLabels[server.configStatus]}</p>
                )}
                {!server.effective && <p>当前由其他配置来源生效。</p>}
                <details>
                  <summary>连接详情</summary>
                  <p>{server.sourcePath}</p>
                  <p>{server.configuration.endpoint || server.configuration.command}</p>
                  <p>
                    {server.toolCount} 个工具 · {server.resourceCount} 个资源 · {server.promptCount}{' '}
                    个提示
                  </p>
                  {!!server.tools.length && (
                    <ul>
                      {server.tools.map((tool) => (
                        <li key={tool.name}>
                          <strong>{tool.name}</strong> · {tool.discovered ? '已发现' : '尚未发现'}
                          {tool.description && <p>{tool.description}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
                {(server.diagnostic || server.authErrorCode) && (
                  <p role="status">
                    {server.diagnostic?.code} {server.authErrorCode}
                  </p>
                )}
                {canOperate && (
                  <div className="actions">
                    {authenticating ? (
                      <>
                        <p>请在浏览器中完成认证，然后刷新状态。</p>
                        {server.authFlowId && (
                          <Button
                            disabled={busy || loading}
                            onClick={() =>
                              void act(() => client.runMcpAction(server, 'cancel_auth'))
                            }
                          >
                            取消认证
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        {['login_required', 'reauth_required', 'error'].includes(
                          server.authStatus,
                        ) && (
                          <Button
                            disabled={busy || loading}
                            onClick={() => void act(() => client.runMcpAction(server, 'login'))}
                          >
                            开始认证
                          </Button>
                        )}
                        {!needsAuth && server.health !== 'ready' && (
                          <Button
                            disabled={busy || loading}
                            onClick={() => void act(() => client.runMcpAction(server, 'reconnect'))}
                          >
                            重新连接
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )
      ) : !view.skills ? (
        <p>尚未取得 Skills 目录。</p>
      ) : !view.skills.skills.length ? (
        <p>当前项目没有可发现的 Skill。</p>
      ) : (
        view.skills.skills.map((skill) => (
          <details className="extension-card" key={`${skill.source}:${skill.origin}:${skill.name}`}>
            <summary>
              {skill.name} ·{' '}
              {skill.status === 'available'
                ? '可用'
                : skill.status === 'disabled'
                  ? '已禁用'
                  : '无效'}
            </summary>
            <p>{skill.description}</p>
            <p>
              {skill.source === 'project' ? '项目' : '用户'} · {skill.origin}
            </p>
            {skill.diagnosticCode && <p>{skill.diagnosticCode}</p>}
          </details>
        ))
      )}
    </section>
  );
}
