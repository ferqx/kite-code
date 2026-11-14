import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { selectNativeFixtureModel } from './native-model-selection.fixture';
import {
  officeFormats,
  officePreviewObservation,
  readOfficePreviewHost,
} from './office-journey.fixture';
import { officePreviewDiagnosticEntry } from './office-preview-diagnostics.fixture';

/** Only UI actions dispatch work. A fixed model exercises production Main/Service/Shell/collector. */
export async function runOfficeJourney(options: {
  root: string;
  outdir: string;
  workspace: string;
  requestDirectory: string;
  env: Record<string, string | undefined>;
  modelRequests: () => number;
  formats?: readonly (typeof officeFormats)[number][];
}) {
  const require = createRequire(import.meta.url);
  const evidence = join(options.root, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const result: { model: string; completed: string[]; failure?: string } = {
    model: 'deterministic mock; excluded from real-model success rate',
    completed: [],
  };
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let stage = 'launch';
  try {
    app = await _electron.launch({
      executablePath: require('electron') as string,
      args: [
        officePreviewDiagnosticEntry(options.outdir, evidence),
        `--user-data-dir=${join(options.root, 'electron-profile')}`,
      ],
      env: Object.fromEntries(
        Object.entries(options.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      cwd: options.root,
      timeout: 60_000,
    });
    await app.firstWindow();
    const readyDeadline = Date.now() + 60_000;
    while (!page && Date.now() < readyDeadline) {
      page = app.windows().find((candidate) => candidate.url().includes('index.html'));
      if (!page) await Bun.sleep(50);
    }
    if (!page) throw Error('production_renderer_not_ready');
    page.setDefaultTimeout(60_000);
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    const card = (name: string) =>
      page!.locator('.output-file-card').filter({
        has: page!.getByRole('button', { name: `打开 ${name}`, exact: true }),
      });
    const input = () => page!.getByRole('textbox', { name: '当前会话私有草稿' });
    const send = async (prompt: string, output: string) => {
      const before = options.modelRequests();
      await input().fill(prompt);
      await page!.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
      const publicationDeadline = Date.now() + 180_000;
      while (!(await card(output).first().isVisible()) && Date.now() < publicationDeadline) {
        if (await page!.getByText('注释草稿尚未确认保存', { exact: false }).isVisible())
          throw Error('draft_save_unconfirmed_blocks_submission');
        await Bun.sleep(50);
      }
      assert.equal(await card(output).first().isVisible(), true, `output_not_published: ${output}`);
      await page!
        .getByRole('button', { name: '停止任务', exact: true })
        .waitFor({ state: 'hidden', timeout: 60_000 });
      assert.equal(await card(output).count(), 1, 'one published output per explicit action');
      // Card publication may precede the final model response; wait on the observable request count.
      const deadline = Date.now() + 60_000;
      while (options.modelRequests() < before + 2 && Date.now() < deadline) await Bun.sleep(50);
      assert.equal(options.modelRequests(), before + 2, 'no extra inference or blind tool replay');
    };
    const preview = async (name: string, expected: string) => {
      const existing = new Set(app!.windows());
      await card(name)
        .getByRole('button', { name: `打开 ${name}`, exact: true })
        .click();
      let surface: Page | undefined;
      let sawPreparing = false;
      let contentSeen = false;
      const fail = (code: string) => {
        writeFileSync(
          join(evidence, 'preview-observation.json'),
          JSON.stringify({ stage, code, sawPreparing, contentSeen }),
        );
        throw Error(code);
      };
      const deadline = Date.now() + 60_000;
      while (!surface && Date.now() < deadline) {
        const { targetMatches, preparing, failed } = await readOfficePreviewHost(page!, name);
        const host = officePreviewObservation({
          targetMatches,
          preparing,
          failed,
          sawPreparing,
          contentVisible: false,
          word: false,
          pagination: null,
        });
        sawPreparing = host.sawPreparing;
        if (host.outcome === 'failed') fail('preview_host_failed');
        for (const candidate of app!.windows()) {
          if (
            !existing.has(candidate) &&
            candidate.url().startsWith('kite-preview:') &&
            (await candidate
              .getByText(expected, { exact: false })
              .first()
              .isVisible()
              .catch(() => false))
          ) {
            contentSeen = true;
            const pagination = await candidate
              .locator('html')
              .getAttribute('data-kite-word-pagination-state');
            const observed = officePreviewObservation({
              targetMatches,
              preparing,
              failed,
              sawPreparing,
              contentVisible: true,
              word: name.endsWith('.docx'),
              pagination,
            });
            if (observed.outcome === 'pagination-unavailable')
              fail('preview_pagination_unavailable');
            if (observed.outcome === 'ready') {
              surface = candidate;
              break;
            }
          }
        }
        if (!surface) await Bun.sleep(50);
      }
      if (!surface)
        return fail(contentSeen ? 'preview_pagination_timeout' : 'preview_content_not_visible');
      await surface.screenshot({ path: join(evidence, `${stage}-preview.png`) });
      // WebContentsView is not included in renderer screenshots. Retain each surface separately.
      await page!.screenshot({ path: join(evidence, `${stage}-client.png`) });
    };
    for (const format of options.formats ?? officeFormats) {
      stage = `${format}-generate`;
      console.log(`Office E2E: ${stage}`);
      await page.getByRole('button', { name: `Office ${format}`, exact: true }).click();
      await page.getByText('从一个想法开始', { exact: true }).waitFor({ state: 'visible' });
      await selectNativeFixtureModel(page, 'office-fixture');
      const permission = page.getByRole('button', { name: '权限：自动审核', exact: true });
      if (await permission.count()) {
        await permission.click();
        await page.getByRole('menuitemradio', { name: /工作区内修改/ }).click();
        await page.getByRole('menu').waitFor({ state: 'hidden' });
        await page.waitForFunction(
          () =>
            !document.querySelector('[data-permission-pending="true"]') &&
            getComputedStyle(document.body).pointerEvents !== 'none',
        );
      }
      await send(`Generate fixture ${format}.`, `generated.${format}`);
      await preview(`generated.${format}`, 'E2E original value');
      result.completed.push(stage);
      stage = `${format}-revise`;
      await card(`generated.${format}`)
        .getByRole('button', { name: `generated.${format} 的更多操作`, exact: true })
        .click();
      await page.screenshot({ path: join(evidence, `${format}-file-menu.png`) });
      const countBeforeDismiss = options.modelRequests();
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      const more = card(`generated.${format}`).getByRole('button', {
        name: `generated.${format} 的更多操作`,
        exact: true,
      });
      assert.equal(await more.evaluate((element) => element === document.activeElement), true);
      assert.equal(options.modelRequests(), countBeforeDismiss, 'menu dismissal is read-only');
      await more.click();
      await page.getByRole('menuitem', { name: '继续修改', exact: true }).click();
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      await send(`Revise fixture ${format}.`, `revised.${format}`);
      await preview(`revised.${format}`, 'E2E revised value');
      result.completed.push(stage);
      stage = `${format}-local-file`;
      const source = join(options.workspace, `input.${format}`);
      const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
      const beforeHash = hash();
      await page.getByRole('button', { name: '添加附件', exact: true }).click();
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('menuitem', { name: '添加文件', exact: true }).click();
      await (await chooser).setFiles(source);
      await send(`Process fixture ${format}.`, `processed.${format}`);
      await preview(`processed.${format}`, 'E2E revised value');
      const envelope =
        '\n\nAttached file references (user-provided data; paths do not grant permissions):\n';
      const references = readdirSync(options.requestDirectory).flatMap((name) => {
        const request = JSON.parse(readFileSync(join(options.requestDirectory, name), 'utf8'));
        return request.messages.filter(
          (message: { role: string; content?: unknown }) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith(`Process fixture ${format}.${envelope}`),
        );
      });
      assert.ok(references.length > 0, 'selected local input reached the actual model request');
      for (const reference of references)
        assert.deepEqual(JSON.parse(reference.content.split(envelope)[1]), [
          { name: `input.${format}`, uri: pathToFileURL(source).href },
        ]);
      assert.equal(
        hash(),
        beforeHash,
        'processing a copy must leave the selected original unchanged',
      );
      result.completed.push(stage);
    }
  } catch (error) {
    result.failure = `${stage}: ${String(error)}`;
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(evidence, 'failure-client.png') }).catch(() => {});
      writeFileSync(
        join(evidence, 'failure-client.txt'),
        await page
          .locator('body')
          .innerText()
          .catch(() => 'unavailable'),
      );
    }
    throw error;
  } finally {
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    if (page && !page.isClosed())
      await page
        .context()
        .tracing.stop({ path: join(evidence, 'trace.zip') })
        .catch(() => {});
    if (app) await app.close();
  }
}
