import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';

/** One continuous, typed detail-reading pass using the existing exact semantic materials. */
export async function verifyTrajectoryDetailLayout(input: {
  page: Page;
  artifact: string;
  verification: Record<string, unknown>;
  openTrajectory: (page: Page, suffix: string) => Promise<void>;
}) {
  const { page, artifact, verification, openTrajectory } = input;
  await page.emulateMedia({ colorScheme: 'dark' });
  await openTrajectory(page, '?semantic=1');
  const detail = page.getByRole('region', { name: '选中节点详情', exact: true });
  const assertQuietChrome = async () => {
    assert.equal(await page.locator('.trajectory-run-count').count(), 0);
    assert.equal(await page.getByText('事实覆盖尚未完整核实。', { exact: true }).count(), 0);
    assert.match(
      (await page.locator('.trajectory-timeline-footnote').innerText()).trim(),
      /^(观测时间|事件顺序)$/u,
    );
  };
  await assertQuietChrome();
  const metadataSearch = page.getByRole('textbox', { name: '搜索元数据', exact: true });
  await metadataSearch.fill('src/auth/session.ts');
  await page.waitForFunction(() =>
    document.querySelector('.trajectory-tree-heading')?.textContent?.includes('找到'),
  );
  await assertQuietChrome();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.locator('[data-trajectory-row="execution:semantic-model:part:thinking"]').waitFor();
  for (const name of ['轮次', '调用', '子调用']) {
    const toggle = page.getByRole('button', { name, exact: true });
    await toggle.click();
    await page.waitForTimeout(80);
    if (name === '子调用')
      await page
        .locator('[data-trajectory-row$="execution:semantic-child-model:part:thinking"]')
        .waitFor();
    await assertQuietChrome();
    await toggle.click();
    await page.waitForTimeout(80);
    await assertQuietChrome();
  }
  const rows = () =>
    page
      .locator('[data-trajectory-row]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-trajectory-row')),
      );
  const initialFacts = await page.evaluate(() =>
    JSON.stringify(
      (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture.facts,
    ),
  );
  const visits: unknown[] = [];
  const transitions: unknown[] = [];
  const capture = async (name: string, scrollToEnd = false) => {
    await detail.getByLabel('详情正文', { exact: true }).evaluate((element, end) => {
      element.scrollTop = end ? element.scrollHeight : 0;
    }, scrollToEnd);
    const geometry = await detail.evaluate((element) => {
      const viewport = element.querySelector<HTMLElement>('[aria-label="详情正文"]')!;
      return {
        width: element.getBoundingClientRect().width,
        overflow: viewport.scrollWidth - viewport.clientWidth,
        text: (element as HTMLElement).innerText,
      };
    });
    assert.ok(geometry.overflow <= 1, `${name}: detail overflows horizontally`);
    assert.ok(
      !geometry.text.includes('sha256:'),
      `${name}: internal source versions occupy visible content`,
    );
    assert.equal(await detail.getByRole('tab', { name: '原始内容', exact: true }).count(), 0);
    await detail.screenshot({ path: path.join(artifact, `detail-layout-${name}.png`) });
    visits.push({ name, ...geometry });
  };
  const select = async (id: string, tab: string) => {
    const target = page.locator(`[data-trajectory-row="${id}"] .trajectory-node-select`);
    await target.scrollIntoViewIfNeeded();
    if ((await page.locator('.trajectory-panel').boundingBox())!.width <= 330)
      await page.evaluate(() => {
        const state = window as unknown as {
          detailLayoutFrames: unknown[];
          detailLayoutSampling: boolean;
        };
        state.detailLayoutFrames = [];
        state.detailLayoutSampling = true;
        const sample = () => {
          const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
          const box = viewport.getBoundingClientRect();
          state.detailLayoutFrames.push({
            scrollTop: viewport.scrollTop,
            scrollLeft: viewport.scrollLeft,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            rows: [...document.querySelectorAll<HTMLElement>('[data-trajectory-row]')].map(
              (row) => ({
                id: row.dataset.trajectoryRow!,
                top: row.getBoundingClientRect().top - box.top,
                height: row.getBoundingClientRect().height,
              }),
            ),
          });
          if (state.detailLayoutSampling) requestAnimationFrame(sample);
        };
        sample();
      });
    await target.click();
    await detail.waitFor();
    await detail.getByRole('tab', { name: tab, exact: true }).click();
  };
  const close = async () => {
    await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    const frames = await page.evaluate(() => {
      const state = window as unknown as {
        detailLayoutFrames?: {
          scrollTop: number;
          scrollLeft: number;
          x: number;
          y: number;
          width: number;
          height: number;
          rows: { id: string; top: number; height: number }[];
        }[];
        detailLayoutSampling?: boolean;
      };
      if (!state.detailLayoutSampling) return [];
      state.detailLayoutSampling = false;
      return state.detailLayoutFrames!;
    });
    if (frames.length) {
      const before = frames[0]!;
      for (const frame of frames) {
        for (const dimension of ['scrollTop', 'scrollLeft', 'x', 'y', 'width', 'height'] as const)
          assert.ok(
            Math.abs(frame[dimension] - before[dimension]) <= 1,
            `narrow detail transition moved log ${dimension}`,
          );
        assert.deepEqual(
          frame.rows.map((row) => row.id),
          before.rows.map((row) => row.id),
        );
        frame.rows.forEach((row, index) => {
          assert.ok(
            Math.abs(row.top - before.rows[index]!.top) <= 1 &&
              Math.abs(row.height - before.rows[index]!.height) <= 1,
            `narrow detail transition moved ${row.id}`,
          );
        });
      }
      transitions.push(frames);
    }
  };

  await select('execution:semantic-model:part:system', '系统提示词');
  await detail
    .getByText('准确的系统指令：第 4 次请求。保持权限校验并记录验证结论。', { exact: true })
    .waitFor();
  await capture('system-narrow');
  await detail.getByRole('tab', { name: '工具', exact: true }).click();
  const catalog = detail.getByLabel('本次请求的工具目录', { exact: true });
  await catalog.getByText('files.read', { exact: true }).waitFor();
  await catalog.locator('details.trajectory-request-tool > summary').click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    { type: 'object', properties: { path: { type: 'string' } } },
  );
  await capture('tools-narrow');
  await close();

  await select('message:semantic-user', '内容');
  await detail.getByText('登录成功后仍跳回登录页，请检查并修复。', { exact: true }).waitFor();
  assert.deepEqual(await detail.getByRole('tab').allTextContents(), ['内容']);
  await capture('user-narrow');
  await close();

  await select('execution:semantic-model:part:thinking', '思考');
  await detail
    .getByText('公开思考：先检查会话恢复的等待时机，再核对路由守卫的权限分支。', { exact: true })
    .waitFor();
  await capture('thinking-narrow');
  const requestMetrics = detail.getByLabel('本次模型请求', { exact: true });
  const metricText = (await requestMetrics.innerText()).replaceAll(',', '');
  for (const value of ['gpt-6-luna', '8086', '320', '2048']) assert.ok(metricText.includes(value));
  const requestTiming = detail.getByLabel('请求计时', { exact: true });
  await requestTiming.getByText('已记录请求区间', { exact: true }).waitFor();
  assert.ok((await requestTiming.innerText()).includes('250 毫秒'));
  const timingRecords = requestTiming.locator('details.trajectory-timing-records');
  assert.equal(await timingRecords.getAttribute('open'), null);
  const order = await detail.evaluate((element) => {
    const metrics = element.querySelector('.trajectory-detail-summary')!;
    const material = element.querySelector('.trajectory-material')!;
    const timing = element.querySelector('.trajectory-detail-timing')!;
    return {
      metricsBeforeContent: !!(
        metrics.compareDocumentPosition(material) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      timingAfterContent: !!(
        material.compareDocumentPosition(timing) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
    };
  });
  assert.deepEqual(order, { metricsBeforeContent: true, timingAfterContent: true });
  await timingRecords.locator('summary').click();
  await requestTiming.getByText('开始记录', { exact: true }).waitFor();
  await requestTiming.getByText('当前记录', { exact: true }).waitFor();
  await capture('request-timing-expanded-narrow', true);
  await detail.getByRole('tab', { name: '请求信息', exact: true }).click();
  await detail.getByText('gpt-6-luna', { exact: true }).first().waitFor();
  const requestText = (await detail.innerText()).replaceAll(',', '');
  for (const tokens of ['8086', '320', '2048'])
    assert.ok(requestText.includes(tokens), `missing exact request usage ${tokens}`);
  assert.ok(
    !/TTFT|首\s*token|首字延迟/iu.test(requestText),
    'the fixture has no first-token timing observation',
  );
  await capture('request-narrow');
  await close();

  await select('execution:semantic-read', '概述');
  await capture('tool-overview-narrow');
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    { path: 'src/auth/session.ts', from_line: 1, to_line: 120 },
  );
  await capture('tool-parameters-narrow');
  await detail.getByRole('tab', { name: '结果', exact: true }).click();
  await detail.getByText(/export async function restoreSession/).waitFor();
  await capture('tool-result-narrow');
  await close();

  await select('execution:semantic-shell-launch', '概述');
  assert.ok(
    (await detail.getByLabel('命令与观察结果', { exact: true }).innerText()).includes('运行中'),
  );
  await capture('shell-overview-narrow');
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.equal(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()).command,
    'npm test -- auth/session.test.ts',
  );
  await detail.getByRole('tab', { name: '结果', exact: true }).click();
  await detail.getByText('认证测试正在运行。', { exact: true }).waitFor();
  await capture('shell-result-narrow');
  await close();

  await select('execution:semantic-spawn', '概述');
  const childState = await detail.getByLabel('子 Agent 工作与返回', { exact: true }).innerText();
  for (const state of ['已受理', '已完成', '父级已接收']) assert.ok(childState.includes(state));
  await capture('child-narrow');
  assert.deepEqual(await detail.getByRole('tab').allTextContents(), ['概述', '预览']);
  await detail.getByRole('tab', { name: '预览', exact: true }).click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.equal(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()).name,
    '回归检查',
  );
  await detail.getByText('权限拒绝逻辑仍保留，修复范围符合要求。', { exact: true }).waitFor();
  await capture('child-result-narrow');
  await close();

  await select('interaction:semantic-approval', '概述');
  await capture('approval-overview-narrow');
  await detail.getByRole('tab', { name: '预览', exact: true }).click();
  await detail.getByText('已批准', { exact: true }).waitFor();
  await capture('approval-content-narrow');
  await close();

  await select('execution:semantic-compress', '概述');
  const compression = (await detail.innerText()).replaceAll(',', '');
  assert.match(compression, /12200\s*→\s*2600\s*Token/u);
  assert.ok(compression.includes('78.7%'));
  await capture('compression-overview-narrow');
  await detail.getByRole('tab', { name: '预览', exact: true }).click();
  await detail.getByText('登录守卫已等待会话恢复。', { exact: true }).waitFor();
  await capture('compression-content-narrow');
  await close();

  await select('message:semantic-reply', '内容');
  await detail.getByText('修复已写入，权限检查保留；后台测试仍在运行。', { exact: true }).waitFor();
  await capture('reply-narrow');
  await close();

  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const outer = await page.locator('#details-resize[role="separator"]').boundingBox();
  assert.ok(outer);
  await page.mouse.move(outer.x + outer.width / 2, outer.y + 120);
  await page.mouse.down();
  await page.mouse.move(250, outer.y + 120, { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector('.trajectory-workspace')?.getAttribute('data-detail-layout') ===
      'docked',
  );
  const beforeRows = await rows();
  await select('execution:semantic-model:part:thinking', '请求信息');
  await detail.getByText('gpt-6-luna', { exact: true }).first().waitFor();
  await capture('request-wide');
  await close();
  assert.deepEqual(await rows(), beforeRows, 'wide detail open/close changes log row identities');
  await select('execution:semantic-read', '结果');
  await detail.getByText(/export async function restoreSession/).waitFor();
  await capture('tool-result-wide');
  await close();
  assert.deepEqual(await rows(), beforeRows);

  const original = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trajectoryFixture: {
          facts: {
            eventId: string;
            evidenceRefs: { evidenceId: string; contentVersion: string }[];
          }[];
          requests: {
            method: string;
            request: { eventId?: string; evidenceId?: string; contentVersion?: string };
          }[];
        };
      }
    ).trajectoryFixture;
    return {
      facts: JSON.stringify(fixture.facts),
      opens: fixture.requests
        .filter((request) => request.method === 'trajectory.evidence.open')
        .map(({ request }) => ({
          ...request,
          exact: fixture.facts.some(
            (event) =>
              event.eventId === request.eventId &&
              event.evidenceRefs.some(
                (reference) =>
                  reference.evidenceId === request.evidenceId &&
                  reference.contentVersion === request.contentVersion,
              ),
          ),
        })),
    };
  });
  assert.equal(original.facts, initialFacts);
  assert.ok(original.opens.length > 0 && original.opens.every((open) => open.exact));
  assert.ok(
    !original.opens.some((open) => open.evidenceId?.startsWith('semantic-shell-observe-')),
    'opening command results eagerly reads observation bodies',
  );

  const responsive = [];
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const targetWidth of [300, 500, 1000]) {
      await page.setViewportSize({
        width: targetWidth === 300 ? 1440 : targetWidth === 500 ? 1800 : 2800,
        height: 1000,
      });
      await page.goto(new URL('?semantic=1', page.url()).href);
      await page.evaluate(() => {
        const facts = (
          window as unknown as {
            trajectoryFixture: {
              facts: {
                kind: string;
                executionId?: string;
                phase: string;
                attributes: { usage?: Record<string, string> };
              }[];
            };
          }
        ).trajectoryFixture.facts;
        const event = facts.find(
          (event) =>
            event.kind === 'model' &&
            event.executionId === 'semantic-retry-3' &&
            event.phase === 'completed',
        )!;
        // Explicit controlled original usage, never reconstructed by production or the verifier.
        event.attributes.usage = { ...event.attributes.usage, totalTokens: '8406' };
      });
      await page.getByRole('button', { name: '标签页', exact: true }).click();
      await page
        .getByRole('region', { name: '工具', exact: true })
        .getByRole('button', { name: '执行轨迹', exact: true })
        .click();
      await page.locator('.trajectory-panel [role="treegrid"]').waitFor();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (targetWidth > 300) {
        const outer = await page.locator('#details-resize[role="separator"]').boundingBox();
        assert.ok(outer);
        await page.mouse.move(outer.x + outer.width / 2, outer.y + 120);
        await page.mouse.down();
        await page.mouse.move(250, outer.y + 120, { steps: 20 });
        await page.mouse.up();
        await page.waitForFunction(
          () =>
            document.querySelector('.trajectory-workspace')?.getAttribute('data-detail-layout') ===
            'docked',
        );
      }
      await select('execution:semantic-model:part:thinking', '思考');
      await detail
        .getByText('公开思考：先检查会话恢复的等待时机，再核对路由守卫的权限分支。', {
          exact: true,
        })
        .waitFor();
      if (targetWidth === 1000) {
        const width = (await detail.boundingBox())!.width;
        const handle = await page
          .getByRole('separator', { name: '调整轨迹详情宽度', exact: true })
          .boundingBox();
        assert.ok(handle);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
        await page.mouse.down();
        await page.mouse.move(handle.x - (targetWidth - width), handle.y + 120, { steps: 20 });
        await page.mouse.up();
      }
      await page.waitForFunction(
        (width) =>
          Math.abs(
            document.querySelector('.trajectory-detail')!.getBoundingClientRect().width - width,
          ) <= 35,
        targetWidth,
      );
      await detail.getByLabel('详情正文', { exact: true }).evaluate((element) => {
        element.scrollTop = 0;
      });
      const geometry = await detail.evaluate((element) => {
        const viewport = element.querySelector<HTMLElement>('[aria-label="详情正文"]')!;
        const summary = element.querySelector<HTMLElement>('.trajectory-detail-summary')!;
        const usage = summary.querySelector<HTMLElement>('.trajectory-request-usage')!;
        const identity = summary.querySelector<HTMLElement>('.trajectory-request-identity')!;
        const thought = element.querySelector<HTMLElement>('.trajectory-thinking-content')!;
        const timing = element.querySelector<HTMLElement>('.trajectory-detail-timing')!;
        const box = (target: Element) => {
          const rect = target.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            bottom: rect.bottom,
          };
        };
        const font = (target: Element) => {
          const style = getComputedStyle(target);
          return { size: parseFloat(style.fontSize), weight: style.fontWeight, color: style.color };
        };
        return {
          theme: document.documentElement.dataset.theme,
          detail: box(element),
          viewport: box(viewport),
          summary: box(summary),
          usage: box(usage),
          identity: box(identity),
          thought: box(thought),
          timing: box(timing),
          timingValueFont: font(timing.querySelector('.trajectory-timing-line dd')!),
          columns: getComputedStyle(usage).gridTemplateColumns.split(' ').filter(Boolean).length,
          overflow: viewport.scrollWidth - viewport.clientWidth,
          cells: [...usage.querySelectorAll('.trajectory-usage-item')].map((item) => ({
            label: item.querySelector('dt')!.textContent,
            value: item.querySelector('dd')!.textContent,
            box: box(item),
            labelFont: font(item.querySelector('dt')!),
            valueFont: font(item.querySelector('dd')!),
          })),
          model: box(identity.querySelector('.trajectory-request-model')!),
          state: box(identity.querySelector('.trajectory-request-state')!),
          thoughtText: thought.innerText,
          thoughtHeading: thought.querySelector('h4,h5')?.textContent,
        };
      });
      verification.detailLayoutResponsiveInProgress = { colorScheme, targetWidth, geometry };
      await detail.screenshot({
        path: path.join(artifact, `detail-layout-thinking-${colorScheme}-${targetWidth}.png`),
      });
      assert.equal(geometry.theme, colorScheme);
      assert.equal(
        geometry.columns,
        targetWidth < 620 ? 2 : geometry.cells.length,
        `${colorScheme}/${targetWidth}: token usage does not form the expected columns`,
      );
      assert.deepEqual(
        geometry.cells.map((cell) => cell.value),
        ['8086', '320', '2048', '8406'],
      );
      for (const cell of geometry.cells)
        assert.ok(
          cell.valueFont.size >= cell.labelFont.size + 2,
          `${colorScheme}/${targetWidth}: ${cell.label} has no numeric hierarchy`,
        );
      assert.ok(
        Math.abs(geometry.model.y - geometry.state.y) <= 5,
        `${colorScheme}/${targetWidth}: model and status do not share one summary line`,
      );
      assert.ok(
        geometry.summary.height <= 200 && geometry.summary.height < geometry.viewport.height * 0.3,
        `${colorScheme}/${targetWidth}: request summary consumes the reading area`,
      );
      assert.ok(
        geometry.thought.y >= geometry.summary.bottom,
        `${colorScheme}/${targetWidth}: thought content is not a separate section`,
      );
      assert.equal(
        geometry.thoughtHeading,
        '思考内容',
        `${colorScheme}/${targetWidth}: thought section has no readable heading`,
      );
      assert.ok(
        geometry.thought.y < geometry.viewport.bottom &&
          geometry.thoughtText.includes('公开思考：'),
        `${colorScheme}/${targetWidth}: summary pushes thought content outside the initial view`,
      );
      assert.ok(geometry.overflow <= 1, `${colorScheme}/${targetWidth}: horizontal overflow`);
      assert.ok(
        geometry.timing.height <= 80 &&
          geometry.timingValueFont.size < geometry.cells[0]!.valueFont.size,
        `${colorScheme}/${targetWidth}: timing competes with the primary metrics`,
      );
      for (const section of [geometry.identity, geometry.usage, geometry.thought, geometry.timing])
        assert.ok(
          Math.abs(section.x - geometry.summary.x) <= 1,
          `${colorScheme}/${targetWidth}: sections do not share the same left boundary`,
        );
      responsive.push({ controlledFourMetricCase: true, colorScheme, targetWidth, ...geometry });
      await close();
    }
  }

  // The partial-coverage disclosure uses only this isolated bridge's existing request surface.
  await page.goto(new URL('?semantic=1', page.url()).href);
  await page.evaluate(() => {
    const bridge = (
      window as unknown as {
        trajectoryFixture: { bridge: { request(input: { method: string }): Promise<unknown> } };
      }
    ).trajectoryFixture.bridge;
    const request = bridge.request.bind(bridge);
    bridge.request = async (input) => {
      const result = (await request(input)) as {
        trajectory?: { integrity?: unknown; historyCoverage?: { integrity: unknown } };
      };
      const partial = {
        facts: 'partial',
        identityConfidence: 'verified_origin',
        reasons: ['incomplete_prefix'],
      };
      if (input.method === 'trajectory.open' && result.trajectory?.historyCoverage)
        result.trajectory.historyCoverage.integrity = partial;
      if (input.method === 'trajectory.events' && result.trajectory)
        result.trajectory.integrity = partial;
      return result;
    };
  });
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await page
    .getByRole('region', { name: '工具', exact: true })
    .getByRole('button', { name: '执行轨迹', exact: true })
    .click();
  await page.locator('.trajectory-panel [role="treegrid"]').waitFor();
  await assertQuietChrome();
  await page.getByRole('button', { name: '更多轨迹操作', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '轨迹信息', exact: true }).click();
  await page.getByText('事实覆盖尚未完整核实。', { exact: true }).waitFor();
  await page
    .locator('.trajectory-panel')
    .screenshot({ path: path.join(artifact, 'detail-layout-partial-information.png') });
  await page.getByRole('button', { name: '更多轨迹操作', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '轨迹信息', exact: true }).click();
  await assertQuietChrome();
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { disconnect(): void } }
    ).trajectoryFixture.disconnect(),
  );
  await page.getByText('轨迹读取未完成', { exact: true }).waitFor();
  const readAlert = page.getByRole('alert').filter({ hasText: '轨迹读取未完成' });
  assert.ok((await readAlert.innerText()).includes('trajectory_connection_unavailable'));
  await page
    .locator('.trajectory-panel')
    .screenshot({ path: path.join(artifact, 'detail-layout-real-read-error.png') });
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { reconnect(): void } }
    ).trajectoryFixture.reconnect(),
  );
  await page.getByText('轨迹读取未完成', { exact: true }).waitFor({ state: 'hidden' });
  await page.locator('[data-trajectory-row="execution:semantic-model:part:thinking"]').waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-trajectory-row="execution:semantic-model:part:thinking"]')
      ?.textContent?.includes('公开思考：先检查会话恢复'),
  );
  await assertQuietChrome();
  await page
    .locator('.trajectory-panel')
    .screenshot({ path: path.join(artifact, 'detail-layout-recovered-quiet.png') });

  verification.detailLayout = {
    controlledFixture: true,
    visits,
    exactMaterialReads: original.opens,
    originalFactsUnchanged: true,
    absentFirstTokenTimingNotInvented: true,
    narrowTransitionFrames: transitions,
    responsiveThinking: responsive,
    quietChromeAcrossFilteringTogglesAndChild: true,
    partialCoverageDisclosureRetained: true,
    actualReadErrorAndRecoveryRetained: true,
  };
  await Bun.write(
    path.join(artifact, 'detail-layout-verification.json'),
    JSON.stringify(verification, null, 2),
  );
}
