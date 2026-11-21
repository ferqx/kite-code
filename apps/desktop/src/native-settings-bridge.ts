import type { DesktopEditor } from './file-changes-bridge';
import type { NativeUserMcpSubmission } from './mcp-bridge';
import type {
  NativeModelSettingsSubmission,
  NativeProviderSubmission,
  NativeReply,
  NativeRequest,
  NativeResult,
  NativeSettingsSelection,
  NativeThemePreference,
} from './native-bridge';

export const nativeSettingsPresentChannel = 'kite:native:settings-present';
export const nativeSettingsCloseChannel = 'kite:native:settings-close';
export const nativeSettingsActionChannel = 'kite:native:settings-action';
export const nativeSettingsReplyChannel = 'kite:native:settings-reply';
export const nativeSettingsStateChannel = 'kite:native:settings-state';
export const nativeSettingsOverlayEventChannel = 'kite:native:settings-event';
export const nativeSettingsOverlayRequestChannel = 'kite:native:settings-request';
export const nativeSettingsActiveChannel = 'kite:native:settings-active';

export type { NativeSettingsSelection } from './native-bridge';

export type NativeSettingsState = {
  readonly instanceId: string;
  readonly generation: number;
  readonly storeId?: string;
  readonly selection?: NativeSettingsSelection;
  readonly webSearchSessionId?: string;
  readonly canReadWebSearch: boolean;
  readonly windowsShell: boolean;
  readonly editor: DesktopEditor;
  readonly appearance: NativeThemePreference;
  readonly theme: 'light' | 'dark';
  readonly userMcpSubmissions?: readonly NativeUserMcpSubmission[];
  readonly providerSubmissions?: readonly NativeProviderSubmission[];
  readonly modelSubmissions?: readonly NativeModelSettingsSubmission[];
};

export type NativeSettingsIntent =
  | { type: 'close' | 'saved' }
  | { type: 'editor'; editor: DesktopEditor }
  | { type: 'theme'; theme: NativeThemePreference };
export type NativeSettingsAction = { instanceId: string } & (
  | NativeSettingsIntent
  | { type: 'unavailable' | 'retired' }
  | { type: 'request'; requestId: string; request: NativeRequest }
);

export interface NativeSettingsBridge {
  present(state: NativeSettingsState, opening: boolean): void;
  close(instanceId: string): void;
  watchActions(listener: (action: NativeSettingsAction) => void): () => void;
  reply(instanceId: string, requestId: string, result: NativeReply): void;
}
export interface NativeSettingsOverlayBridge {
  watch(listener: (state: NativeSettingsState | null) => void): () => void;
  ready(): void;
  request(instanceId: string, request: NativeRequest): Promise<NativeResult>;
  action(instanceId: string, intent: NativeSettingsIntent): void;
}

declare global {
  interface Window {
    kiteNativeSettings?: NativeSettingsBridge;
    kiteSettingsOverlay?: NativeSettingsOverlayBridge;
  }
}

const methodNames = [
  'state',
  'settings.general.shell.read',
  'settings.general.shell.save',
  'settings.providers.read',
  'settings.providers.close',
  'settings.providers.remove.confirm',
  'settings.providers.discover',
  'settings.providers.discover.cancel',
  'settings.providers.save',
  'settings.providers.lookup',
  'settings.models.read',
  'settings.models.close',
  'settings.models.enabled',
  'settings.models.default',
  'settings.models.lookup',
  'settings.userMcp.read',
  'settings.userMcp.close',
  'settings.userMcp.submit',
  'settings.userMcp.lookup',
  'settings.userMcp.cancel',
  'settings.userMcp.clear',
  'settings.userMcp.tools',
  'settings.skills.open',
  'settings.skills.next',
  'settings.skills.close',
  'settings.skills.document',
  'settings.skills.document.close',
  'settings.skills.search',
  'settings.skills.install',
  'settings.skills.uninstall',
  'webSearch.settings.read',
  'webSearch.settings.save',
  'webSearch.settings.test',
  'trace.manage',
] as const;
export type NativeSettingsRequest = NativeRequest & { readonly generation: number };
const methods: ReadonlySet<string> = new Set(methodNames);
const releaseMethods: ReadonlySet<string> = new Set([
  'settings.providers.close',
  'settings.providers.discover.cancel',
  'settings.models.close',
  'settings.userMcp.close',
  'settings.skills.close',
  'settings.skills.document.close',
]);
const resultKinds: ReadonlySet<string> = new Set([
  'settings.general.shell',
  'settings.providers',
  'settings.providers.remove.confirmed',
  'settings.providers.directory',
  'settings.providers.submission',
  'settings.models',
  'settings.models.submission',
  'settings.userMcp',
  'settings.userMcp.submission',
  'settings.userMcp.tools',
  'settings.skills.page',
  'settings.skills.document',
  'settings.skills.search',
  'settings.skills.install',
  'settings.skills.uninstall',
  'webSearch.settings',
  'webSearch.test',
  'trace.delivery',
  'trace.installations',
  'trace.installation',
  'trace.installed',
  'trace.validated',
  'trace.history',
  'trace.partition',
  'trace.deadLetters',
  'trace.credential',
  'trace.action',
]);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Reflect.ownKeys(v).every(
    (key) =>
      typeof key === 'string' &&
      allowed.includes(key) &&
      'value' in Object.getOwnPropertyDescriptor(v, key)!,
  );
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const editor = (v: unknown) => v === 'vscode' || v === 'zed' || v === 'textedit';
const theme = (v: unknown) => v === 'dark' || v === 'light' || v === 'system';
export const nativeSettingsId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9-]{1,128}$/u.test(v);

