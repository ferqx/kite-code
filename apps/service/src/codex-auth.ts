import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { ReasoningEffort } from '@kite-ai/ai/sdk';
import { parseModelPreset } from './model-options';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const authClaim = 'https://api.openai.com/auth';
const authLimit = 128 * 1024;
const cacheLimit = 2 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

/** One bounded regular-file descriptor; never follows a final symlink or blocks on a FIFO. */
function localText(path: string, maxBytes: number): string {
  let descriptor: number | undefined;
  let result: string | undefined;
  let failure: AgentError | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes))
      throw new AgentError('codex_auth_invalid');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new AgentError('codex_auth_unavailable');
    try {
      result = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new AgentError('codex_auth_invalid');
    }
  } catch (error) {
    if (error instanceof AgentError) failure = error;
    else {
      const code = object(error) ? error.code : undefined;
      failure = new AgentError(
        code === 'ENOENT' ? 'codex_auth_required' : 'codex_auth_unavailable',
      );
    }
  }
  if (descriptor !== undefined)
    try {
      closeSync(descriptor);
    } catch {
      failure = new AgentError('codex_auth_unavailable');
    }
  if (failure) throw failure;
  return result!;
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError('codex_auth_invalid');
  }
}
function jwt(token: unknown): ObjectValue {
  if (typeof token !== 'string') throw new AgentError('codex_auth_invalid');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    throw new AgentError('codex_auth_invalid');
  let payload: unknown;
  try {
    payload = json(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1]!, 'base64url')),
    );
  } catch {
    throw new AgentError('codex_auth_invalid');
  }
  if (!object(payload)) throw new AgentError('codex_auth_invalid');
  return payload;
}
function account(payload: ObjectValue): string | undefined {
  const claim = payload[authClaim];
  return object(claim) && text(claim.chatgpt_account_id) ? claim.chatgpt_account_id : undefined;
}
type LocalAuth = {
  alias: string;
  identityDigest: string;
  accessToken: string;
  accountId: string;
  expiresAt: number;
};
function readAuth(path: string): LocalAuth {
  const value = json(localText(path, authLimit));
  if (!object(value)) throw new AgentError('codex_auth_invalid');
  if (value.auth_mode !== undefined && value.auth_mode !== 'chatgpt')
    throw new AgentError('codex_auth_required');
  // Older Codex auth files omit auth_mode; a key-only login is never ChatGPT auth.
  if (!object(value.tokens)) throw new AgentError('codex_auth_required');
  if (value.auth_mode === undefined && value.OPENAI_API_KEY != null)
    throw new AgentError('codex_auth_required');
  const tokens = value.tokens;
  const access = jwt(tokens.access_token);
  const identity = tokens.id_token === undefined ? undefined : jwt(tokens.id_token);
  const claimedAccount = account(access);
  const accountId = tokens.account_id ?? claimedAccount ?? (identity && account(identity));
  const subject = access.sub ?? identity?.sub;
  if (
    !text(accountId) ||
    !/^[!-~]+$/.test(accountId) ||
    !text(claimedAccount) ||
    !text(subject) ||
    access.iss !== 'https://auth.openai.com' ||
    typeof access.exp !== 'number' ||
    !Number.isSafeInteger(access.exp) ||
    access.exp <= 0 ||
    (claimedAccount !== undefined && claimedAccount !== accountId) ||
    (identity && account(identity) !== undefined && account(identity) !== accountId) ||
    (identity?.sub !== undefined && identity.sub !== subject)
  )
    throw new AgentError('codex_auth_invalid');
  for (const rawScope of [access.scope, access.scp]) {
    const scopes =
      typeof rawScope === 'string'
        ? rawScope.split(/\s+/)
        : Array.isArray(rawScope)
          ? rawScope
          : [];
    if (scopes.includes('chatgpt.tokens.use.direct')) throw new AgentError('codex_auth_invalid');
  }
  const identityDigest = createHash('sha256')
    .update(JSON.stringify(['codex-account-v1', accountId, subject]))
    .digest('hex');
  return {
    alias: `codex-${identityDigest.slice(0, 32)}`,
    identityDigest,
    accessToken: tokens.access_token as string,
    accountId,
    expiresAt: access.exp,
  };
}
export type CodexLocalDiscovery = {
  alias: string;
  name: string;
  models: Array<{ name: string; contextWindowTokens?: number }>;
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
};
function modelName(value: unknown): value is string {
  return text(value) && value === value.trim() && value.length <= 256;
}
function requestBody(value: unknown): string {
  if (!object(value) || !modelName(value.model) || !Array.isArray(value.input))
    throw new AgentError('codex_request_invalid');
  // Do not silently drop an explicitly frozen output-token limit unsupported by Codex.
  if (Object.hasOwn(value, 'max_output_tokens'))
    throw new AgentError('codex_model_options_unsupported');
  const instructions: string[] = [];
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== 'string') throw new AgentError('codex_request_invalid');
    instructions.push(value.instructions);
  }
  const input: unknown[] = [];
  for (const item of value.input) {
    if (object(item) && (item.role === 'system' || item.role === 'developer')) {
      if (typeof item.content === 'string') instructions.push(item.content);
      else if (
        Array.isArray(item.content) &&
        item.content.every(
          (part) =>
            object(part) &&
            ['input_text', 'text'].includes(String(part.type)) &&
            typeof part.text === 'string',
        )
      )
        instructions.push(...item.content.map((part) => (part as { text: string }).text));
      else throw new AgentError('codex_request_invalid');
    } else input.push(item);
  }
  const body: ObjectValue = {
    ...value,
    input,
    instructions: instructions.join('\n\n') || 'You are a helpful assistant.',
    store: false,
    stream: true,
  };
  return JSON.stringify(body);
}

