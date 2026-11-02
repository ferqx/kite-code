import type { UserMcpSettingsView, UserMcpToolsPage } from '@kite-ai/client';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SettingsActionIcon,
} from '@kite-ai/ui/desktop';
import { useId, useState } from 'react';
import type { NativeUserMcpOperation } from './mcp-bridge';

export function McpSourceMenu({
  source,
  disabled,
  container,
  onAction,
  onBind,
  onCancel,
  cancelDisabled,
}: {
  source: UserMcpSettingsView['sources'][number];
  disabled: boolean;
  container: HTMLElement;
  onAction: (operation: NativeUserMcpOperation, confirm?: boolean) => void;
  onBind: () => void;
  onCancel?: () => void;
  cancelDisabled?: boolean;
}) {
  const connected = source.connection.state === 'ready';
  const disconnect = connected || source.connection.state === 'connecting';
  const cleanup =
    source.connection.state === 'outcome_unknown' ||
    (source.connection.state === 'failed' &&
      (source.connection.generation !== null ||
        source.diagnostics.includes('mcp_source_conflict')));
  const authenticated = source.authentication.status === 'present';
  const item = (
    label: string,
    kind: 'refresh' | 'reconnect' | 'disconnect' | 'login' | 'authRefresh' | 'clear' | 'revoke',
    confirm = false,
  ) => (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onAction({ kind, serverId: source.id }, confirm)}
    >
      {label}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          className="provider-button"
          size="icon-sm"
          aria-label="更多操作"
          title="更多操作"
          disabled={disabled && !onCancel}
        >
          <SettingsActionIcon name="more" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent container={container} align="end">
        {onCancel ? (
          <DropdownMenuItem disabled={cancelDisabled} onSelect={onCancel}>
            取消操作
          </DropdownMenuItem>
        ) : (
          <>
            {connected && item('刷新工具', 'refresh')}
            {source.enabled && connected && item('重新连接', 'reconnect')}
            {disconnect && item('断开连接', 'disconnect')}
            {cleanup && item('清理连接', 'disconnect')}
            {authenticated && source.authentication.policy !== 'none' && (
              <>
                {source.authentication.loginAllowed && item('重新登录', 'login')}
                {item('刷新授权', 'authRefresh')}
                {item('退出登录', 'clear', true)}
                {item('撤销授权', 'revoke', true)}
              </>
            )}
            {source.authentication.policy === 'credential' && (
              <DropdownMenuItem disabled={disabled} onSelect={onBind}>
                更新凭据有效期
              </DropdownMenuItem>
            )}
            {(connected ||
              authenticated ||
              disconnect ||
              cleanup ||
              source.authentication.policy === 'credential') && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={disabled}
              onSelect={() => onAction({ kind: 'remove', serverId: source.id }, true)}
            >
              删除 MCP
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const toolInfo = (value: unknown) => {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    name: typeof row.name === 'string' ? row.name : '工具',
    description: typeof row.description === 'string' ? row.description : undefined,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
  };
};

export function McpToolCatalogue({
  page,
  loading,
  failed,
  onRetry,
  onMore,
}: {
  page?: UserMcpToolsPage;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onMore: (after: number) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<number>();
  return (
    <section className="provider-form-section mcp-tool-catalogue" aria-label="可用工具">
      <h4>工具{page && <span className="mcp-tool-count">{page.entries.length}</span>}</h4>
      {failed && !page ? (
        <div className="catalogue-actions">
          <p className="provider-field-help">未能加载工具。</p>
          <Button className="provider-button" disabled={loading} onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : !page ? (
        <p className="provider-field-help" role="status">
          正在加载工具…
        </p>
      ) : (
        <>
          <ul className="mcp-tool-list">
            {page.entries.map((entry) => {
              const info = toolInfo(entry.descriptor);
              const canExpand = info.inputSchema !== undefined || info.outputSchema !== undefined;
              const open = expanded === entry.index;
              return (
                <li key={entry.index}>
                  {canExpand ? (
                    <Button
                      className="mcp-tool-trigger"
                      aria-expanded={open}
                      aria-controls={`${id}-${entry.index}`}
                      onClick={() => setExpanded(open ? undefined : entry.index)}
                    >
                      <strong>{info.name}</strong>
                      <SettingsActionIcon name="expand" className={open ? 'rotate-180' : ''} />
                    </Button>
                  ) : (
                    <strong>{info.name}</strong>
                  )}
                  {info.description && <p className="provider-field-help">{info.description}</p>}
                  {open && (
                    <div id={`${id}-${entry.index}`}>
                      {info.inputSchema !== undefined && (
                        <>
                          <h5>输入参数</h5>
                          <pre data-mcp-schema="input">
                            {JSON.stringify(info.inputSchema, null, 2)}
                          </pre>
                        </>
                      )}
                      {info.outputSchema !== undefined && (
                        <>
                          <h5>返回内容</h5>
                          <pre data-mcp-schema="output">
                            {JSON.stringify(info.outputSchema, null, 2)}
                          </pre>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {page.nextAfterIndex !== null && (
            <Button
              className="provider-button"
              disabled={loading}
              onClick={() => onMore(page.nextAfterIndex!)}
            >
              {loading ? '正在加载…' : '加载更多'}
            </Button>
          )}
          {!page.entries.length && page.complete && (
            <p className="provider-field-help">此服务暂未提供工具。</p>
          )}
        </>
      )}
    </section>
  );
}
