import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CompressionInput } from '@kite-ai/agent';
import { createConfigurationSnapshot, type JsonObject } from '@kite-ai/agent/config';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createSummaryCompressor } from '../../src/compression-configuration';
import { providerSettingsFacts } from '../../src/model-providers';
import { createUserConfiguration } from '../../src/user-configuration';
import { ownedUserConfiguration } from '../fixtures/user-configuration-fixture';

function localCodex(alias = 'codex-local-owned-account') {
  return {
    discover: () => ({
      alias,
      name: 'ChatGPT / Codex（本机）',
      models: [
        { name: 'actual-codex-first', contextWindowTokens: 500000 },
        { name: 'actual-codex-second' },
      ],
      defaultModel: 'actual-codex-second',
    }),
  };
}

test('Codex discovery adds a read-only local connection without creating or copying configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-codex-configuration-'));
  try {
    const { path } = ownedUserConfiguration(root);
    const source = createUserConfiguration(path, localCodex());
    const read = source.read();
    const models = read.value.models as JsonObject[];
    expect(read.exists).toBe(false);
    expect(models.map((model) => model.model)).toEqual([
      'actual-codex-first',
      'actual-codex-second',
    ]);
    expect(read.value.modelId).toBe(models[1]!.id);
    expect(models[0]).toMatchObject({
      provider: 'codex',
      protocol: 'responses',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      enabled: true,
      modelCapabilities: { contextWindowTokens: 500000 },
    });
    const sealed = createConfigurationSnapshot(read.value);
    expect(sealed.configuration.models).toHaveLength(2);
    const facts = providerSettingsFacts(read.value, sealed.configuration.models!);
    expect(facts.find((provider) => provider.id === 'codex')!.connections).toMatchObject([
      { canWrite: false, hasCredential: true, protocol: 'responses' },
    ]);
    expect(() => readFileSync(path)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex preferences use the existing fields without materializing its provider or replacing a user default', () => {
  const f = fixture();
  try {
    const source = createUserConfiguration(f.path, localCodex());
    const original = source.read();
    expect(original.value.modelId).toBe(f.source.read().value.modelId);
    const models = original.value.models as JsonObject[];
    const first = models.findIndex((model) => model.model === 'actual-codex-first');
    const second = models.find((model) => model.model === 'actual-codex-second')!;
    source.update({
      ifMatch: original.etag,
      operations: [
        { kind: 'set', path: ['models', first, 'enabled'], value: false },
        { kind: 'set', path: ['models', first, 'options'], value: { reasoningEffort: 'high' } },
        { kind: 'set', path: ['modelId'], value: second.id! },
      ],
    });
    const savedText = readFileSync(f.path, 'utf8');
    const saved = JSON.parse(savedText.slice(savedText.indexOf('{')));
    expect(Object.keys(saved.provider)).toEqual(['deepseek', 'qwen']);
    expect(saved.model).toBe('codex-local-owned-account:actual-codex-second');
    expect(saved.disabledModels).toContainEqual({
      provider: 'codex-local-owned-account',
      name: 'actual-codex-first',
    });
    expect(saved.modelOptions[String(models[first]!.id)]).toEqual({ reasoningEffort: 'high' });
    expect(saved.provider.deepseek.apiKey).toBe('OWNED_PRIVATE_KEY');
    expect(savedText.startsWith('// keep user comment')).toBe(true);
    const after = source.read().value;
    expect((after.models as JsonObject[])[first]).toMatchObject({
      enabled: false,
      options: { reasoningEffort: 'high' },
    });
    expect(after.modelId).toBe(second.id);
  } finally {
    f.close();
  }
});