function defaultCodexHome(home: string): string {
  if (isAbsolute(home) && !home.includes('\0'))
    try {
      const physical = realpathSync.native(home);
      if (lstatSync(physical).isDirectory()) return join(physical, '.codex');
    } catch {
      // An unavailable HOME retains the original finite discovery/binding failure.
    }
  return join(home, '.codex');
}

/** Read-only adoption of the local Codex login. Codex continues to own login and refresh. */
export function createCodexLocalSource(
  options: { home?: string; codexHome?: string; fetch?: typeof fetch } = {},
) {
  const base =
    options.codexHome ?? process.env.CODEX_HOME ?? defaultCodexHome(options.home ?? homedir());
  const authPath = join(base, 'auth.json');
  const validHome = isAbsolute(base) && !base.includes('\0') && authPath.length <= 8192;
  const read = () => {
    if (!validHome) throw new AgentError('codex_auth_unavailable');
    return readAuth(authPath);
  };
  const transportFetch = options.fetch ?? globalThis.fetch;
  return {
    get authPath() {
      return authPath;
    },
    /** Invalid sources can never bind. Valid absent credentials must stay protected. */
    get protectedAuthPath() {
      return validHome ? authPath : undefined;
    },
    discover(): CodexLocalDiscovery | undefined {
      let auth: LocalAuth;
      try {
        auth = read();
      } catch {
        return;
      }
      const models: CodexLocalDiscovery['models'] = [];
      try {
        const cache = json(localText(join(base, 'models_cache.json'), cacheLimit));
        if (
          object(cache) &&
          Array.isArray(cache.models) &&
          (cache.account_id === undefined || cache.account_id === auth.accountId)
        )
          for (const entry of cache.models) {
            if (
              !object(entry) ||
              entry.visibility !== 'list' ||
              !modelName(entry.slug) ||
              models.some((model) => model.name === entry.slug)
            )
              continue;
            models.push({
              name: entry.slug,
              ...(typeof entry.context_window === 'number' &&
              Number.isSafeInteger(entry.context_window) &&
              entry.context_window > 0
                ? { contextWindowTokens: entry.context_window }
                : {}),
            });
          }
      } catch {
        // A missing or invalid cache never hides an explicit local model selection.
      }
      let preferred: string | undefined;
      let reasoningEffort: ReasoningEffort | undefined;
      try {
        const config: unknown = Bun.TOML.parse(localText(join(base, 'config.toml'), authLimit));
        if (
          object(config) &&
          (config.model_provider === undefined ||
            config.model_provider === 'openai' ||
            models.some((model) => model.name === config.model))
        ) {
          if (modelName(config.model)) {
            preferred = config.model;
            if (!models.some((model) => model.name === preferred)) models.push({ name: preferred });
          }
          if (typeof config.model_reasoning_effort === 'string') {
            try {
              reasoningEffort = parseModelPreset({
                reasoningEffort: config.model_reasoning_effort,
              }).reasoningEffort;
            } catch {
              // Invalid optional preferences never become an inferred model setting.
            }
          }
        }
      } catch {
        // Discovery uses only available local metadata; it never guesses a model ID.
      }
      return {
        alias: auth.alias,
        name: 'ChatGPT / Codex（本机）',
        models,
        ...((preferred ?? models[0]?.name) ? { defaultModel: preferred ?? models[0]!.name } : {}),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
    },
    async binding(alias: string): Promise<{
      apiKey: string;
      headers: Record<string, string>;
      fetch: typeof fetch;
      continuationIdentity: { kind: 'codex-local-auth'; value: string };
    }> {
      const current = () => {
        const auth = read();
        if (auth.alias !== alias) throw new AgentError('codex_auth_required');
        if (auth.expiresAt <= Math.floor(Date.now() / 1000))
          throw new AgentError('codex_auth_expired');
        return auth;
      };
      const original = current();
      const boundFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : undefined;
          let url: URL;
          try {
            url = new URL(request ? request.url : String(input));
          } catch {
            throw new AgentError('codex_request_invalid');
          }
          const method = init?.method ?? request?.method ?? 'GET';
          if (url.href !== `${CODEX_BASE_URL}/responses` || method.toUpperCase() !== 'POST')
            throw new AgentError('codex_request_invalid');
          const signal = init?.signal ?? request?.signal;
          signal?.throwIfAborted();
          const raw = init?.body ?? (request ? await request.clone().text() : undefined);
          if (typeof raw !== 'string') throw new AgentError('codex_request_invalid');
          let body: string;
          try {
            body = requestBody(JSON.parse(raw));
          } catch (error) {
            if (error instanceof AgentError) throw error;
            throw new AgentError('codex_request_invalid');
          }
          const auth = current();
          const headers = new Headers(init?.headers ?? request?.headers);
          headers.set('authorization', `Bearer ${auth.accessToken}`);
          headers.set('chatgpt-account-id', auth.accountId);
          headers.set('originator', 'kite-code');
          headers.set('openai-beta', 'responses=experimental');
          headers.set('accept', 'text/event-stream');
          headers.set('content-type', 'application/json');
          headers.delete('content-length');
          signal?.throwIfAborted();
          let response: Response;
          try {
            response = await transportFetch(url, {
              ...init,
              method: 'POST',
              headers,
              body,
              signal,
              credentials: 'omit',
              redirect: 'manual',
            });
          } catch {
            signal?.throwIfAborted();
            throw new AgentError('codex_transport_failed');
          }
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => {});
            throw new AgentError('codex_transport_failed');
          }
          return response;
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      return {
        apiKey: original.accessToken,
        headers: { 'chatgpt-account-id': original.accountId },
        fetch: boundFetch,
        continuationIdentity: {
          kind: 'codex-local-auth',
          value: createHash('sha256')
            .update(JSON.stringify(['codex-local-auth-v1', authPath, original.identityDigest]))
            .digest('hex'),
        },
      };
    },
  };
}
