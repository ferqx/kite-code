import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [fixturePath, packagePath] = process.argv.slice(2) as [string, string];
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  directory: string;
  outdir: string;
  storeId: string;
  profile: { dataRoot: string; profile: string };
  control: string;
};
const require = createRequire(packagePath),
  { _electron } = require('playwright') as typeof import('playwright'),
  electron = require('electron') as string;
const errors: string[] = [],
  stages: unknown[] = [];
function facts() {
  const db = new DatabaseSync(join(fixture.profile.dataRoot, fixture.profile.profile, 'core.db'), {
    readOnly: true,
  });
  try {
    return {
      metadata: db
        .prepare('SELECT store_id,CAST(last_change_cursor AS TEXT) AS cursor FROM storage_meta')
        .get(),
      executions: db
        .prepare(
          'SELECT id,kind,state,CAST(result_revision AS TEXT) AS revision FROM execution ORDER BY id',
        )
        .all(),
      commands: db.prepare('SELECT id,kind,status FROM command ORDER BY id').all(),
      interactions: db.prepare('SELECT id,state,revision FROM interaction ORDER BY id').all(),
      events: db
        .prepare(
          'SELECT CAST(cursor AS TEXT) AS cursor,scope_session_id,object_id,type,trajectory_fact_json FROM change_event ORDER BY cursor',
        )
        .all()
        .map((row) => {
          const { trajectory_fact_json: sealedFact, ...metadata } = row;
          return {
            ...metadata,
            sealedFactSha256:
              typeof sealedFact === 'string'
                ? createHash('sha256').update(sealedFact).digest('hex')
                : null,
          };
        }),
    };
  } finally {
    db.close();
  }
}
const before = facts();
writeFileSync(join(fixture.directory, 'business-before.json'), JSON.stringify(before, null, 2));
function unpack(path: string) {
  const bytes = readFileSync(path),
    magic = Buffer.from('KITE-TRAJECTORY-BUNDLE 1\n');
  assert(bytes.subarray(0, magic.length).equals(magic));
  let offset = magic.length;
  const frames = new Map<string, Buffer>();
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    assert(end >= offset);
    const header = JSON.parse(bytes.subarray(offset, end).toString('utf8')) as {
      path: string;
      bytes: string;
    };
    assert(!frames.has(header.path));
    const start = end + 1,
      through = start + Number(header.bytes);
    frames.set(header.path, bytes.subarray(start, through));
    assert.equal(bytes[through], 10);
    offset = through + 1;
  }
  const manifest = JSON.parse(frames.get('manifest.json')!.toString('utf8'));
  const events = [...frames]
    .filter(([name]) => name.startsWith('events/'))
    .flatMap(([, body]) =>
      body
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  return { bytes: bytes.length, frames, manifest, events };
}
async function capture(page: import('playwright').Page, name: string, extra: unknown = {}) {
  const dom = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 4000),
    cursor: document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value,
    eventIds: [...document.querySelectorAll<HTMLElement>('[data-trajectory-event]')].map(
      (node) => node.dataset.trajectoryEvent,
    ),
    bridgeKeys: Object.keys(window.kiteNative ?? {}),
  }));
  stages.push({ name, at: Date.now(), dom, extra });
  await page.screenshot({ path: join(fixture.directory, `${name}.png`) });
  writeFileSync(join(fixture.directory, `${name}.json`), JSON.stringify({ dom, extra }, null, 2));
  console.log(JSON.stringify({ stage: name, cursor: dom.cursor, events: dom.eventIds.length }));
}
async function waitForFile(path: string, page: import('playwright').Page) {
  const end = Date.now() + 20000;
  while (!existsSync(path)) {
    const alertNode = page.locator('.trajectory-panel [role="alert"]');
    const alert = (await alertNode.count()) ? await alertNode.textContent() : null;
    if (alert) throw Error(`export_failed:${alert}`);
    if (Date.now() > end) throw Error('export_file_missing');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const exportPaths = [
  join(fixture.directory, 'events-only.kite-trajectory'),
  join(fixture.directory, 'with-evidence.kite-trajectory'),
];
let online: import('playwright').ElectronApplication | undefined;
try {
  online = await _electron.launch({
    executablePath: electron,
    args: [fixture.outdir, `--user-data-dir=${join(fixture.directory, 'online-electron')}`],
    cwd: fixture.outdir,
    env: {
      HOME: join(fixture.directory, 'home'),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
    },
    timeout: 20000,
  });
  const child = online.process();
  child.stderr?.on('data', (value) =>
    writeFileSync(join(fixture.directory, 'online-stderr.log'), String(value), { flag: 'a' }),
  );
  const end = Date.now() + 20000;
  let page: import('playwright').Page | undefined;
  while (!page) {
    page = online.windows().find((target) => target.url().endsWith('/index.html'));
    if (Date.now() > end) throw Error('online_renderer_missing');
    if (!page) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  await online.evaluate(({ dialog }, paths) => {
    const target = globalThis as unknown as {
      exportFixture: {
        paths: string[];
        dialogs: unknown[];
        pending: boolean;
        release?: () => void;
        physical: unknown[];
      };
    };
    target.exportFixture = { paths: [...paths], dialogs: [], pending: false, physical: [] };
    // The only substituted product boundary is the explicit system filename selection.
    dialog.showSaveDialog = async (
      ...input:
        | [import('electron').SaveDialogOptions]
        | [import('electron').BaseWindow, import('electron').SaveDialogOptions]
    ) => {
      const options = input.length === 2 ? input[1] : input[0];
      const path = target.exportFixture.paths.shift();
      if (!path) throw Error('unexpected_save_dialog');
      target.exportFixture.dialogs.push({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        path,
      });
      target.exportFixture.pending = true;
      await new Promise<void>((resolve) => {
        target.exportFixture.release = resolve;
      });
      target.exportFixture.pending = false;
      return { canceled: false, filePath: path };
    };
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const path = new URL(String(args[0])).pathname;
      const response = await original(...args);
      if (path.includes('/trajectory')) {
        const value = await response.clone().json();
        const request = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
        const data = value as Record<string, unknown>;
        target.exportFixture.physical.push({
          at: Date.now(),
          path,
          method: args[1]?.method ?? 'GET',
          status: response.status,
          request,
          response: path.endsWith('/evidence/read')
            ? {
                readId: data.readId,
                offset: data.offset,
                nextOffset: data.nextOffset,
                eof: data.eof,
              }
            : value,
        });
      }
      return response;
    }, original);
  }, exportPaths);
  await page.getByRole('button', { name: 'Trajectory A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Trajectory A', { exact: true }).waitFor();
  await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-trajectory-event]').length > 0 &&
      !document.querySelector('.trajectory-panel')?.textContent?.includes('正在读取'),
  );
  await page.getByRole('tab', { name: '全部事件', exact: true }).click();
  const originalCursor = await page
    .getByRole('textbox', { name: '轨迹位置', exact: true })
    .inputValue();
  await capture(page, '01-online-ready', { originalCursor });
  for (const [index, label] of ['导出事件', '导出含证据'].entries()) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const dialogEnd = Date.now() + 5000;
    while (
      !(await online.evaluate(
        () =>
          (globalThis as unknown as { exportFixture: { pending: boolean } }).exportFixture.pending,
      ))
    ) {
      if (Date.now() > dialogEnd) throw Error('save_dialog_not_reached');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await capture(page, `${index === 0 ? '02' : '04'}-save-dialog-pending`, {
      label,
      fileCreated: existsSync(exportPaths[index]!),
    });
    assert.equal(existsSync(exportPaths[index]!), false);
    await online.evaluate(() =>
      (globalThis as unknown as { exportFixture: { release: () => void } }).exportFixture.release(),
    );
    await waitForFile(exportPaths[index]!, page);
    const saved = unpack(exportPaths[index]!);
    assert.equal(saved.manifest.snapshot.upperCursor, originalCursor);
    assert.equal(saved.manifest.snapshot.storeId, fixture.storeId);
    assert.equal(saved.manifest.snapshot.sessionId, 's');
    assert(saved.events.length > 20);
    assert(saved.events.every((event) => BigInt(event.sequence) <= BigInt(originalCursor)));
    assert.equal(new Set(saved.events.map((event) => event.eventId)).size, saved.events.length);
    const evidence = saved.manifest.sections.filter(
      (section: { kind: string }) => section.kind === 'evidence',
    );
    assert.equal(index === 0 ? evidence.length === 0 : evidence.length > 0, true);
    assert.equal(
      readFileSync(exportPaths[index]!).includes(Buffer.from('NEVER_PUBLIC_CONTINUATION')),
      false,
    );
    writeFileSync(
      join(fixture.directory, `${index === 0 ? '03' : '05'}-bundle-summary.json`),
      JSON.stringify(
        {
          bytes: saved.bytes,
          manifest: saved.manifest,
          eventIds: saved.events.map((event) => event.eventId),
          evidenceCount: evidence.length,
        },
        null,
        2,
      ),
    );
    await capture(page, `${index === 0 ? '03' : '05'}-export-published`, {
      bytes: saved.bytes,
      evidenceCount: evidence.length,
    });
  }
  assert.equal(
    readdirSync(fixture.directory).some((name) => /^\.kite-trajectory-.*\.tmp$/.test(name)),
    false,
  );
  const observation = await online.evaluate(
    () => (globalThis as unknown as { exportFixture: unknown }).exportFixture,
  );
  writeFileSync(
    join(fixture.directory, 'physical-online-export.json'),
    JSON.stringify(observation, null, 2),
  );
  assert.deepEqual(facts(), before);
  assert.deepEqual(await (await fetch(`${fixture.control}/status`)).json(), {
    modelCalls: 0,
    permissionCalls: 0,
  });
  await online.close();
  online = undefined;
  assert.equal(child.exitCode, 0);
  for (const [index, path] of exportPaths.entries()) {
    const app = await _electron.launch({
      executablePath: electron,
      args: [
        fixture.outdir,
        path,
        `--user-data-dir=${join(fixture.directory, `cold-electron-${index}`)}`,
      ],
      cwd: fixture.outdir,
      env: {
        HOME: join(fixture.directory, 'home'),
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20000,
    });
    const owner = app.process();
    try {
      const page = await app.firstWindow(),
        network: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (/^https?:|^wss?:/.test(request.url())) network.push(request.url());
      });
      page.setDefaultTimeout(12000);
      await page.waitForFunction(
        () => document.querySelectorAll('[data-trajectory-event]').length > 0,
      );
      assert.deepEqual(await page.evaluate(() => Object.keys(window.kiteNative ?? {})), [
        'trajectoryFiles',
      ]);
      const saved = unpack(path);
      assert.equal(
        await page.getByRole('textbox', { name: '轨迹位置', exact: true }).inputValue(),
        saved.manifest.snapshot.upperCursor,
      );
      await capture(page, `${index === 0 ? '06' : '09'}-cold-open`, {
        path,
        evidenceIncluded: index === 1,
      });
      // The original online fixture independently observed this exact saved prefix before final output.
      const old = saved.events.find((event) => event.sequence === '23');
      assert(old, 'original cursor 23 prefix is retained in the completed snapshot');
      assert.equal(old.kind, 'model');
      assert.equal(old.phase, 'dispatching');
      assert(old.evidenceRefs.some((ref: { kind: string }) => ref.kind === 'model_output'));
      await page.getByRole('textbox', { name: '轨迹位置', exact: true }).fill(old.sequence);
      await page.getByRole('button', { name: '跳转', exact: true }).click();
      await page.waitForFunction(
        (cursor) =>
          document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value === cursor,
        old.sequence,
      );
      await page.getByRole('tab', { name: '全部事件', exact: true }).click();
      const row = page.locator(`[data-trajectory-event="${old.eventId}"]`);
      await row.locator('button.trajectory-event-heading').click();
      await row.getByRole('button', { name: /模型输出/ }).click();
      await capture(page, `${index === 0 ? '07' : '10'}-cold-material-reading`, {
        eventId: old.eventId,
        sequence: old.sequence,
      });
      if (index === 0) {
        await page
          .getByRole('region', { name: '轨迹证据', exact: true })
          .getByText('不可读取', { exact: true })
          .waitFor();
        assert.equal(await page.getByText('STREAM_PREFIX_ONE', { exact: false }).count(), 0);
      } else {
        const body = page.getByRole('region', { name: '轨迹证据', exact: true });
        await body.getByText('STREAM_PREFIX_ONE', { exact: false }).waitFor();
        assert.equal(await body.getByText('STREAM_FINAL_TAIL', { exact: false }).count(), 0);
      }
      await capture(page, `${index === 0 ? '08' : '11'}-cold-material-result`, {
        evidenceIncluded: index === 1,
        network,
      });
      assert.deepEqual(network, []);
      assert.deepEqual(facts(), before);
    } finally {
      await app.close();
      assert.equal(owner.exitCode, 0);
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(facts(), before);
  assert.deepEqual(await (await fetch(`${fixture.control}/status`)).json(), {
    modelCalls: 0,
    permissionCalls: 0,
  });
  writeFileSync(
    join(fixture.directory, 'business-invariance.json'),
    JSON.stringify({ before, after: facts(), errors }, null, 2),
  );
  writeFileSync(join(fixture.directory, 'stages.json'), JSON.stringify(stages, null, 2));
  console.log(
    JSON.stringify({ phase: 'passed', directory: fixture.directory, stages: stages.length }),
  );
} catch (error) {
  const diagnostics: Record<string, unknown> = { error: String(error), errors };
  try {
    const after = facts();
    diagnostics.businessUnchanged = JSON.stringify(after) === JSON.stringify(before);
    writeFileSync(
      join(fixture.directory, 'business-invariance.json'),
      JSON.stringify({ before, after, errors }, null, 2),
    );
    diagnostics.control = await (await fetch(`${fixture.control}/status`)).json();
    diagnostics.files = readdirSync(fixture.directory).filter(
      (name) => name.endsWith('.kite-trajectory') || /^\.kite-trajectory-.*\.tmp$/.test(name),
    );
  } catch (diagnosticError) {
    diagnostics.diagnosticError = String(diagnosticError);
  }
  if (online) {
    try {
      const observation = await online.evaluate(
        () => (globalThis as unknown as { exportFixture: unknown }).exportFixture,
      );
      writeFileSync(
        join(fixture.directory, 'physical-online-export.json'),
        JSON.stringify(observation, null, 2),
      );
    } catch (diagnosticError) {
      diagnostics.physicalObservationError = String(diagnosticError);
    }
    const page = online.windows().find((target) => target.url().endsWith('/index.html'));
    if (page) {
      await page.screenshot({ path: join(fixture.directory, 'failure.png') });
      writeFileSync(
        join(fixture.directory, 'failure.json'),
        JSON.stringify(
          {
            ...diagnostics,
            body: (await page.locator('body').innerText()).slice(-7000),
            errors,
          },
          null,
          2,
        ),
      );
    }
    await online.close();
  }
  writeFileSync(join(fixture.directory, 'stages.json'), JSON.stringify(stages, null, 2));
  throw error;
}
