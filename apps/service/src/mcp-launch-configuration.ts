import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { JsonObject } from '@kite-ai/agent/config';
import { type McpSourceEntry, validateMcpSourceEntry } from '@kite-ai/agent/config';

export type McpEnvironmentReader = (name: string) => string | undefined;
export const readMcpHostEnvironment: McpEnvironmentReader = (name) => {
  const value = process.env[name];
  return typeof value === 'string' ? value : undefined;
};
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const expandHome = (path: string) =>
  /^~(?:[\\/]|$)/.test(path) ? resolve(homedir(), path.slice(2)) : path;
function absoluteSearchPath(value: string) {
  return value
    .split(delimiter)
    .map((path) => path.replace(/^"(.*)"$/, '$1'))
    .filter(isAbsolute);
}
function findProgram(name: string, environment: McpEnvironmentReader) {
  const candidates =
    process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(name)
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];
  for (const directory of absoluteSearchPath(environment('PATH') ?? ''))
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      try {
        if (
          statSync(path).isFile() &&
          (process.platform === 'win32' || (statSync(path).mode & 0o111) !== 0)
        )
          return path;
      } catch {
        /* Continue only through explicitly listed absolute PATH directories. */
      }
    }
  return null;
}

/** Resolve a user-selected launcher once when saving; never invoke a shell or install packages. */
export function resolveMcpLaunchEntry(
  input: McpSourceEntry,
  environment: McpEnvironmentReader = readMcpHostEnvironment,
): McpSourceEntry {
  validateMcpSourceEntry(input, { allowLaunchNames: true });
  if (input.type === 'http') return structuredClone(input);
  let command = input.command,
    args = [...(input.args ?? [])];
  if (!isAbsolute(command)) {
    const found = findProgram(command, environment);
    if (!found) fail('mcp_command_not_found');
    command = found;
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const name = input.command
      .replace(/^.*[\\/]/, '')
      .replace(/\.(?:cmd|bat)$/i, '')
      .toLowerCase();
    if (!['npx', 'npm'].includes(name)) fail('mcp_command_launcher_unsupported');
    const root = dirname(command),
      cli = join(root, 'node_modules', 'npm', 'bin', `${name}-cli.js`);
    const node = [join(root, 'node.exe'), findProgram('node.exe', environment)].find(
      (path) => path && existsSync(path),
    );
    if (!node || !existsSync(cli)) fail('mcp_command_not_found');
    command = node;
    args = [realpathSync.native(cli), ...args];
  }
  if (!existsSync(command) || !statSync(command).isFile()) fail('mcp_command_not_found');
  if (process.platform === 'win32' && !/\.exe$/i.test(command))
    fail('mcp_command_launcher_unsupported');
  const cwd = input.cwd ? expandHome(input.cwd) : undefined;
  if (cwd && (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()))
    fail('mcp_working_directory_invalid');
  const result: McpSourceEntry = {
    ...structuredClone(input),
    command: realpathSync.native(command),
    ...(args.length ? { args } : {}),
    ...(cwd ? { cwd: realpathSync.native(cwd) } : {}),
  };
  validateMcpSourceEntry(result);
  return result;
}

const systemNames =
  process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR'];
export function mcpStdioEnvironment(
  transport: JsonObject,
  read: McpEnvironmentReader = readMcpHostEnvironment,
) {
  const explicit = (transport.envPassthrough ?? []) as string[];
  const folded = (name: string) => (process.platform === 'win32' ? name.toUpperCase() : name);
  const literal = Object.keys(transport.env ?? {}).map(folded);
  const selected = new Map([...systemNames, ...explicit].map((name) => [folded(name), name]));
  const names = [...selected.values()].filter((name) => !literal.includes(folded(name)));
  if (names.length + literal.length > 128) fail('mcp_environment_invalid');
  return {
    names,
    resolve() {
      const env: Record<string, string> = {};
      for (const name of names) {
        const value = read(name);
        if (value === undefined) {
          if (explicit.some((required) => folded(required) === folded(name)))
            fail('mcp_environment_variable_missing');
          else continue;
        }
        if (value.length > 8192 || value.includes('\0')) fail('mcp_environment_variable_invalid');
        env[name] =
          folded(name) === folded('PATH') &&
          !explicit.some((required) => folded(required) === folded(name))
            ? absoluteSearchPath(value).join(delimiter)
            : value;
      }
      // npx and /usr/bin/env must find the explicitly selected Node runtime too.
      const pathName = names.find((name) => folded(name) === folded('PATH'));
      if (pathName && typeof transport.command === 'string')
        env[pathName] = [dirname(transport.command), env[pathName] ?? '']
          .filter(Boolean)
          .join(delimiter);
      return env;
    },
  };
}

export function mcpHttpHeaders(
  transport: JsonObject,
  read: McpEnvironmentReader = readMcpHostEnvironment,
) {
  return {
    headers: (transport.headers ?? {}) as Record<string, string>,
    resolveHeaders() {
      const headers: Record<string, string> = {};
      const required = (name: string) => {
        const value = read(name);
        if (typeof value !== 'string' || !value) fail('mcp_environment_variable_missing');
        if (
          value.length > 8192 ||
          Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        )
          fail('mcp_environment_variable_invalid');
        return value;
      };
      for (const [name, variable] of Object.entries(transport.headersFromEnv ?? {}))
        headers[name] = required(variable as string);
      if (typeof transport.bearerTokenEnv === 'string')
        headers.Authorization = `Bearer ${required(transport.bearerTokenEnv)}`;
      return headers;
    },
  };
}