/** Reject extra object capabilities/getters and bound aggregate payload before relaying. */
function data(value: unknown, limit: number) {
  let remaining = limit;
  const check = (v: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 20) return false;
    if (v === null || v === undefined || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') {
      remaining -= v.length;
      return remaining >= 0;
    }
    if (Array.isArray(v)) return v.length <= 16_384 && v.every((x) => check(x, depth + 1));
    if (!record(v)) return false;
    const own = Reflect.ownKeys(v);
    return (
      own.length <= 256 &&
      own.every((key) => {
        if (
          typeof key !== 'string' ||
          key === '__proto__' ||
          key === 'constructor' ||
          key.length > 256
        )
          return false;
        const prop = Object.getOwnPropertyDescriptor(v, key);
        remaining -= key.length;
        return !!prop && 'value' in prop && check(prop.value, depth + 1);
      })
    );
  };
  return check(value, 0);
}
const selection = (v: unknown) =>
  record(v) &&
  keys(v, ['storeId', 'session', 'viewSelection']) &&
  text(v.storeId) &&
  record(v.session) &&
  keys(v.session, ['id']) &&
  text(v.session.id) &&
  (v.viewSelection === undefined || count(v.viewSelection));
const submissions = (v: unknown, storeId: unknown, kind: string) =>
  v === undefined ||
  (Array.isArray(v) &&
    v.length <= 512 &&
    v.every(
      (entry) =>
        record(entry) && entry.kind === kind && entry.storeId === storeId && text(entry.commandId),
    ));

/**
 * Existing MCP journals may retain the arguments and inline headers of the original add.
 * The settings UI uses only kind/name for pending add facts. Do not copy those original
 * configuration bytes to the narrowly scoped overlay. This is display data, never replayed.
 */
function mcpDisplaySubmission(row: NativeUserMcpSubmission): NativeUserMcpSubmission {
  const { operation } = row;
  if (operation.kind !== 'add') return row;
  return {
    ...row,
    operation: {
      kind: 'add',
      name: operation.name,
      entry:
        operation.entry.type === 'http'
          ? { type: 'http', url: '' }
          : { type: 'stdio', command: '' },
    },
  };
}
function isMcpDisplaySubmission(value: unknown) {
  if (!record(value) || !record(value.operation)) return false;
  const { operation } = value;
  if (operation.kind !== 'add') return true;
  if (!keys(operation, ['kind', 'name', 'entry']) || !record(operation.entry)) return false;
  return operation.entry.type === 'http'
    ? keys(operation.entry, ['type', 'url']) && operation.entry.url === ''
    : operation.entry.type === 'stdio' &&
        keys(operation.entry, ['type', 'command']) &&
        operation.entry.command === '';
}
export function projectNativeSettingsState(state: NativeSettingsState): NativeSettingsState {
  return {
    ...state,
    userMcpSubmissions: state.userMcpSubmissions
      ?.filter((row) => row.storeId === state.storeId)
      .slice(-512)
      .map(mcpDisplaySubmission),
    providerSubmissions: state.providerSubmissions
      ?.filter((row) => row.storeId === state.storeId)
      .slice(-512),
    modelSubmissions: state.modelSubmissions
      ?.filter((row) => row.storeId === state.storeId)
      .slice(-512),
  };
}
export function projectNativeSettingsReply(reply: NativeReply): NativeReply {
  const value = reply.ok && reply.value;
  if (value && 'kind' in value && value.kind === 'settings.userMcp.submission') {
    if (!('operation' in value) || !('association' in value))
      return { ok: false, code: 'invalid_native_settings_reply' };
    return { ok: true, value: mcpDisplaySubmission(value as NativeUserMcpSubmission) };
  }
  return reply;
}

