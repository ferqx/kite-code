import { Button, Input } from '@kite-ai/ui/desktop';
import { type RefObject, useRef } from 'react';
import type { NativeUserMcpOperation } from './mcp-bridge';
import { NativeSettingsSelect } from './native-settings-select';

type Row = { id: number; key: string; value: string };
export type McpAddDraft = {
  name: string;
  transport: 'http' | 'stdio';
  url: string;
  command: string;
  cwd: string;
  bearerTokenEnv: string;
  args: Row[];
  env: Row[];
  envPassthrough: Row[];
  headers: Row[];
  headersFromEnv: Row[];
};
export const emptyMcpDraft = (): McpAddDraft => ({
  name: '',
  transport: 'http',
  url: '',
  command: '',
  cwd: '',
  bearerTokenEnv: '',
  args: [],
  env: [],
  envPassthrough: [],
  headers: [],
  headersFromEnv: [],
});
const variable = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const secret = /secret|token|api.?key|password|credential|authorization|cookie/i;
const reservedEnv = /proxy|^(?:LD_|DYLD_|NODE_|BUN_)|^(?:COMSPEC|PATHEXT)$/i;
const reservedKey = /^(?:__proto__|prototype|constructor)$/;
const header = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const reservedHeader =
  /^(?:host|content-length|content-type|accept|connection|transfer-encoding|proxy-.*|mcp-.*)$/i;
const fail = (code: string): never => {
  throw new Error(code);
};

export function mcpDraftEntry(
  draft: McpAddDraft,
): Extract<NativeUserMcpOperation, { kind: 'add' }>['entry'] {
  const pairs = (rows: Row[], kind: 'env' | 'headers' | 'headersFromEnv') => {
    const entries = rows
      .filter((row) => row.key || row.value)
      .map((row) => [row.key.trim(), row.value] as const);
    const keys = entries.map(([key]) => (kind === 'env' ? key : key.toLowerCase()));
    if (new Set(keys).size !== keys.length)
      fail(kind === 'env' ? 'mcp_environment_duplicate' : 'mcp_headers_duplicate');
    for (const [key, value] of entries) {
      if (
        !key ||
        reservedKey.test(key) ||
        (kind === 'env'
          ? !variable.test(key) || reservedEnv.test(key)
          : !header.test(key) || reservedHeader.test(key))
      )
        fail(kind === 'env' ? 'mcp_environment_invalid' : 'mcp_headers_invalid');
      if (kind !== 'headersFromEnv' && secret.test(key)) fail('mcp_secret_requires_environment');
      if (kind === 'headersFromEnv' && (!variable.test(value) || reservedKey.test(value)))
        fail('mcp_environment_invalid');
      if (
        Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        value.includes('${')
      )
        fail('mcp_form_value_invalid');
    }
    return Object.fromEntries(entries);
  };
  if (draft.transport === 'stdio') {
    const args = draft.args.map((row) => row.value).filter((value) => value !== '');
    const env = pairs(draft.env, 'env');
    const envPassthrough = draft.envPassthrough.map((row) => row.value.trim()).filter(Boolean);
    if (
      envPassthrough.some(
        (name) => !variable.test(name) || reservedEnv.test(name) || reservedKey.test(name),
      )
    )
      fail('mcp_environment_invalid');
    if (
      new Set(envPassthrough).size !== envPassthrough.length ||
      envPassthrough.some((name) => Object.hasOwn(env, name))
    )
      fail('mcp_environment_duplicate');
    if (
      args.some(
        (value) =>
          Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
          value.includes('${'),
      )
    )
      fail('mcp_arguments_invalid');
    return {
      type: 'stdio',
      command: draft.command.trim(),
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(envPassthrough.length ? { envPassthrough } : {}),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
    };
  }
  const headers = pairs(draft.headers, 'headers'),
    headersFromEnv = pairs(draft.headersFromEnv, 'headersFromEnv');
  const bearerTokenEnv = draft.bearerTokenEnv.trim();
  if (bearerTokenEnv && (!variable.test(bearerTokenEnv) || reservedKey.test(bearerTokenEnv)))
    fail('mcp_environment_invalid');
  const names = [
    ...Object.keys(headers),
    ...Object.keys(headersFromEnv),
    ...(bearerTokenEnv ? ['Authorization'] : []),
  ].map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length) fail('mcp_headers_duplicate');
  return {
    type: 'http',
    url: draft.url.trim(),
    ...(bearerTokenEnv ? { bearerTokenEnv } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(headersFromEnv).length ? { headersFromEnv } : {}),
  };
}

function FormRows({
  label,
  rows,
  pair,
  onChange,
  disabled,
  addLabel,
  help,
}: {
  label: string;
  rows: Row[];
  pair?: boolean;
  onChange(rows: Row[]): void;
  disabled: boolean;
  addLabel: string;
  help?: string;
}) {
  const add = useRef<HTMLButtonElement>(null);
  return (
    <section className="provider-form-section mcp-form-rows" aria-label={label}>
      <h4>{label}</h4>
      {rows.map((row, index) => (
        <div className={`mcp-form-row${pair ? ' is-pair' : ''}`} key={row.id}>
          {pair && (
            <Input
              aria-label={`${label}名称 ${index + 1}`}
              placeholder="键"
              disabled={disabled}
              value={row.key}
              onChange={(event) =>
                onChange(
                  rows.map((value) =>
                    value.id === row.id ? { ...value, key: event.target.value } : value,
                  ),
                )
              }
            />
          )}
          <Input
            aria-label={`${label}${pair ? '值' : ''} ${index + 1}`}
            placeholder={
              pair
                ? label === '来自环境变量的标头'
                  ? '环境变量名'
                  : '值'
                : label === '参数'
                  ? '参数值'
                  : '环境变量名'
            }
            disabled={disabled}
            value={row.value}
            onChange={(event) =>
              onChange(
                rows.map((value) =>
                  value.id === row.id ? { ...value, value: event.target.value } : value,
                ),
              )
            }
          />
          <Button
            type="button"
            className="provider-button"
            disabled={disabled}
            aria-label={`删除${label} ${index + 1}`}
            onClick={() => {
              onChange(rows.filter((value) => value.id !== row.id));
              add.current?.focus();
            }}
          >
            删除
          </Button>
        </div>
      ))}
      <Button
        ref={add}
        type="button"
        className="provider-button mcp-form-add"
        disabled={disabled || rows.length >= 64}
        onClick={() =>
          onChange([
            ...rows,
            { id: Math.max(0, ...rows.map((row) => row.id)) + 1, key: '', value: '' },
          ])
        }
      >
        ＋ {addLabel}
      </Button>
      {help && <p className="provider-field-help">{help}</p>}
    </section>
  );
}

