import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  type FSWatcher,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch as watchFs,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';
import type { McpServerConfig } from '../mcp/types';
import {
  loadMcpConfigCatalog,
  type McpConfigCatalog,
  type McpConfigSourceKind,
  type McpServerConfigEntry,
  type McpWritableScope,
} from './mcp-config';
import { canonicalWorkspaceKey } from './mcp-project-approvals';
import { defaultConfigPath, localMcpConfigPath } from './paths';

export type McpServerConfigInput = Omit<McpServerConfig, 'providerVersion' | 'credentialKey'>;
export type McpConfigPatch = Partial<McpServerConfigInput>;

export type McpConfigCommand =
  | {
      type: 'add';
      scope: McpWritableScope;
      name: string;
      config: McpServerConfigInput;
      expectedRevision: string;
    }
  | {
      type: 'update';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
      patch: McpConfigPatch;
    }
  | {
      type: 'remove';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
    }
  | {
      type: 'set_enabled';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
      enabled: boolean;
    }
  | {
      type: 'migrate_legacy';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
      target: 'project';
    };

export type McpConfigMutationErrorCode =
  | 'config_conflict'
  | 'config_invalid'
  | 'not_found'
  | 'name_invalid'
  | 'scope_read_only'
  | 'write_failed';

export class McpConfigMutationError extends Error {
  readonly code: McpConfigMutationErrorCode;

  constructor(code: McpConfigMutationErrorCode, message: string) {
    super(message);
    this.name = 'McpConfigMutationError';
    this.code = code;
  }
}

export interface McpConfigRepository {
  load(workspace: string): Promise<McpConfigCatalog>;
  mutate(command: McpConfigCommand): Promise<McpConfigCatalog>;
  watch(workspace: string, listener: () => void): () => void;
}

export interface McpConfigRepositoryOptions {
  loadCatalog?: (options: { workspace: string }) => McpConfigCatalog;
  debounceMs?: number;
}

const RESERVED_SERVER_NAMES = new Set([
  'add',
  'enable',
  'disable',
  'remove',
  'approve',
  'reject',
  'retry',
  'reload',
]);

export function validateMcpServerName(name: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) ||
    name.includes('__') ||
    RESERVED_SERVER_NAMES.has(name.toLowerCase())
  ) {
    throw new McpConfigMutationError(
      'name_invalid',
      'Server name must be 1-64 letters, digits, dot, underscore, or dash; reserved MCP commands and double underscores are not allowed.',
    );
  }
}

export class DefaultMcpConfigRepository implements McpConfigRepository {
  private readonly loadCatalog: (options: { workspace: string }) => McpConfigCatalog;
  private readonly debounceMs: number;
  private workspace: string | undefined;

  constructor(options: McpConfigRepositoryOptions = {}) {
    this.loadCatalog = options.loadCatalog ?? loadMcpConfigCatalog;
    this.debounceMs = options.debounceMs ?? 120;
  }

  async load(workspace: string): Promise<McpConfigCatalog> {
    this.workspace = resolve(workspace);
    return this.loadCatalog({ workspace: this.workspace });
  }

  async mutate(command: McpConfigCommand): Promise<McpConfigCatalog> {
    const workspace = this.requireWorkspace();
    const catalog = this.loadCatalog({ workspace });

    switch (command.type) {
      case 'add': {
        validateMcpServerName(command.name);
        if (catalog.sourceRevisions[command.scope] !== command.expectedRevision) {
          conflict();
        }
        if (
          catalog.entries.some(
            (entry) => entry.name === command.name && entry.source.kind === command.scope,
          )
        ) {
          throw new McpConfigMutationError(
            'config_conflict',
            `MCP server '${command.name}' already exists in ${command.scope} scope.`,
          );
        }
        writeServer(sourcePath(workspace, command.scope), command.name, command.config);
        break;
      }
      case 'update': {
        const entry = requireEntry(catalog, command.key, command.expectedRevision);
        assertWritable(entry.source.kind);
        writeServer(entry.source.path, entry.name, { ...entry.rawConfig, ...command.patch });
        break;
      }
      case 'remove': {
        const entry = requireEntry(catalog, command.key, command.expectedRevision);
        assertWritable(entry.source.kind);
        removeServer(entry.source.path, entry.name);
        break;
      }
      case 'set_enabled': {
        const entry = requireEntry(catalog, command.key, command.expectedRevision);
        assertWritable(entry.source.kind);
        writeServer(entry.source.path, entry.name, {
          ...entry.rawConfig,
          enabled: command.enabled,
        });
        break;
      }
      case 'migrate_legacy': {
        const entry = requireEntry(catalog, command.key, command.expectedRevision);
        if (entry.source.kind !== 'project_legacy') {
          throw new McpConfigMutationError(
            'scope_read_only',
            'Only a project_legacy MCP server can be migrated.',
          );
        }
        const targetPath = sourcePath(workspace, command.target);
        if (
          catalog.entries.some(
            (candidate) =>
              candidate.name === entry.name && candidate.source.kind === command.target,
          )
        ) {
          throw new McpConfigMutationError(
            'config_conflict',
            `Project scope already contains MCP server '${entry.name}'.`,
          );
        }
        writeServer(targetPath, entry.name, entry.rawConfig);
        const reloaded = this.loadCatalog({ workspace });
        requireEntry(reloaded, command.key, command.expectedRevision);
        removeServer(entry.source.path, entry.name);
        break;
      }
    }

    return this.loadCatalog({ workspace });
  }