export function isNativeSettingsState(v: unknown): v is NativeSettingsState {
  return (
    record(v) &&
    keys(v, [
      'instanceId',
      'generation',
      'storeId',
      'selection',
      'webSearchSessionId',
      'canReadWebSearch',
      'windowsShell',
      'editor',
      'appearance',
      'theme',
      'userMcpSubmissions',
      'providerSubmissions',
      'modelSubmissions',
    ]) &&
    data(v, 1_048_576) &&
    nativeSettingsId(v.instanceId) &&
    count(v.generation) &&
    (v.storeId === undefined || text(v.storeId)) &&
    (v.selection === undefined ||
      (selection(v.selection) && (v.selection as NativeSettingsSelection).storeId === v.storeId)) &&
    (v.webSearchSessionId === undefined ||
      (text(v.webSearchSessionId) &&
        (v.selection as NativeSettingsSelection | undefined)?.session.id ===
          v.webSearchSessionId)) &&
    typeof v.canReadWebSearch === 'boolean' &&
    typeof v.windowsShell === 'boolean' &&
    editor(v.editor) &&
    theme(v.appearance) &&
    (v.theme === 'light' || v.theme === 'dark') &&
    submissions(v.userMcpSubmissions, v.storeId, 'settings.userMcp.submission') &&
    (!Array.isArray(v.userMcpSubmissions) || v.userMcpSubmissions.every(isMcpDisplaySubmission)) &&
    submissions(v.providerSubmissions, v.storeId, 'settings.providers.submission') &&
    submissions(v.modelSubmissions, v.storeId, 'settings.models.submission')
  );
}

export function isNativeSettingsRequest(value: unknown): value is NativeSettingsRequest {
  return (
    record(value) &&
    data(value, 262_144) &&
    text(value.method) &&
    methods.has(value.method) &&
    count(value.generation) &&
    (value.method !== 'state' || keys(value, ['method', 'generation']))
  );
}
export const isNativeSettingsRelease = (request: NativeRequest) =>
  releaseMethods.has(request.method);
export function isNativeSettingsIntent(v: unknown): v is NativeSettingsIntent {
  return (
    record(v) &&
    ((keys(v, ['type']) && (v.type === 'close' || v.type === 'saved')) ||
      (keys(v, ['type', 'editor']) && v.type === 'editor' && editor(v.editor)) ||
      (keys(v, ['type', 'theme']) && v.type === 'theme' && theme(v.theme)))
  );
}
export function isNativeSettingsAction(v: unknown): v is NativeSettingsAction {
  if (!record(v) || !data(v, 262_400) || !nativeSettingsId(v.instanceId)) return false;
  const { instanceId: _, ...body } = v;
  return (
    isNativeSettingsIntent(body) ||
    (keys(body, ['type']) && (body.type === 'retired' || body.type === 'unavailable')) ||
    (keys(body, ['type', 'requestId', 'request']) &&
      body.type === 'request' &&
      nativeSettingsId(body.requestId) &&
      isNativeSettingsRequest(body.request))
  );
}

const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
function recovery(v: Record<string, unknown>) {
  if (
    !keys(v, [
      'generation',
      'directory',
      'selection',
      'providerSettingsSubmissions',
      'modelSettingsSubmissions',
      'creationSubmissions',
      'inputSubmissions',
      'permissionSubmissions',
      'interactionSubmissions',
    ])
  )
    return false;
  const dir = v.directory;
  const sel = v.selection;
  const store = record(dir) ? dir.storeId : record(sel) ? sel.storeId : undefined;
  return (
    count(v.generation) &&
    empty(v.creationSubmissions) &&
    empty(v.inputSubmissions) &&
    empty(v.permissionSubmissions) &&
    empty(v.interactionSubmissions) &&
    (dir === undefined ||
      (record(dir) &&
        keys(dir, ['storeId', 'workspaces', 'sessions']) &&
        text(dir.storeId) &&
        empty(dir.workspaces) &&
        empty(dir.sessions))) &&
    (sel === undefined ||
      (record(sel) && keys(sel, ['storeId']) && text(sel.storeId) && sel.storeId === store)) &&
    submissions(v.providerSettingsSubmissions, store, 'settings.providers.submission') &&
    submissions(v.modelSettingsSubmissions, store, 'settings.models.submission')
  );
}

export function isNativeSettingsReply(v: unknown): v is NativeReply {
  if (!record(v) || !data(v, 4_194_304)) return false;
  if (v.ok === false)
    return (
      keys(v, ['ok', 'code']) &&
      typeof v.code === 'string' &&
      /^[a-z][a-z0-9_]{0,100}$/u.test(v.code)
    );
  if (v.ok !== true || !keys(v, ['ok', 'value'])) return false;
  if (v.value === null) return true;
  if (!record(v.value)) return false;
  return typeof v.value.kind === 'string'
    ? resultKinds.has(v.value.kind) &&
        (v.value.kind !== 'settings.userMcp.submission' || isMcpDisplaySubmission(v.value))
    : recovery(v.value);
}