test('local Codex effort enters the existing preference layer and an explicit model override takes precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-codex-effort-'));
  try {
    const { path } = ownedUserConfiguration(root);
    const local = localCodex();
    const source = createUserConfiguration(path, {
      discover: () => ({ ...local.discover(), reasoningEffort: 'high' as const }),
    });
    const before = source.read();
    const models = before.value.models as JsonObject[];
    expect(models.map((model) => model.options)).toEqual([
      { reasoningEffort: 'high' },
      { reasoningEffort: 'high' },
    ]);
    expect(before.value.modelId).toBe(models[1]!.id);
    expect(() => readFileSync(path)).toThrow();
    source.update({
      ifMatch: before.etag,
      operations: [
        { kind: 'set', path: ['models', 1, 'options'], value: { reasoningEffort: 'low' } },
      ],
    });
    const after = source.read().value.models as JsonObject[];
    expect(after.map((model) => model.options)).toEqual([
      { reasoningEffort: 'high' },
      { reasoningEffort: 'low' },
    ]);
    const saved = readFileSync(path, 'utf8');
    expect(JSON.parse(saved).provider).toBeUndefined();
    expect(JSON.parse(saved).modelOptions[String(models[1]!.id)]).toEqual({
      reasoningEffort: 'low',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex account changes produce distinct routes and preserve an explicit old account selection', () => {
  const f = fixture();
  try {
    let current = localCodex('codex-account-a').discover();
    const source = createUserConfiguration(f.path, { discover: () => current });
    const before = source.read();
    const selected = (before.value.models as JsonObject[]).find(
      (model) => model.provider === 'codex',
    )!;
    source.update({
      ifMatch: before.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: selected.id! }],
    });
    const old = source.read();
    current = localCodex('codex-account-b').discover();
    const next = source.read();
    expect(next.etag).toBe(old.etag);
    expect(createConfigurationSnapshot(next.value).digest).not.toBe(
      createConfigurationSnapshot(old.value).digest,
    );
    expect(next.value.modelId).toBe(selected.id);
    expect((next.value.models as JsonObject[]).some((model) => model.id === selected.id)).toBe(
      false,
    );
  } finally {
    f.close();
  }
});

