import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStandaloneReleaseStubsV1 } from '../../scripts/release/oss-candidate';
import {
  AsyncEntry,
  Entry,
  findCredentials,
  findCredentialsAsync,
  STANDALONE_KEYRING_UNAVAILABLE_MESSAGE_V1,
} from '../../src/app/release/standalone-keyring-unavailable';

const roots: string[] = [];
const unavailable = STANDALONE_KEYRING_UNAVAILABLE_MESSAGE_V1;
const probeValue = 'qualification-probe-value';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('standalone candidate keyring replacement', () => {
  test('allows construction but rejects every async credential operation without echoing input', async () => {
    const entry = new AsyncEntry('candidate-service', 'candidate-account');
    expect(
      AsyncEntry.withTarget('candidate-target', 'candidate-service', 'candidate-account'),
    ).toBeInstanceOf(AsyncEntry);

    for (const operation of [
      () => entry.setPassword(probeValue),
      () => entry.setSecret(new TextEncoder().encode(probeValue)),
      () => entry.getPassword(),
      () => entry.getSecret(),
      () => entry.deleteCredential(),
      () => entry.deletePassword(),
    ]) {
      await expect(operation()).rejects.toThrow(unavailable);
      await expect(operation()).rejects.not.toThrow(probeValue);
    }
  });

  test('rejects every synchronous and discovery credential operation without fallback', async () => {
    const entry = new Entry('candidate-service', 'candidate-account');
    expect(
      Entry.withTarget('candidate-target', 'candidate-service', 'candidate-account'),
    ).toBeInstanceOf(Entry);

    for (const operation of [
      () => entry.setPassword(probeValue),
      () => entry.setSecret(new TextEncoder().encode(probeValue)),
      () => entry.getPassword(),
      () => entry.getSecret(),
      () => entry.deleteCredential(),
      () => entry.deletePassword(),
      () => findCredentials('candidate-service'),
    ]) {
      expect(operation).toThrow(unavailable);
      expect(operation).not.toThrow(probeValue);
    }
    await expect(findCredentialsAsync('candidate-service')).rejects.toThrow(unavailable);
    await expect(findCredentialsAsync('candidate-service')).rejects.not.toThrow(probeValue);
  });

  test('candidate build resolver embeds the source-owned replacement for keyring imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-standalone-keyring-test-'));
    roots.push(root);
    const entrypoint = join(root, 'entry.ts');
    const outdir = join(root, 'out');
    writeFileSync(
      entrypoint,
      [
        `import { NativeMcpCredentialStore } from ${JSON.stringify(resolve('src/core/mcp/credential-store.ts'))};`,
        "const key = { workspaceKey: 'candidate-workspace', source: 'user', server: 'candidate-server', profile: 'candidate-profile' };",
        "const value = { version: 1, kind: 'bearer', secret: 'qualification-probe-value', updatedAt: '2026-08-06T00:00:00.000Z' };",
        'export async function probe(operation) {',
        '  const store = new NativeMcpCredentialStore();',
        "  if (operation === 'status') return store.status();",
        "  if (operation === 'get') return store.get(key);",
        "  if (operation === 'put') return store.put(key, value);",
        "  if (operation === 'delete') return store.delete(key);",
        "  throw new Error('unknown operation');",
        '}',
      ].join('\n'),
    );

    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir,
      format: 'esm',
      target: 'bun',
      plugins: createStandaloneReleaseStubsV1(),
    });
    if (!result.success) {
      throw new Error(
        `candidate keyring probe build failed: ${result.logs.map((entry) => entry.message).join('; ')}`,
      );
    }
    expect(result.success).toBe(true);
    const outputPath = result.outputs[0]?.path;
    expect(outputPath).toBeDefined();
    if (!outputPath || !existsSync(outputPath))
      throw new Error('candidate keyring probe has no output.');

    const candidateModule = await import(
      `${pathToFileURL(outputPath).href}?candidate-keyring-probe`
    );
    expect(await candidateModule.probe('status')).toBe('unavailable');
    await expect(candidateModule.probe('get')).rejects.toThrow('Credential store is unavailable.');
    await expect(candidateModule.probe('put')).rejects.toThrow('Credential store is unavailable.');
    await expect(candidateModule.probe('delete')).rejects.toThrow(
      'Credential store is unavailable.',
    );
  });
});