  watch(workspace: string, listener: () => void): () => void {
    const resolvedWorkspace = resolve(workspace);
    const paths = sourcePaths(resolvedWorkspace);
    const watchers = new Map<string, FSWatcher>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        rebind();
        listener();
      }, this.debounceMs);
    };
    const rebind = () => {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      const directories = paths.map((path) => nearestExistingDirectory(dirname(path)));
      for (const directory of new Set(directories)) {
        try {
          watchers.set(directory, watchFs(directory, schedule));
        } catch {
          // A later full repository load (including a TUI restart) remains the recovery path.
        }
      }
    };
    rebind();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    };
  }

  private requireWorkspace(): string {
    if (!this.workspace) {
      throw new McpConfigMutationError(
        'config_invalid',
        'MCP configuration repository has not loaded a workspace.',
      );
    }
    return this.workspace;
  }
}

function requireEntry(
  catalog: McpConfigCatalog,
  key: { name: string; source: McpConfigSourceKind },
  expectedRevision: string,
): McpServerConfigEntry {
  const entry = catalog.entries.find(
    (candidate) => candidate.name === key.name && candidate.source.kind === key.source,
  );
  if (!entry) throw new McpConfigMutationError('not_found', 'MCP server no longer exists.');
  if (entry.revision !== expectedRevision) conflict();
  return entry;
}

function assertWritable(source: McpConfigSourceKind): asserts source is McpWritableScope {
  if (source !== 'local' && source !== 'project' && source !== 'user') {
    throw new McpConfigMutationError(
      'scope_read_only',
      'This MCP source is read-only; migrate legacy project config before editing it.',
    );
  }
}

function conflict(): never {
  throw new McpConfigMutationError(
    'config_conflict',
    'MCP configuration changed outside Kite Code; reload and review the latest version.',
  );
}

function sourcePath(workspace: string, scope: McpWritableScope): string {
  if (scope === 'user') return defaultConfigPath();
  if (scope === 'project') return resolve(workspace, '.mcp.json');
  return localMcpConfigPath(canonicalWorkspaceKey(workspace));
}

function sourcePaths(workspace: string): string[] {
  let localPath: string | undefined;
  try {
    localPath = sourcePath(workspace, 'local');
  } catch {
    // The catalog will report the unavailable workspace identity.
  }
  return [
    defaultConfigPath(),
    resolve(workspace, '.mcp.json'),
    resolve(workspace, '.kite-code', 'kite-code.jsonc'),
    ...(localPath ? [localPath] : []),
  ];
}

function nearestExistingDirectory(directory: string): string {
  let current = directory;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function readJsoncObject(path: string): string {
  if (!existsSync(path)) return '{}\n';
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new McpConfigMutationError('config_invalid', 'MCP configuration is unreadable.');
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as unknown;
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigMutationError(
      'config_invalid',
      'MCP configuration is malformed and was not overwritten.',
    );
  }
  return text;
}

function writeServer(
  path: string,
  name: string,
  config: Readonly<Record<string, unknown>> | McpServerConfigInput,
): void {
  const text = readJsoncObject(path);
  const edits = modify(text, ['mcpServers', name], stripInternalFields(config), {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWrite(path, applyEdits(text, edits));
}

function removeServer(path: string, name: string): void {
  const text = readJsoncObject(path);
  const edits = modify(text, ['mcpServers', name], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWrite(path, applyEdits(text, edits));
}

function stripInternalFields(
  config: Readonly<Record<string, unknown>> | McpServerConfigInput,
): Record<string, unknown> {
  const output = { ...config } as Record<string, unknown>;
  delete output.providerVersion;
  return output;
}

function atomicWrite(path: string, text: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : defaultMode(path);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', existingMode);
    writeFileSync(fd, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, existingMode);
    syncDirectory(directory);
  } catch (error) {
    throw new McpConfigMutationError(
      'write_failed',
      error instanceof Error ? error.message : 'MCP configuration could not be written.',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function defaultMode(path: string): number {
  return path.endsWith('.mcp.json') ? 0o644 : 0o600;
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
    // Some platforms do not allow fsync on directories; file fsync + rename still applies.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
