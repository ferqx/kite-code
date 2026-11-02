import { isAbsolute } from 'node:path';
import { ConfigurationError } from './types';

export type McpSourceEntry =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      envPassthrough?: string[];
      cwd?: string;
    }
  | {
      type: 'http';
      url: string;
      bearerTokenEnv?: string;
      headers?: Record<string, string>;
      headersFromEnv?: Record<string, string>;
    };

export const mcpEnvironmentName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const mcpReservedEnvironment = /proxy|^(?:LD_|DYLD_|NODE_|BUN_)|^(?:COMSPEC|PATHEXT)$/i;
export const mcpSecretName = /secret|token|api.?key|password|credential|authorization|cookie/i;
export const mcpReservedHeader =
  /^(?:host|content-length|content-type|accept|connection|transfer-encoding|proxy-.*|mcp-.*)$/i;
export const mcpHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const text = (value: unknown, max = 8192) =>
  typeof value === 'string' &&
  value.length <= max &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  !value.includes('${');
function fail(code = 'mcp_source_mutation_invalid'): never {
  throw new ConfigurationError(code);
}

/** Finite, nonsecret declaration. Environment references contain names, never host values. */
export function validateMcpSourceEntry(
  value: unknown,
  options: { allowLaunchNames?: boolean; sourceDocument?: boolean } = {},
): asserts value is McpSourceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const entry = value as Record<string, unknown>;
  if (!options.sourceDocument && Buffer.byteLength(JSON.stringify(entry)) > 60000)
    fail('mcp_configuration_limit');
  const keys =
    entry.type === 'stdio'
      ? ['type', 'command', 'args', 'env', 'envPassthrough', 'cwd']
      : ['type', 'url', 'bearerTokenEnv', 'headers', 'headersFromEnv'];
  if (Object.keys(entry).some((key) => !keys.includes(key))) fail();
  const map = (input: unknown, validate: (key: string, value: unknown) => boolean, max: number) => {
    if (input === undefined) return;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length > max ||
      Object.entries(input).some(
        ([key, value]) =>
          /^(?:__proto__|prototype|constructor)$/.test(key) || !validate(key, value),
      )
    )
      fail();
  };
  if (entry.type === 'stdio') {
    const folded = (name: string) => (process.platform === 'win32' ? name.toUpperCase() : name);
    if (
      !text(entry.command, options.sourceDocument ? 8192 : 4096) ||
      !entry.command ||
      (!isAbsolute(entry.command as string) &&
        !(options.allowLaunchNames && /^[A-Za-z0-9._-]+$/.test(entry.command as string)))
    )
      fail('mcp_absolute_command_required');
    if (
      entry.cwd !== undefined &&
      (!text(entry.cwd, options.sourceDocument ? 8192 : 4096) ||
        (!isAbsolute(entry.cwd as string) &&
          !(options.allowLaunchNames && /^~(?:[\\/]|$)/.test(entry.cwd as string))))
    )
      fail('mcp_working_directory_invalid');
    if (
      entry.args !== undefined &&
      (!Array.isArray(entry.args) ||
        entry.args.length > 128 ||
        entry.args.some((arg) => !text(arg)))
    )
      fail('mcp_arguments_invalid');
    map(
      entry.env,
      (key, value) =>
        mcpEnvironmentName.test(key) &&
        !mcpReservedEnvironment.test(key) &&
        !mcpSecretName.test(key) &&
        text(value),
      128,
    );
    if (
      entry.envPassthrough !== undefined &&
      (!Array.isArray(entry.envPassthrough) ||
        entry.envPassthrough.length > 128 ||
        entry.envPassthrough.some(
          (name) =>
            typeof name !== 'string' ||
            !mcpEnvironmentName.test(name) ||
            /^(?:__proto__|prototype|constructor)$/.test(name) ||
            mcpReservedEnvironment.test(name),
        ) ||
        new Set(entry.envPassthrough.map((name) => folded(String(name)))).size !==
          entry.envPassthrough.length)
    )
      fail('mcp_environment_invalid');
    const literalNames = Object.keys(entry.env ?? {}).map(folded);
    if (new Set(literalNames).size !== literalNames.length) fail('mcp_environment_duplicate');
    if (
      (entry.envPassthrough as string[] | undefined)?.some((name) =>
        literalNames.includes(folded(name)),
      )
    )
      fail('mcp_environment_duplicate');
  } else if (entry.type === 'http') {
    if (
      !text(entry.url) ||
      !entry.url ||
      (entry.url as string).includes('?') ||
      (entry.url as string).includes('#') ||
      Array.from(entry.url as string).some((char) => char.charCodeAt(0) <= 32)
    )
      fail('mcp_http_url_invalid');
    try {
      const url = new URL(entry.url as string);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        fail('mcp_http_url_invalid');
    } catch {
      fail('mcp_http_url_invalid');
    }
    if (
      entry.bearerTokenEnv !== undefined &&
      (typeof entry.bearerTokenEnv !== 'string' ||
        !mcpEnvironmentName.test(entry.bearerTokenEnv) ||
        /^(?:__proto__|prototype|constructor)$/.test(entry.bearerTokenEnv))
    )
      fail('mcp_environment_invalid');
    map(
      entry.headers,
      (key, value) =>
        mcpHeaderName.test(key) &&
        !mcpReservedHeader.test(key) &&
        !mcpSecretName.test(key) &&
        text(value),
      64,
    );
    map(
      entry.headersFromEnv,
      (key, value) =>
        mcpHeaderName.test(key) &&
        !mcpReservedHeader.test(key) &&
        typeof value === 'string' &&
        mcpEnvironmentName.test(value) &&
        !/^(?:__proto__|prototype|constructor)$/.test(value),
      64,
    );
    const names = [
      ...Object.keys(entry.headers ?? {}),
      ...Object.keys(entry.headersFromEnv ?? {}),
      ...(entry.bearerTokenEnv ? ['Authorization'] : []),
    ].map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length) fail('mcp_headers_duplicate');
  } else fail();
}
