/** Real current Service + PTY: invalid page-two metadata must remain an error. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { buildOwnedDaemon } from '../../../apps/cli/test/fixtures/daemon-host-build';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition } from '../harness/terminal-screen';
import { createTestWorkspace, translateOriginalTestConfig } from '../harness/test-workspace';

test('a malformed record reached on page two shows a TUI history error without erasing valid sessions', async () => {
  const workspace = createTestWorkspace({ configOverrides: { sandbox: { enabled: false } } });
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'A durable first answer' } }]);
  let tui: PtyProcess | undefined;
  let connection: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  const profile = selectProfile({ dataRoot: workspace.dataRoot, profile: workspace.profile });
  const storePath = profile.databasePath;
  try {
    writeFileSync(
      workspace.configPath,
      JSON.stringify(
        translateOriginalTestConfig({
          model: { default: { provider: 'mock', name: 'mock-model' } },
          provider: { mock: { baseURL: model.baseURL } },
        }).configuration,
      ),
    );
    const artifactRoot = join(workspace.home, 'page-error-service');
    await buildOwnedDaemon(artifactRoot);
    const entrypoint = join(artifactRoot, 'node_modules/@kite-ai/service/main.js');
    connection = await launchPairedService({
      profile,
      spawnChild: ownedUserConfiguration(workspace.home).spawnChild,
      entrypoint,
      executable: process.execPath,
      instanceId: 'page-error-setup',
      buildId: 'page-error-setup',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'commands', 'history', 'permission_controls'],
    });
    const client = connection.client,
      expectedStoreId = connection.bootstrap.storeId!;
    const root = await client.createWorkspace({
      expectedStoreId,
      id: 'page-workspace',
      name: 'Page workspace',
      rootUri: pathToFileURL(workspace.workspace).href,
    });
    const trust = await client.getWorkspaceTrust(root.id, { storeId: expectedStoreId });
    await client.setWorkspaceTrust(root.id, {
      expectedStoreId,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    const firstId = 'page-session-000';
    await client.createSession({
      expectedStoreId,
      sessionId: firstId,
      commandId: 'create-000',
      workspaceId: root.id,
      title: 'Durable first question',
    });
    await client.startRun(firstId, {
      expectedStoreId,
      commandId: 'first-turn',
      kind: 'run.start',
      content: 'Durable first question',
    });
    const deadline = Date.now() + 15_000;
    let completed = false;
    while (Date.now() < deadline) {
      const view = await client.getView(firstId);
      if (view.runs.some((run) => run.status === 'completed')) {
        completed = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(completed).toBe(true);
    // Every business row is created through the actual public Service contract.
    for (let index = 1; index <= 101; index++) {
      const suffix = String(index).padStart(3, '0');
      const session = await client.createSession({
        expectedStoreId,
        sessionId: `page-session-${suffix}`,
        commandId: `create-${suffix}`,
        workspaceId: root.id,
        title: `Valid Session ${suffix}`,
      });
      expect(session.id).toBe(`page-session-${suffix}`);
    }
    const listed = await client.listSessionDirectory({
      storeId: expectedStoreId,
      workspaceId: root.id,
      limit: 100,
    });
    expect(listed.items).toHaveLength(100);
    expect(listed.nextAfterSeq).not.toBeNull();
    const originalSecondPage = await client.listSessionDirectory({
      storeId: expectedStoreId,
      workspaceId: root.id,
      limit: 100,
      afterSeq: listed.nextAfterSeq!,
      upperSeq: listed.upperSeq,
    });
    expect(originalSecondPage.items).toHaveLength(2);
    const damagedId = originalSecondPage.items.at(-1)!.session.id;
    expect(listed.items.some((item) => item.session.id === damagedId)).toBe(false);
    await connection.close();
    connection = undefined;

    const database = new Database(storePath, { strict: true });
    let originalIds: string[];
    try {
      originalIds = database
        .query<{ id: string }, []>('SELECT id FROM session ORDER BY id')
        .all()
        .map((row) => row.id);
      expect(originalIds).toHaveLength(102);
      // Select the actual public page-two record; Core cursors use ascending allocation order.
      // This is existing storage damage, not a writer accepting an invalid revision.
      database.run('PRAGMA ignore_check_constraints=ON');
      database.query('UPDATE session SET control_revision=-1 WHERE id=?').run(damagedId);
      database.run('PRAGMA ignore_check_constraints=OFF');
    } finally {
      database.close();
    }

    connection = await launchPairedService({
      profile,
      spawnChild: ownedUserConfiguration(workspace.home).spawnChild,
      entrypoint,
      executable: process.execPath,
      instanceId: 'page-error-read',
      buildId: 'page-error-setup',
      apiMajor: 1,
      requiredCapabilities: ['sessions'],
    });
    const firstPage = await connection.client.listSessionDirectory({
      storeId: expectedStoreId,
      workspaceId: root.id,
      limit: 100,
    });
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.nextAfterSeq).not.toBeNull();
    expect(firstPage.items.some((item) => item.session.id === damagedId)).toBe(false);
    await expect(
      connection.client.listSessionDirectory({
        storeId: expectedStoreId,
        workspaceId: root.id,
        limit: 100,
        afterSeq: firstPage.nextAfterSeq!,
        upperSeq: firstPage.upperSeq,
      }),
    ).rejects.toThrow();
    await connection.close();
    connection = undefined;

    // Reuse the already configured public-Service Profile; its Provider has
    // already handled the original request, so no new mock contract binding.
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: model,
      workspace,
      noPreConfig: true,
    });
    try {
      await submitCommand(tui, '/resume');
    } catch (error) {
      throw new Error(`/resume input failed; TUI exited=${tui.exited}`, { cause: error });
    }
    await waitForCondition(
      () => screenContains(tui!.viewport(), '错误：无法加载历史会话，请稍后重试。'),
      'second-page history error to appear in the real TUI selector',
      15_000,
    );
    expect(screenContains(tui.viewport(), '暂无历史会话')).toBe(false);
    expect(screenContains(tui.viewport(), '错误：无法加载历史会话，请稍后重试。')).toBe(true);
    using retained = new Database(storePath, { readonly: true });
    const afterIds = retained
      .query<{ id: string }, []>('SELECT id FROM session ORDER BY id')
      .all()
      .map((row) => row.id);
    for (const id of originalIds) expect(afterIds).toContain(id);
    expect(afterIds.length).toBeGreaterThanOrEqual(originalIds.length);
    expect(
      retained
        .query<{ control_revision: number }, [string]>(
          'SELECT control_revision FROM session WHERE id=?',
        )
        .get(damagedId)?.control_revision,
    ).toBe(-1);
  } catch (error) {
    console.error('Current page-two fixture failure:', error);
    throw error;
  } finally {
    await connection?.close();
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [model], workspaces: [workspace] });
  }
}, 90_000);