export function NativeMcpAddFields({
  draft,
  onChange,
  disabled,
  nameField,
  addressField,
  fieldError,
  fieldId,
}: {
  draft: McpAddDraft;
  onChange(draft: McpAddDraft): void;
  disabled: boolean;
  nameField: RefObject<HTMLInputElement | null>;
  addressField: RefObject<HTMLInputElement | null>;
  fieldError?: 'name' | 'address';
  fieldId: string;
}) {
  const update = <K extends keyof McpAddDraft>(key: K, value: McpAddDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <>
      <section className="provider-form-section">
        <h4>连接信息</h4>
        <div className="provider-form-grid">
          <label className="provider-field" htmlFor={`${fieldId}-name`}>
            名称
            <Input
              id={`${fieldId}-name`}
              ref={nameField}
              aria-label="Name"
              placeholder="MCP server name"
              disabled={disabled}
              value={draft.name}
              aria-invalid={fieldError === 'name'}
              onChange={(event) => update('name', event.target.value)}
            />
          </label>
          <label className="provider-field" htmlFor={`${fieldId}-transport`}>
            类型
            <NativeSettingsSelect
              id={`${fieldId}-transport`}
              aria-label="Transport"
              disabled={disabled}
              value={draft.transport}
              onValueChange={(value) => update('transport', value as 'http' | 'stdio')}
              options={[
                { value: 'stdio', label: 'STDIO 本地命令' },
                { value: 'http', label: '流式 HTTP' },
              ]}
            />
          </label>
          <label className="provider-field" htmlFor={`${fieldId}-address`}>
            {draft.transport === 'http' ? 'URL' : '启动命令'}
            <Input
              id={`${fieldId}-address`}
              ref={addressField}
              aria-label="URL or command"
              disabled={disabled}
              value={draft.transport === 'http' ? draft.url : draft.command}
              aria-invalid={fieldError === 'address'}
              onChange={(event) =>
                update(draft.transport === 'http' ? 'url' : 'command', event.target.value)
              }
              placeholder={
                draft.transport === 'http'
                  ? 'https://mcp.example.com/mcp'
                  : '例如：npx，或可执行文件的完整路径'
              }
            />
          </label>
        </div>
        {draft.transport === 'stdio' && (
          <p className="provider-field-help">
            命令与参数分开填写。例如命令填 npx，参数依次添加 -y 和 MCP 包名。
          </p>
        )}
      </section>
      {draft.transport === 'stdio' ? (
        <>
          <FormRows
            label="参数"
            rows={draft.args}
            onChange={(rows) => update('args', rows)}
            disabled={disabled}
            addLabel="添加参数"
          />
          <FormRows
            label="环境变量"
            rows={draft.env}
            onChange={(rows) => update('env', rows)}
            disabled={disabled}
            pair
            addLabel="添加环境变量"
            help="敏感值请通过下方的环境变量传递，填写变量名即可。"
          />
          <FormRows
            label="环境变量传递"
            rows={draft.envPassthrough}
            onChange={(rows) => update('envPassthrough', rows)}
            disabled={disabled}
            addLabel="添加变量"
            help="将列出的系统环境变量额外传递给此服务，无需填写变量值。"
          />
          <section className="provider-form-section">
            <label className="provider-field" htmlFor={`${fieldId}-cwd`}>
              工作目录
              <Input
                id={`${fieldId}-cwd`}
                aria-label="Working directory"
                placeholder="例如：~/code（可选）"
                disabled={disabled}
                value={draft.cwd}
                onChange={(event) => update('cwd', event.target.value)}
              />
            </label>
          </section>
        </>
      ) : (
        <>
          <section className="provider-form-section">
            <label className="provider-field" htmlFor={`${fieldId}-bearer`}>
              Bearer 令牌环境变量
              <Input
                id={`${fieldId}-bearer`}
                aria-label="Bearer token environment variable"
                placeholder="MCP_BEARER_TOKEN（可选）"
                disabled={disabled}
                value={draft.bearerTokenEnv}
                onChange={(event) => update('bearerTokenEnv', event.target.value)}
              />
            </label>
            <p className="provider-field-help">
              填写存放令牌的系统环境变量名，连接时读取；无需手动填写 Authorization。
            </p>
          </section>
          <FormRows
            label="标头"
            rows={draft.headers}
            onChange={(rows) => update('headers', rows)}
            disabled={disabled}
            pair
            addLabel="添加标头"
            help="敏感标头请使用下方的环境变量引用。"
          />
          <FormRows
            label="来自环境变量的标头"
            rows={draft.headersFromEnv}
            onChange={(rows) => update('headersFromEnv', rows)}
            disabled={disabled}
            pair
            addLabel="添加变量"
          />
        </>
      )}
    </>
  );
}
