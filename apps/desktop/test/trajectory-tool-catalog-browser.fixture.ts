import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { writeFixtureFile } from '../../../scripts/tooling/files';
import { trajectoryToolCatalogData } from './trajectory-tool-catalog-data.fixture';

/** A focused directory pass, intentionally separate from the workbench matrix. */
export async function verifyTrajectoryToolCatalog(input: {
  page: Page;
  artifact: string;
  verification: Record<string, unknown>;
  openTrajectory: (page: Page, suffix: string) => Promise<void>;
}) {
  const { page, artifact, verification, openTrajectory } = input;
  await page.emulateMedia({ colorScheme: 'dark' });
  const fixture = trajectoryToolCatalogData();
  const detail = page.getByRole('region', { name: '选中节点详情', exact: true });
  await openTrajectory(page, '?semantic=1&toolCatalog=1');
  await page
    .locator(
      '[data-trajectory-row="execution:semantic-tool-catalog-model:part:system"] .trajectory-node-select',
    )
    .click();
  await detail.getByRole('tab', { name: '工具', exact: true }).click();
  const catalog = detail.getByLabel('本次请求的工具目录', { exact: true });
  await catalog.waitFor();
  const items = catalog.locator('details.trajectory-request-tool');
  const visibleItems = catalog.locator('details.trajectory-request-tool:visible');
  assert.equal(await items.count(), 21);
  assert.equal(await detail.getByRole('tab', { name: '原始内容', exact: true }).count(), 0);
  assert.ok(
    !(await detail.innerText()).includes(fixture.contentVersion),
    'the long source version must not occupy the visible directory',
  );
  assert.ok(
    await detail
      .locator('[title]')
      .evaluateAll(
        (elements, version) =>
          elements.some((element) => element.getAttribute('title')?.includes(version)),
        fixture.contentVersion,
      ),
    'the exact saved version remains discoverable in its title',
  );
  const search = catalog.locator('input').first();
  await search.waitFor();
  const reads = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { trajectoryFixture: { requests: { method: string }[] } }
        ).trajectoryFixture.requests.filter((request) =>
          request.method.startsWith('trajectory.evidence.'),
        ).length,
    );
  await page.waitForTimeout(150);
  const beforeSearch = await reads();
  await search.fill('mcp__observability');
  assert.equal(await visibleItems.count(), 1);
  assert.ok((await visibleItems.first().innerText()).includes(fixture.tools[16]!.id));
  await search.fill('审批反馈');
  assert.equal(await visibleItems.count(), 1);
  assert.ok((await visibleItems.first().innerText()).includes('question.ask'));
  await search.fill('nothing-matches-this-tool-catalog');
  assert.equal(await visibleItems.count(), 0);
  assert.equal(await detail.getByLabel('原公开 JSON', { exact: true }).count(), 0);
  await search.fill('');
  assert.equal(await visibleItems.count(), 21);
  assert.equal(
    await reads(),
    beforeSearch,
    'local directory search must not reopen or read materials',
  );
  const geometry = () =>
    page.evaluate(() => {
      const panel = document.querySelector('.trajectory-panel')!;
      const directory = document.querySelector('[aria-label="本次请求的工具目录"]')!;
      const summaries = [
        ...directory.querySelectorAll<HTMLElement>('details.trajectory-request-tool > summary'),
      ];
      const first = summaries[0]!,
        name = first.querySelector<HTMLElement>('.trajectory-request-tool-name')!,
        description = first.querySelector<HTMLElement>('.trajectory-request-tool-description')!;
      const viewport = document.querySelector<HTMLElement>('[aria-label="详情正文"]')!;
      return {
        panelWidth: panel.getBoundingClientRect().width,
        directoryWidth: directory.getBoundingClientRect().width,
        detailWidth: document.querySelector('.trajectory-detail')!.getBoundingClientRect().width,
        summaryHeights: summaries.map((value) => value.getBoundingClientRect().height),
        nameY: name.getBoundingClientRect().y,
        descriptionY: description.getBoundingClientRect().y,
        nameFont: getComputedStyle(name).fontFamily,
        horizontalOverflow: viewport.scrollWidth - viewport.clientWidth,
      };
    });
  const narrow = await geometry();
  assert.ok(narrow.panelWidth <= 330);
  assert.ok(
    narrow.descriptionY > narrow.nameY,
    'a narrow directory puts its secondary description on the next line',
  );
  assert.ok(
    narrow.horizontalOverflow <= 1,
    'long public tool names must not create horizontal scrolling',
  );
  assert.equal(
    await detail.getByLabel('原公开 JSON', { exact: true }).count(),
    0,
    'closed rows must not eagerly mount every schema',
  );
  await search.blur();
  await detail.getByLabel('详情正文', { exact: true }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(artifact, 'tool-catalog-narrow-collapsed.png') });
  await detail.screenshot({
    path: path.join(artifact, 'tool-catalog-narrow-collapsed-detail.png'),
  });
  const first = items.first();
  await first.locator('summary').click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    fixture.tools[0]!.inputSchema,
  );
  assert.equal(
    await detail.getByLabel('原公开 JSON', { exact: true }).count(),
    1,
    'one outer-row expansion mounts exactly its original schema',
  );
  await search.fill('nothing-matches-this-tool-catalog');
  assert.equal(await visibleItems.count(), 0);
  await search.fill('');
  assert.equal(await first.getAttribute('open'), '');
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    fixture.tools[0]!.inputSchema,
  );
  await search.blur();
  await detail.getByLabel('详情正文', { exact: true }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(artifact, 'tool-catalog-narrow-expanded.png') });
  await detail.screenshot({ path: path.join(artifact, 'tool-catalog-narrow-expanded-detail.png') });
  await first.locator('summary').click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor({ state: 'hidden' });
  const longName = items.nth(16);
  await longName.locator('summary').scrollIntoViewIfNeeded();
  await longName.locator('summary').click();
  await longName.locator('.trajectory-request-tool-body').waitFor();
  const expandedName = await longName
    .locator('.trajectory-request-tool-name')
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        name: element.textContent,
        title: element.getAttribute('title'),
        textLines: new Set([...range.getClientRects()].map((rect) => rect.y)).size,
      };
    });
  assert.equal(expandedName.name, fixture.tools[16]!.id);
  assert.equal(expandedName.title, fixture.tools[16]!.id);
  assert.ok(
    expandedName.textLines > 1,
    'an expanded long public name wraps instead of disappearing behind ellipsis',
  );
  assert.ok((await geometry()).horizontalOverflow <= 1);
  await page.screenshot({ path: path.join(artifact, 'tool-catalog-narrow-long-name.png') });
  await detail.screenshot({
    path: path.join(artifact, 'tool-catalog-narrow-long-name-detail.png'),
  });
  await longName.locator('summary').click();
  const longDescription = items.nth(17);
  await longDescription.locator('summary').scrollIntoViewIfNeeded();
  await longDescription.locator('summary').click();
  const fullDescription = longDescription.locator('.trajectory-request-tool-body');
  await fullDescription.waitFor();
  assert.equal(
    ((await fullDescription.innerText()).match(/返回准确来源和匹配段落/g) ?? []).length,
    24,
    'expanded descriptions retain the complete original content exactly once',
  );
  assert.equal(await longDescription.locator('.trajectory-request-tool-description').count(), 0);
  await longDescription.locator('summary').click();
  const noDescription = items.nth(19);
  await noDescription.locator('summary').scrollIntoViewIfNeeded();
  await noDescription.locator('summary').click();
  await noDescription.locator('.trajectory-request-tool-body').waitFor();
  assert.equal(((await noDescription.innerText()).match(/未保存工具描述/g) ?? []).length, 1);
  await noDescription.locator('summary').click();
  const last = items.last();
  await last.locator('summary').scrollIntoViewIfNeeded();
  await last.locator('summary').click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    fixture.tools.at(-1)!.inputSchema,
  );
  await last.locator('summary').click();
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.waitForTimeout(150);
  const outer = page.locator('#details-resize[role="separator"]');
  await outer.focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(150);
  await page
    .locator(
      '[data-trajectory-row="execution:semantic-tool-catalog-model:part:system"] .trajectory-node-select',
    )
    .click();
  await detail.getByRole('tab', { name: '工具', exact: true }).click();
  const handle = page.getByRole('separator', { name: '调整轨迹详情宽度', exact: true });
  const rect = await handle.boundingBox();
  assert.ok(rect);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 100);
  await page.mouse.down();
  await page.mouse.move(rect.x - 320, rect.y + 100, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await detail.getByLabel('详情正文', { exact: true }).evaluate((element) => {
    element.scrollTop = 0;
  });
  const wide = await geometry();
  assert.ok(wide.directoryWidth >= 600, 'the wide case must actually exercise a wide directory');
  assert.ok(
    Math.abs(wide.descriptionY - wide.nameY) <= 2,
    'wide directory names and secondary descriptions share a row',
  );
  assert.ok(wide.horizontalOverflow <= 1);
  await page.screenshot({ path: path.join(artifact, 'tool-catalog-wide-collapsed.png') });
  await detail.screenshot({ path: path.join(artifact, 'tool-catalog-wide-collapsed-detail.png') });
  await first.locator('summary').click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifact, 'tool-catalog-wide-expanded.png') });
  await detail.screenshot({ path: path.join(artifact, 'tool-catalog-wide-expanded-detail.png') });
  verification.toolCatalog = {
    controlledFixture: true,
    tools: 21,
    sourceVersionLength: fixture.contentVersion.length,
    sourceVersionHiddenButAvailableOnTitle: true,
    searchByNameAndDescription: true,
    searchReads: 0,
    emptyResult: true,
    lazyExactSchema: true,
    expandedLongNameWraps: true,
    expansionSurvivesSearch: true,
    completeDescriptionShownOnce: true,
    missingDescriptionIsExplicit: true,
    narrow,
    wide,
  };
  await writeFixtureFile(
    path.join(artifact, 'tool-catalog-verification.json'),
    JSON.stringify(verification, null, 2),
  );
}
