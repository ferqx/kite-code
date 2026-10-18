import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';

const repo = resolve(import.meta.dir, '../../../..');
test('actual development argv uses paired public management and exact supplied intent without Model or Tool', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-management-argv-'))),
    dataRoot = join(root, 'data'),
    profile = selectProfile({ dataRoot, profile: 'development' });
  await buildOwnedDaemon(join(root, 'service-artifact'));
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    entrypoint = join(root, 'service-artifact/node_modules/@kite-ai/service/main.js'),
    entrypointSha256 = sha(readFileSync(entrypoint));
  const artifact: CLIServiceArtifact = {
    entrypoint,
    entrypointSha256,
    executable: realpathSync(process.execPath),
    executableSha256: sha(readFileSync(process.execPath)),
    buildId: `development-${entrypointSha256}`,
    apiMajor: 1,
  };
  mkdirSync(join(root, 'apps/service'), { recursive: true });
  symlinkSync(
    join(root, 'service-artifact/node_modules/@kite-ai/service'),
    join(root, 'apps/service/dist'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const driver = join(root, 'management-argv.ts');
  writeFileSync(
    driver,
    `import {runDevelopmentCLI} from ${JSON.stringify(join(repo, 'scripts/development/unified-cli.ts'))};process.exitCode=await runDevelopmentCLI({root:${JSON.stringify(root)}});`,
  );
  async function argv(words: string[]) {
    const child = Bun.spawn([process.execPath, driver, ...words], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exit: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    };
  }
  try {
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions', 'context', 'commands'],
    });
    let storeId = '',
      selection = '';
    try {
      if (seed.bootstrap.dataAvailability !== 'available') throw Error('unavailable');
      storeId = seed.bootstrap.storeId;
      await seed.client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'owned',
      });
      const session = await seed.client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'old',
      });
      selection = session.contextSelectionId;
    } finally {
      await seed.close();
    }
    const renamed = await argv([
      'session',
      'rename',
      'a',
      '--input',
      JSON.stringify({
        expectedStoreId: storeId,
        commandId: 'rename',
        ifRevision: '0',
        title: 'Actual argv',
      }),
      '--data-root',
      dataRoot,
    ]);
    expect(renamed.exit).toBe(0);
    expect(renamed.err).toBe('');
    expect(renamed.out).toContain('"status":"applied"');
    const context = await argv([
      'context',
      'read',
      'a',
      '--input',
      JSON.stringify({ storeId, contextSelectionId: selection }),
      '--data-root',
      dataRoot,
    ]);
    expect(context.exit).toBe(0);
    expect(JSON.parse(context.out).selection.id).toBe(selection);
    expect(JSON.parse(context.out).messages).toEqual([]);
    const fork = await argv([
      'session',
      'fork',
      'a',
      '--input',
      JSON.stringify({
        expectedStoreId: storeId,
        commandId: 'fork',
        expectedContextSelectionId: selection,
        newSessionId: 'fork',
        title: 'Separate scope',
      }),
      '--data-root',
      dataRoot,
    ]);
    expect(fork.exit).toBe(0);
    const forkOutput = JSON.parse(fork.out.trim().split('\n').at(-1)!);
    expect(forkOutput.status).toBe('applied');
    expect(forkOutput.command.id).toBe('fork');
    expect(forkOutput.command.receipt).toMatchObject({
      sourceSessionId: 'a',
      sourceSelectionId: selection,
      sessionId: 'fork',
      sourceUpperSeq: JSON.parse(context.out).highWaterSeq,
      namespaceReport: [],
      omittedExtensionState: false,
    });
    const deleted = await argv([
      'session',
      'delete',
      'fork',
      '--input',
      JSON.stringify({ expectedStoreId: storeId, commandId: 'delete', ifRevision: '0' }),
      '--data-root',
      dataRoot,
    ]);
    expect(deleted.exit).toBe(2);
    expect(deleted.out).toContain('"status":"delete_requested"');
    expect(deleted.out).toContain('"stopConfirmed":false');
    const unused = join(root, 'invalid-never-created');
    const invalid = await argv([
      'session',
      'rename',
      'a',
      '--input',
      JSON.stringify({
        expectedStoreId: storeId,
        commandId: 'bad',
        ifRevision: '1',
        title: 'bad',
        grant: 'full',
      }),
      '--data-root',
      unused,
    ]);
    expect(invalid.exit).toBe(1);
    expect(invalid.err).toContain('invalid_cli_arguments');
    expect(existsSync(unused)).toBe(false);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT count(*) AS n FROM execution').get()).toEqual({ n: 0 });
      expect(
        db.query("SELECT count(*) AS n FROM command WHERE id IN('rename','fork','delete')").get(),
      ).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
