import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { CODEX_BASE_URL, createCodexLocalSource } from '../../src/codex-auth';
import { encodeFrames, responseFrames } from '../fixtures/responses-wire';

const claim = 'https://api.openai.com/auth';
const jwt = (payload: Record<string, unknown>, signature = 'fixture') =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.from(signature).toString('base64url')}`;
function auth(account = 'account-one', subject = 'subject-one', expires = 4_102_444_800) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({
        sub: subject,
        exp: expires,
        iss: 'https://auth.openai.com',
        [claim]: { chatgpt_account_id: account },
      }),
      id_token: jwt({ sub: subject, [claim]: { chatgpt_account_id: account } }),
      account_id: account,
      refresh_token: 'refresh-owned-by-codex',
    },
  };
}
function fixture(transport?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'kite-codex-auth-'));
  const codexHome = join(root, '.codex');
  mkdirSync(codexHome, { mode: 0o700 });
  const authPath = join(codexHome, 'auth.json');
  const setAuth = (value: unknown) =>
    writeFileSync(authPath, JSON.stringify(value), { mode: 0o600 });
  const cache = (models: unknown[], extra: Record<string, unknown> = {}) =>
    writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models, ...extra }));
  const config = (value: string) => writeFileSync(join(codexHome, 'config.toml'), value);
  return {
    root,
    codexHome,
    authPath,
    setAuth,
    cache,
    config,
    source: createCodexLocalSource({ codexHome, ...(transport ? { fetch: transport } : {}) }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const fakeFetch = (
  body: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
) => Object.assign(body, { preconnect: fetch.preconnect });
const post = (binding: Awaited<ReturnType<ReturnType<typeof createCodexLocalSource>['binding']>>) =>
  binding.fetch(`${CODEX_BASE_URL}/responses`, {
    method: 'POST',
    body: JSON.stringify({ model: 'local-codex-model', input: [] }),
  });

test('local discovery uses only listed cache models and explicit root model, without exposing auth', async () => {
  const f = fixture();
  try {
    const credentials = auth();
    f.setAuth(credentials);
    const original = readFileSync(f.authPath);
    f.cache([
      { slug: 'hidden', visibility: 'hidden' },
      { slug: 'listed', visibility: 'list', context_window: 262144 },
      { slug: 'listed', visibility: 'list' },
      { slug: 'invalid\nname', visibility: 'list' },
      { slug: 'other', visibility: 'list', context_window: -1 },
    ]);
    f.config('model = "explicit-model"\n[profiles.other]\nmodel = "other-profile"\n');
    const found = f.source.discover()!;
    expect(found).toEqual({
      alias: expect.stringMatching(/^codex-[a-f0-9]{32}$/),
      name: 'ChatGPT / Codex（本机）',
      models: [
        { name: 'listed', contextWindowTokens: 262144 },
        { name: 'other' },
        { name: 'explicit-model' },
      ],
      defaultModel: 'explicit-model',
    });
    for (const secret of [
      credentials.tokens.access_token,
      credentials.tokens.refresh_token,
      'account-one',
      'subject-one',
      f.root,
    ])
      expect(JSON.stringify(found)).not.toContain(secret);
    await f.source.binding(found.alias);
    expect(readFileSync(f.authPath)).toEqual(original);
    expect(f.source.authPath).toBe(f.authPath);
  } finally {
    f.close();
  }
});

test('a broken cache does not hide native config, and custom providers never invent Codex routes', () => {
  const f = fixture();
  try {
    f.setAuth(auth());
    writeFileSync(join(f.codexHome, 'models_cache.json'), '{broken');
    f.config('model = "configured"\n');
    expect(f.source.discover()).toMatchObject({
      models: [{ name: 'configured' }],
      defaultModel: 'configured',
    });
    f.config('model = "custom-only"\nmodel_provider = "local-proxy"\n');
    expect(f.source.discover()).toMatchObject({ models: [] });
    expect(f.source.discover()!.defaultModel).toBeUndefined();
    f.cache([{ slug: 'listed', visibility: 'list' }]);
    expect(f.source.discover()).toMatchObject({
      models: [{ name: 'listed' }],
      defaultModel: 'listed',
    });
    f.config('model = "listed"\nmodel_provider = "local-proxy"\n');
    expect(f.source.discover()!.defaultModel).toBe('listed');
    f.cache([{ slug: 'foreign', visibility: 'list' }], { account_id: 'another-account' });
    expect(f.source.discover()!.models).toEqual([]);
  } finally {
    f.close();
  }
});

test('local reasoning preference uses only the validated root Codex value without writing metadata', () => {
  const f = fixture();
  try {
    f.setAuth(auth());
    f.cache([{ slug: 'listed', visibility: 'list' }]);
    const config =
      'model = "listed"\nmodel_reasoning_effort = "high"\n[profiles.other]\nmodel_reasoning_effort = "low"\n';
    f.config(config);
    const original = readFileSync(f.authPath);
    expect(f.source.discover()).toMatchObject({ defaultModel: 'listed', reasoningEffort: 'high' });
    expect(readFileSync(join(f.codexHome, 'config.toml'), 'utf8')).toBe(config);
    expect(readFileSync(f.authPath)).toEqual(original);
    f.config('model_reasoning_effort = "low"\n');
    expect(f.source.discover()).toMatchObject({ defaultModel: 'listed', reasoningEffort: 'low' });
    for (const value of ['"unsupported"', '3', 'false']) {
      f.config(`model = "listed"\nmodel_reasoning_effort = ${value}\n`);
      expect(f.source.discover()!.defaultModel).toBe('listed');
      expect(f.source.discover()!.reasoningEffort).toBeUndefined();
    }
    f.config(
      'model = "custom-only"\nmodel_provider = "private-proxy"\nmodel_reasoning_effort = "high"\n',
    );
    expect(f.source.discover()!.reasoningEffort).toBeUndefined();
  } finally {
    f.close();
  }
});

test('auth absence, API-key login, and malformed credentials have finite local failures', async () => {
  const f = fixture();
  try {
    expect(f.source.discover()).toBeUndefined();
    await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_required');
    for (const value of [
      { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-key' },
      { OPENAI_API_KEY: 'fixture-api-key', tokens: auth().tokens },
    ]) {
      f.setAuth(value);
      expect(f.source.discover()).toBeUndefined();
      await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_required');
    }
    for (const value of [
      null,
      { auth_mode: 'chatgpt', tokens: {} },
      { auth_mode: 'chatgpt', tokens: { ...auth().tokens, access_token: 'fixture-invalid-token' } },
      { auth_mode: 'chatgpt', tokens: { ...auth().tokens, account_id: 'another-account' } },
      {
        auth_mode: 'chatgpt',
        tokens: {
          ...auth().tokens,
          access_token: jwt({ sub: 'subject-one', exp: 'not-a-number' }),
        },
      },
    ]) {
      f.setAuth(value);
      expect(f.source.discover()).toBeUndefined();
      await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
    }
    writeFileSync(f.authPath, '{fixture-broken');
    await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
    writeFileSync(f.authPath, Buffer.from([0xff, 0xfe]));
    await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
  } finally {
    f.close();
  }
});

test('legacy ChatGPT auth works and identity survives token rotation while separating account and subject', async () => {
  const f = fixture();
  try {
    const legacy: Record<string, unknown> = auth();
    delete legacy.auth_mode;
    f.setAuth(legacy);
    const alias = f.source.discover()!.alias;
    await expect(f.source.binding(alias)).resolves.toBeDefined();
    const rotated = auth();
    rotated.tokens.access_token = jwt({
      sub: 'subject-one',
      exp: 4_102_444_801,
      iss: 'https://auth.openai.com',
      [claim]: { chatgpt_account_id: 'account-one' },
    });
    f.setAuth(rotated);
    expect(f.source.discover()!.alias).toBe(alias);
    for (const value of [auth('account-two'), auth('account-one', 'subject-two')]) {
      f.setAuth(value);
      expect(f.source.discover()!.alias).not.toBe(alias);
      await expect(f.source.binding(alias)).rejects.toThrow('codex_auth_required');
    }
  } finally {
    f.close();
  }
});

test('private continuation identity survives source recreation and token replacement but isolates account, subject and source', async () => {
  const f = fixture();
  const other = fixture();
  try {
    const original = auth();
    f.setAuth(original);
    const alias = f.source.discover()!.alias;
    const identity = (await f.source.binding(alias)).continuationIdentity;
    expect(identity).toEqual({
      kind: 'codex-local-auth',
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const value of [f.authPath, 'account-one', 'subject-one', original.tokens.access_token])
      expect(JSON.stringify(identity)).not.toContain(value);

    const replacement = auth('account-one', 'subject-one', 4_102_444_801);
    const pending = join(f.codexHome, 'replacement-auth.json');
    writeFileSync(pending, JSON.stringify(replacement));
    renameSync(pending, f.authPath);
    const recreated = createCodexLocalSource({ codexHome: join(f.codexHome, '.') });
    expect((await recreated.binding(alias)).continuationIdentity).toEqual(identity);
    expect((await recreated.binding(alias)).apiKey).not.toBe(original.tokens.access_token);

    for (const value of [auth('account-two'), auth('account-one', 'subject-two')]) {
      f.setAuth(value);
      const currentAlias = f.source.discover()!.alias;
      expect((await f.source.binding(currentAlias)).continuationIdentity).not.toEqual(identity);
    }
    other.setAuth(original);
    expect(other.source.discover()!.alias).toBe(alias);
    expect((await other.source.binding(alias)).continuationIdentity).not.toEqual(identity);
  } finally {
    f.close();
    other.close();
  }
});

test('expired login remains discoverable but never sends or refreshes a request', async () => {
  let calls = 0;
  const f = fixture(
    fakeFetch(async () => {
      calls++;
      return new Response('unexpected');
    }),
  );
  try {
    f.setAuth(auth('account-one', 'subject-one', 1));
    f.config('model = "configured"\n');
    const found = f.source.discover()!;
    expect(found.defaultModel).toBe('configured');
    await expect(f.source.binding(found.alias)).rejects.toThrow('codex_auth_expired');
    expect(calls).toBe(0);
  } finally {
    f.close();
  }
});

test('foreign issuer and public API Sign in with ChatGPT grants never reach Codex', async () => {
  const f = fixture();
  try {
    for (const extra of [
      { iss: 'https://foreign.invalid' },
      { scope: 'openid chatgpt.tokens.use.direct' },
      { scp: ['openid', 'chatgpt.tokens.use.direct'] },
      { scope: 'openid', scp: 'chatgpt.tokens.use.direct' },
    ]) {
      const value = auth();
      value.tokens.access_token = jwt({
        sub: 'subject-one',
        exp: 4_102_444_800,
        iss: 'https://auth.openai.com',
        [claim]: { chatgpt_account_id: 'account-one' },
        ...extra,
      });
      f.setAuth(value);
      expect(f.source.discover()).toBeUndefined();
      await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
    }
  } finally {
    f.close();
  }
});

test('bounded regular-file reading rejects oversize auth, directories, symlinks and FIFO', async () => {
  const f = fixture();
  try {
    writeFileSync(f.authPath, Buffer.alloc(128 * 1024 + 1, 32));
    expect(f.source.discover()).toBeUndefined();
    await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
    unlinkSync(f.authPath);
    mkdirSync(f.authPath);
    await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
    rmSync(f.authPath, { recursive: true });
    if (process.platform !== 'win32') {
      const target = join(f.root, 'outside-auth.json');
      writeFileSync(target, JSON.stringify(auth()));
      symlinkSync(target, f.authPath);
      await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_unavailable');
      unlinkSync(f.authPath);
      expect(spawnSync('mkfifo', [f.authPath]).status).toBe(0);
      await expect(f.source.binding('unknown')).rejects.toThrow('codex_auth_invalid');
    }
  } finally {
    f.close();
  }
});

test('bounded cache and config parsing preserves fallback without reading an invented model', () => {
  const f = fixture();
  try {
    f.setAuth(auth());
    writeFileSync(join(f.codexHome, 'models_cache.json'), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    f.config('model = "configured"\n');
    expect(f.source.discover()!.models).toEqual([{ name: 'configured' }]);
    f.config('model = "unterminated\n');
    expect(f.source.discover()!.models).toEqual([]);
  } finally {
    f.close();
  }
});

test('explicit Codex home takes precedence, and relative CODEX_HOME cannot read workspace credentials', async () => {
  const f = fixture();
  try {
    f.setAuth(auth());
    const explicit = createCodexLocalSource({ home: '/not-used', codexHome: f.codexHome });
    expect(explicit.authPath).toBe(f.authPath);
    expect(explicit.discover()).toBeDefined();
    const relative = createCodexLocalSource({ home: f.root, codexHome: '.codex' });
    expect(relative.discover()).toBeUndefined();
    await expect(relative.binding('unknown')).rejects.toThrow('codex_auth_unavailable');
  } finally {
    f.close();
  }
});

test('only qualified absolute Codex source paths reach tool protection, even before credentials exist', async () => {
  const f = fixture();
  const previous = process.env.CODEX_HOME;
  try {
    expect(f.source.discover()).toBeUndefined();
    expect(f.source.protectedAuthPath).toBe(f.authPath);
    for (const home of [
      '',
      'relative-codex-home',
      join(f.root, 'invalid\0home'),
      `/${'a'.repeat(8192)}`,
    ]) {
      process.env.CODEX_HOME = home;
      const source = createCodexLocalSource({ home: f.root });
      expect(source.protectedAuthPath).toBeUndefined();
      expect(source.discover()).toBeUndefined();
      await expect(source.binding('unknown')).rejects.toThrow('codex_auth_unavailable');
    }
    process.env.CODEX_HOME = join(f.root, 'future-codex-home');
    const absent = createCodexLocalSource();
    expect(absent.protectedAuthPath).toBe(join(process.env.CODEX_HOME, 'auth.json'));
    expect(absent.discover()).toBeUndefined();
    expect(existsSync(process.env.CODEX_HOME)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    f.close();
  }
});

(process.platform === 'win32' ? test.skip : test)(
  'default HOME aliases bind the physical Codex directory without writing or changing explicit CODEX_HOME spelling',
  async () => {
    const f = fixture();
    const previous = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      f.setAuth(auth());
      f.config('model = "physical-home-model"\n');
      const homeAlias = join(f.root, 'home-alias');
      symlinkSync(f.root, homeAlias);
      const original = readFileSync(f.authPath);
      const entries = readdirSync(f.root).sort();
      const physicalAuth = join(realpathSync.native(f.codexHome), 'auth.json');
      const local = createCodexLocalSource({ home: homeAlias });
      const physical = createCodexLocalSource({ home: realpathSync.native(f.root) });
      expect(local.authPath).toBe(physicalAuth);
      expect(local.authPath).toBe(physical.authPath);
      const found = local.discover()!;
      expect(found).toEqual(physical.discover()!);
      expect(found.defaultModel).toBe('physical-home-model');
      expect((await local.binding(found.alias)).apiKey).toBe(
        (await physical.binding(found.alias)).apiKey,
      );
      expect(local.discover()).toEqual(found);
      const explicitHome = join(homeAlias, '.codex');
      expect(createCodexLocalSource({ codexHome: explicitHome }).authPath).toBe(
        join(explicitHome, 'auth.json'),
      );
      process.env.CODEX_HOME = explicitHome;
      expect(createCodexLocalSource({ home: homeAlias }).authPath).toBe(
        join(explicitHome, 'auth.json'),
      );
      expect(readFileSync(f.authPath)).toEqual(original);
      expect(readFileSync(join(f.codexHome, 'config.toml'), 'utf8')).toBe(
        'model = "physical-home-model"\n',
      );
      expect(readdirSync(f.root).sort()).toEqual(entries);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      f.close();
    }
  },
);

test('missing or relative default HOME retains its original readonly failure', async () => {
  const f = fixture();
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const absent = join(f.root, 'absent-home');
    const missing = createCodexLocalSource({ home: absent });
    expect(missing.authPath).toBe(join(absent, '.codex', 'auth.json'));
    expect(missing.discover()).toBeUndefined();
    await expect(missing.binding('unknown')).rejects.toThrow('codex_auth_required');
    expect(existsSync(absent)).toBe(false);
    const relative = createCodexLocalSource({ home: 'relative-home' });
    expect(relative.authPath).toBe(join('relative-home', '.codex', 'auth.json'));
    expect(relative.discover()).toBeUndefined();
    await expect(relative.binding('unknown')).rejects.toThrow('codex_auth_unavailable');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    f.close();
  }
});

test('bound transport rereads atomically replaced tokens, preserves wire content and caller cancellation', async () => {
  const received: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const f = fixture(
    fakeFetch(async (input, init) => {
      received.push({ url: String(input), init: init!, body: JSON.parse(String(init?.body)) });
      return new Response('fixture-response');
    }),
  );
  try {
    f.setAuth(auth());
    const binding = await f.source.binding(f.source.discover()!.alias);
    const rotated = auth();
    rotated.tokens.access_token = jwt(
      {
        sub: 'subject-one',
        exp: 4_102_444_801,
        iss: 'https://auth.openai.com',
        [claim]: { chatgpt_account_id: 'account-one' },
      },
      'rotated',
    );
    const pending = join(f.codexHome, 'auth.pending');
    writeFileSync(pending, JSON.stringify(rotated));
    renameSync(pending, f.authPath);
    const controller = new AbortController();
    const original = {
      model: 'local-codex-model',
      instructions: 'first',
      store: true,
      stream: false,
      reasoning: { effort: 'high' },
      include: ['reasoning.encrypted_content'],
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'system instruction' }] },
        { role: 'developer', content: 'developer instruction' },
        { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
        { type: 'function_call_output', call_id: 'call-original', output: 'result' },
      ],
    };
    await binding.fetch(`${CODEX_BASE_URL}/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer stale', 'chatgpt-account-id': 'stale-account' },
      body: JSON.stringify(original),
      signal: controller.signal,
      redirect: 'follow',
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe(`${CODEX_BASE_URL}/responses`);
    const headers = new Headers(received[0]!.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${rotated.tokens.access_token}`);
    expect(headers.get('chatgpt-account-id')).toBe('account-one');
    expect(headers.get('originator')).toBe('kite-code');
    expect(received[0]!.init.signal).toBe(controller.signal);
    expect(received[0]!.init.redirect).toBe('manual');
    expect(received[0]!.init.credentials).toBe('omit');
    expect(received[0]!.body).toEqual({
      ...original,
      input: original.input.slice(2),
      instructions: 'first\n\nsystem instruction\n\ndeveloper instruction',
      stream: true,
      store: false,
    });
    expect(received[0]!.body).not.toHaveProperty('max_output_tokens');
    controller.abort();
    await expect(
      binding.fetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST',
        body: JSON.stringify(original),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
    f.setAuth(auth('account-two'));
    await expect(post(binding)).rejects.toThrow('codex_auth_required');
    f.setAuth(auth('account-one', 'subject-one', 1));
    await expect(post(binding)).rejects.toThrow('codex_auth_expired');
    unlinkSync(f.authPath);
    await expect(post(binding)).rejects.toThrow('codex_auth_required');
    expect(received).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('transport rejects other URLs and redirects without forwarding or retrying auth', async () => {
  let requests = 0;
  const f = fixture(
    fakeFetch(async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location: 'https://foreign.invalid' } });
    }),
  );
  try {
    f.setAuth(auth());
    const binding = await f.source.binding(f.source.discover()!.alias);
    for (const url of [
      'https://api.openai.com/v1/responses',
      'https://foreign.invalid/responses',
      `${CODEX_BASE_URL}/responses?token=unexpected`,
      `${CODEX_BASE_URL}/responses#unexpected`,
      `${CODEX_BASE_URL}/models`,
    ])
      await expect(
        binding.fetch(url, {
          method: 'POST',
          body: JSON.stringify({ model: 'fixture', input: [] }),
        }),
      ).rejects.toThrow('codex_request_invalid');
    expect(requests).toBe(0);
    await expect(
      binding.fetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST',
        body: JSON.stringify({ model: 'fixture', input: [], max_output_tokens: 123 }),
      }),
    ).rejects.toThrow('codex_model_options_unsupported');
    expect(requests).toBe(0);
    await expect(post(binding)).rejects.toThrow('codex_transport_failed');
    expect(requests).toBe(1);
  } finally {
    f.close();
  }
});

