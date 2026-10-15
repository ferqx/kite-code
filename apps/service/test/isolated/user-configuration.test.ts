import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonObject } from '@kite-ai/agent/config';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { ownedUserConfiguration } from '@kite-ai/service/test-fixtures';
import { createUserConfiguration } from '../../src/user-configuration';

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
            },
            qwen: {
              baseURL: 'http://127.0.0.1:1234/v1',
              apiKey: 'OWNED_QWEN_KEY',
              models: [{ name: 'other', maxOutputTokens: 2000 }],
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
    expect(models[2]!.provider).toBe('compatible');
    expect(models[2]!.options).toEqual({ maxOutputTokens: 2000, temperature: 0.3 });
    expect(JSON.stringify(view.value)).not.toContain('OWNED_');
    expect(f.source.resolveCredential(String(models[0]!.credentialRef))).toBe('OWNED_PRIVATE_KEY');
    expect(
      f.source.resolveCredential('credential:00000000-0000-0000-0000-000000000000'),
    ).toBeUndefined();
  } finally {
    f.close();
  }
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
    expect(saved.provider.qwen.models[0]).toEqual({ name: 'other', maxOutputTokens: 2000 });
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