test('a hand-written Codex protocol cannot seal a different protocol from its actual binding', () => {
  const source = createUserConfiguration();
  for (const protocol of ['chat-completions', 'unexpected']) {
    expect(() =>
      createConfigurationSnapshot(
        source.normalize({
          provider: {
            'codex-owned-account': {
              type: 'codex',
              protocol,
              baseURL: 'https://chatgpt.com/backend-api/codex',
              models: ['actual-codex-model'],
            },
          },
        }),
      ),
    ).toThrow('model_protocol_unsupported');
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-user-configuration-'));
  const { path, homeEnvironment } = ownedUserConfiguration(root);
  writeFileSync(
    path,
    '// keep user comment\n' +
      JSON.stringify(
        {
          provider: {
            deepseek: {
              apiKey: 'OWNED_PRIVATE_KEY',
              models: ['first', 'second'],
              reasoning: false,
              effort: 'high',
            },
            qwen: {
              baseURL: 'http://127.0.0.1:1234/v1',
              apiKey: 'OWNED_QWEN_KEY',
              models: [{ name: 'other', contextWindowTokens: 128000, maxOutputTokens: 2000 }],
              modelKwargs: { temperature: 0.3 },
            },
          },
          model: 'deepseek:first',
          theme: 'dark',
        },
        null,
        2,
      ),
    { mode: 0o600 },
  );
  return {
    root,
    path,
    homeEnvironment,
    source: createUserConfiguration(path),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('one user file projects existing provider aliases and selection without exposing inline credentials', () => {
  const f = fixture();
  try {
    expect(createUserConfiguration().path).toBe(join(homedir(), '.kite-code', 'kite-code.jsonc'));
    const view = f.source.read();
    const models = view.value.models as JsonObject[];
    expect(models.map((model) => [model.providerName, model.model])).toEqual([
      ['deepseek', 'first'],
      ['deepseek', 'second'],
      ['qwen', 'other'],
    ]);
    expect(view.value.modelId).toBe(models[0]!.id);
    expect(models[0]!.options).toEqual({ reasoningEffort: 'high' });
    expect(models[2]!.provider).toBe('compatible');
    expect(models[2]!.options).toEqual({ maxOutputTokens: 2000, temperature: 0.3 });
    expect(models[2]!.modelCapabilities).toEqual({
      contextWindowTokens: 128000,
      maxOutputTokens: 2000,
    });
    expect(JSON.stringify(view.value)).not.toContain('OWNED_');
    expect(f.source.resolveCredential(String(models[0]!.credentialRef))).toBe('OWNED_PRIVATE_KEY');
    expect(
      f.source.resolveCredential('credential:00000000-0000-0000-0000-000000000000'),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
for (const metadata of [
  { contextWindow: 1048576 },
  { contextWindowTokens: 1048576 },
  { contextWindow: 4096, contextWindowTokens: 1048576 },
])
  test(`declared 1M window survives user normalization and applies its 75 percent trigger: ${JSON.stringify(metadata)}`, async () => {
    const f = fixture();
    try {
      const raw = JSON.parse(readFileSync(f.path, 'utf8').replace('// keep user comment\n', ''));
      raw.provider.deepseek.models = [{ name: 'first', ...metadata }];
      writeFileSync(f.path, JSON.stringify(raw), { mode: 0o600 });
      const original = readFileSync(f.path, 'utf8');
      const before = f.source.read();
      const snapshot = createConfigurationSnapshot(before.value);
      const selected = snapshot.configuration.models!.find(
        (model) => model.id === snapshot.configuration.modelId,
      )!;
      expect(selected.modelCapabilities).toEqual({ contextWindowTokens: 1048576 });
      const compressor = createSummaryCompressor({ automatic: selected.modelCapabilities });
      const messages = [
        { role: 'user' as const, content: 'Understand this project' },
        { role: 'assistant' as const, content: 'Collected actual project evidence' },
      ];
      const request = { modelId: selected.id, messages, tools: [] };
      for (const inputTokens of [32768, 196608, 786431, 786432])
        expect(
          await compressor.shouldCompress!({
            modelId: selected.id,
            messages,
            tools: [],
            sources: [],
            tokenBaseline: { executionId: 'original', request, inputTokens },
          } as unknown as CompressionInput),
        ).toBe(inputTokens >= 786432);
      f.source.update({
        ifMatch: before.etag,
        operations: [{ kind: 'set', path: ['theme'], value: 'light' }],
      });
      expect(JSON.parse(readFileSync(f.path, 'utf8')).provider.deepseek.models[0]).toEqual({
        name: 'first',
        ...metadata,
      });
      expect(original).toContain('1048576');
    } finally {
      f.close();
    }
  });

test('malformed explicit context windows fail preflight instead of silently selecting a fallback', () => {
  const source = createUserConfiguration();
  for (const contextWindow of [0, -1, 1.5, '1m', null, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      createConfigurationSnapshot(
        source.normalize({
          provider: { deepseek: { models: [{ name: 'first', contextWindow }] } },
        }),
      ),
    ).toThrow();
  expect(() =>
    createConfigurationSnapshot(
      source.normalize({
        provider: {
          deepseek: {
            models: [{ name: 'first', contextWindow: 1048576, contextWindowTokens: 0 }],
          },
        },
      }),
    ),
  ).toThrow('invalid_model_capabilities');
});
test('switch and default writes preserve the existing schema, comments, metadata and keys with exact byte CAS', () => {
  const f = fixture();
  try {
    const original = f.source.read(),
      models = original.value.models as JsonObject[];
    f.source.update({
      ifMatch: original.etag,
      operations: [{ kind: 'set', path: ['models', 1, 'enabled'], value: false }],
    });
    const switched = f.source.read();
    expect((switched.value.models as JsonObject[])[1]!.enabled).toBe(false);
    expect(() =>
      f.source.update({
        ifMatch: original.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: models[2]!.id! }],
      }),
    ).toThrow('configuration_conflict');
    f.source.update({
      ifMatch: switched.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: models[2]!.id! }],
    });
    const text = readFileSync(f.path, 'utf8');
    expect(text.startsWith('// keep user comment')).toBe(true);
    const saved = JSON.parse(text.slice(text.indexOf('{')));
    expect(saved.model).toBe('qwen:other');
    expect(saved.disabledModels).toEqual([{ provider: 'deepseek', name: 'second' }]);
    expect(saved.provider.deepseek.apiKey).toBe('OWNED_PRIVATE_KEY');
    expect(saved.provider.qwen.models[0]).toEqual({
      name: 'other',
      contextWindowTokens: 128000,
      maxOutputTokens: 2000,
    });
    expect(saved.theme).toBe('dark');
    expect(saved.models).toBeUndefined();
    expect(saved.modelId).toBeUndefined();
  } finally {
    f.close();
  }
});

test('user format adaptation rejects unsafe edits before touching prototypes or the file', () => {
  const f = fixture();
  const marker = 'kiteUserConfigurationProbe';
  const prototype = Array.prototype as unknown as Record<string, unknown>;
  try {
    const original = readFileSync(f.path, 'utf8');
    expect(() =>
      f.source.update({
        ifMatch: f.source.read().etag,
        operations: [{ kind: 'set', path: ['models', '__proto__', marker], value: true }],
      }),
    ).toThrow('invalid_configuration_edit');
    expect(Object.hasOwn(prototype, marker)).toBe(false);
    expect(() =>
      f.source.update({
        ifMatch: f.source.read().etag,
        operations: [{ kind: 'set', path: ['models', 0, 'apiKey'], value: 'OWNED_SECRET_PROBE' }],
      }),
    ).toThrow('credential_reference_required');
    expect(readFileSync(f.path, 'utf8')).toBe(original);
  } finally {
    delete prototype[marker];
    f.close();
  }
});
test('adapted unchanged and changed defaults keep validation under the target lock', () => {
  const f = fixture();
  try {
    const original = readFileSync(f.path, 'utf8');
    for (const index of [0, 2]) {
      const before = f.source.read();
      const models = before.value.models as JsonObject[];
      let validations = 0;
      const validateUnderLock = () => {
        validations++;
        expect(() =>
          f.source.update({
            ifMatch: before.etag,
            operations: [{ kind: 'set', path: ['models', 1, 'enabled'], value: false }],
          }),
        ).toThrow('configuration_busy');
      };
      f.source.update({
        ifMatch: before.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: models[index]!.id! }],
        validateCandidate: validateUnderLock,
        validatePublication: validateUnderLock,
      });
      expect(validations).toBe(2);
      expect(f.source.read().value.modelId).toBe(models[index]!.id);
      if (index === 0) expect(readFileSync(f.path, 'utf8')).toBe(original);
    }
  } finally {
    f.close();
  }
});
test('provider edits keep exact route IDs and new models persist disabled in the same user file', () => {
  const f = fixture();
  try {
    const original = f.source.read();
    const models = original.value.models as JsonObject[];
    const connection = models.filter((model) => model.providerName === 'qwen');
    const added = f.source
      .createModels('compatible', ['new-model', 'another-new-model'], connection)
      .map((model) => ({
        ...model,
        provider: 'compatible',
        baseURL: 'http://127.0.0.1:1234/v1',
        enabled: false,
        credentialRef: connection[0]!.credentialRef!,
      }));
    f.source.update({
      ifMatch: original.etag,
      operations: [{ kind: 'set', path: ['models'], value: [...models, ...added] }],
    });
    const after = f.source.read().value.models as JsonObject[];
    expect(after[2]!.id).toBe(models[2]!.id);
    expect(after.slice(3)).toMatchObject(added);
    expect(JSON.stringify(after)).not.toContain('OWNED_');
  } finally {
    f.close();
  }
});
test('missing or invalid user configuration never falls back to a Profile configuration', () => {
  const f = fixture();
  try {
    const profile = join(f.root, '.kite-code', 'unified-agent', 'default');
    mkdirSync(profile, { recursive: true });
    const retired = join(profile, 'config.jsonc');
    writeFileSync(retired, '{"models":[{"id":"must-not-load"}],"modelId":"must-not-load"}');
    rmSync(f.path);
    expect(f.source.read().value.models).toEqual([]);
    expect(f.source.read().value.modelId).toBeNull();
    writeFileSync(f.path, '{broken');
    expect(() => f.source.read()).toThrow('invalid_jsonc');
    expect(readFileSync(retired, 'utf8')).toContain('must-not-load');
  } finally {
    f.close();
  }
});

test('default updates retain nested selection shape and unrelated disabled routes', () => {
  const f = fixture();
  try {
    const text = readFileSync(f.path, 'utf8');
    const raw = JSON.parse(text.slice(text.indexOf('{')));
    raw.model = { default: { provider: 'deepseek', name: 'first' } };
    raw.disabledModels = [{ provider: 'temporarily-removed', name: 'remember-disabled' }];
    writeFileSync(f.path, JSON.stringify(raw));
    const original = f.source.read();
    const models = original.value.models as JsonObject[];
    f.source.update({
      ifMatch: original.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: models[2]!.id! }],
    });
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(saved.model).toEqual({ default: { provider: 'qwen', name: 'other' } });
    expect(saved.disabledModels).toEqual(raw.disabledModels);
  } finally {
    f.close();
  }
});

test('actual default paired Services share the host user file across Profiles without a path override', async () => {
  const f = fixture();
  try {
    const dataRoot = join(f.root, '.kite-code', 'unified-agent');
    privateDirectory(join(dataRoot, 'default'));
    writeFileSync(join(dataRoot, 'default', 'config.jsonc'), '{"models":[{"id":"retired"}]}');
    const original = readFileSync(f.path, 'utf8');
    const moduleUrl = (path: string) => pathToFileURL(join(import.meta.dir, path)).href;
    const program = `
      import { selectProfile } from '@kite-ai/agent/profile';
      import { launchPairedService } from ${JSON.stringify(moduleUrl('../../src/paired.ts'))};
      for (const name of ['default', 'development']) {
        const handle = await launchPairedService({
          entrypoint: ${JSON.stringify(join(import.meta.dir, '../../src/main.ts'))},
          profile: selectProfile({ dataRoot: ${JSON.stringify(dataRoot)}, profile: name }),
          instanceId: crypto.randomUUID(), buildId: 'user-source-test', apiMajor: 1,
          requiredCapabilities: ['commands'],
        });
        try {
          const settings = await handle.client.getModelSettings('user', { storeId: handle.bootstrap.storeId });
          console.log(JSON.stringify({ name, scope: settings.scope, models: settings.models.map(m => m.model), defaultModelId: settings.defaultModelId }));
        } finally { await handle.close(); }
      }
    `;
    const child = Bun.spawn([process.execPath, '--no-install', '-e', program], {
      cwd: join(import.meta.dir, '../../../..'),
      env: {
        ...process.env,
        ...f.homeEnvironment,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    const facts = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(facts.map((fact) => [fact.name, fact.scope, fact.models])).toEqual([
      ['default', 'user', ['first', 'second', 'other']],
      ['development', 'user', ['first', 'second', 'other']],
    ]);
    expect(facts[0].defaultModelId).toBe(facts[1].defaultModelId);
    expect(stdout).not.toContain('OWNED_');
    expect(readFileSync(f.path, 'utf8')).toBe(original);
  } finally {
    f.close();
  }
}, 20000);

test('provider protocol round-trips through normalized edits without changing sibling providers or secrets', () => {
  const f = fixture();
  try {
    const raw = JSON.parse(readFileSync(f.path, 'utf8').replace('// keep user comment\n', ''));
    raw.provider.qwen.protocol = 'responses';
    writeFileSync(f.path, '// keep user comment\n' + JSON.stringify(raw), { mode: 0o600 });
    const original = f.source.read();
    const models = original.value.models as JsonObject[];
    expect(models[0]!.protocol).toBeUndefined();
    expect(models[2]!.protocol).toBe('responses');
    const result = f.source.update({
      ifMatch: original.etag,
      operations: [{ kind: 'set', path: ['models', 2, 'protocol'], value: 'chat-completions' }],
    });
    expect((result.value.models as JsonObject[])[2]!.protocol).toBe('chat-completions');
    const text = readFileSync(f.path, 'utf8');
    expect(text).toContain('// keep user comment');
    const saved = JSON.parse(text.replace('// keep user comment\n', ''));
    expect(saved.provider.qwen.protocol).toBe('chat-completions');
    expect(saved.provider.qwen.apiKey).toBe('OWNED_QWEN_KEY');
    expect(saved.provider.deepseek).toEqual(raw.provider.deepseek);
  } finally {
    f.close();
  }
});