test('transport errors never expose the underlying body, credential or cause and do not retry', async () => {
  let requests = 0;
  const f = fixture(
    fakeFetch(async () => {
      requests++;
      throw Error('fixture-private-body-and-credential');
    }),
  );
  try {
    f.setAuth(auth());
    const binding = await f.source.binding(f.source.discover()!.alias);
    await expect(post(binding)).rejects.toThrow('codex_transport_failed');
    expect(requests).toBe(1);
  } finally {
    f.close();
  }
});

test('actual SDK Responses mapping uses the bound Codex transport and original tool protocol', async () => {
  const received: Record<string, unknown>[] = [];
  const f = fixture(
    fakeFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      received.push(body);
      return new Response(
        encodeFrames(
          responseFrames({ id: 'fixture-response', model: 'fixture-model', text: ['done'] }, body),
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  try {
    f.setAuth(auth());
    const privateBinding = await f.source.binding(f.source.discover()!.alias);
    const binding = createCompatibleModelBinding({
      baseURL: CODEX_BASE_URL,
      name: 'codex',
      protocol: 'responses',
      modelId: 'fixture-model',
      ...privateBinding,
    });
    const adapter = createSdkModelAdapter({ models: new Map([['selected', binding]]) });
    const request: ModelRequest = {
      modelId: 'selected',
      requestId: 'fixture-request',
      messages: [
        { role: 'system', content: 'Follow the original task.' },
        { role: 'user', content: 'A question.' },
      ],
      tools: [],
    };
    const events: ModelEvent[] = [];
    for await (const event of adapter.stream(request, { signal: new AbortController().signal }))
      events.push(event);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      instructions: 'Follow the original task.',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    });
    expect(received[0]!.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'A question.' }] },
    ]);
    expect(events.some((event) => event.type === 'text_delta' && event.text === 'done')).toBe(true);
    expect(events.some((event) => event.type === 'finish')).toBe(true);
  } finally {
    f.close();
  }
});
