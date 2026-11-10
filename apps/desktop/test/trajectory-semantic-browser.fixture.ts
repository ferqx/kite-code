import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';

export async function verifySemanticTrajectory(input: {
  page: Page;
  artifact: string;
  verification: Record<string, unknown>;
  openTrajectory: (page: Page, suffix: string) => Promise<void>;
  bounds: (page: Page, label: string) => Promise<void>;
  settledGeometry: (
    page: Page,
  ) => Promise<
    Record<string, { x: number; y: number; width: number; scrollLeft: number; scrollTop: number }>
  >;
  transparentRowButton: (page: Page, selector: string, name: string) => Promise<void>;
}) {
  const {
    page,
    artifact,
    verification,
    openTrajectory,
    bounds,
    settledGeometry,
    transparentRowButton,
  } = input;
  const row = (id: string) => page.locator(`[data-trajectory-row="${id}"]`);
  const select = (id: string) => row(id).locator('.trajectory-node-select');
  const detail = page.getByRole('region', { name: '选中节点详情', exact: true });
  const close = async () => {
    if (await detail.isVisible()) {
      assert.equal(await detail.getByRole('tab', { name: '原始内容', exact: true }).count(), 0);
      await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
      await detail.waitFor({ state: 'hidden' });
    }
  };
  const flags = () =>
    Promise.all(
      ['轮次', '调用', '子调用'].map((name) =>
        page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'),
      ),
    );
  const setFlag = async (name: string, pressed: boolean) => {
    const button = page.getByRole('button', { name, exact: true });
    if ((await button.getAttribute('aria-pressed')) !== String(pressed)) await button.click();
    await page.waitForTimeout(70);
  };
  await openTrajectory(page, '?semantic=1');
  const restoredRawChecks = [];
  for (const [kind, tab] of [
    ['tool', '概述'],
    ['system', '系统提示词'],
    ['thinking', '思考'],
    ['message', '内容'],
  ] as const) {
    await page.goto(new URL(`?semantic=1&legacyRaw=${kind}`, page.url()).href);
    await detail.waitFor();
    assert.equal(await detail.getByRole('tab', { name: '原始内容', exact: true }).count(), 0);
    assert.equal(
      await detail.getByRole('tab', { name: tab, exact: true }).getAttribute('data-state'),
      'active',
    );
    const old = await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          trajectoryFixture: {
            restoredRawReading: {
              selectedNodeId: string;
              workbenchTab: string;
              selectedObservationId?: string;
            } | null;
            restoredRawReadings: Map<
              string,
              { selectedNodeId: string; selectedObservationId?: string; workbenchTab: string }
            >;
            requests: { method: string; request: { evidenceId?: string } }[];
          };
        }
      ).trajectoryFixture;
      return {
        initial: fixture.restoredRawReading,
        current: fixture.restoredRawReadings.get(JSON.stringify(['store', 'a'])),
        opens: fixture.requests
          .filter((request) => request.method === 'trajectory.evidence.open')
          .map((request) => request.request.evidenceId),
      };
    });
    assert.equal(old.initial?.workbenchTab, 'raw');
    assert.equal(old.current?.selectedNodeId, old.initial?.selectedNodeId);
    assert.equal(old.current?.selectedObservationId, old.initial?.selectedObservationId);
    if (kind === 'system')
      await detail
        .getByText('准确的系统指令：第 2 次请求。保持权限校验并记录验证结论。', { exact: true })
        .waitFor();
    if (kind === 'thinking')
      await detail.getByText('第 2 次请求保存的公开思考前缀。', { exact: true }).waitFor();
    if (kind === 'message')
      await detail.getByText('登录成功后仍跳回登录页，请检查并修复。', { exact: true }).waitFor();
    if (kind === 'tool') {
      assert.ok(
        !old.opens.some((value) => value?.startsWith('semantic-file-')),
        'raw migration must not pre-read tool parameters or results while overview is active',
      );
      await detail.getByRole('tab', { name: '参数', exact: true }).click();
      await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
      assert.deepEqual(
        JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
        { path: 'src/auth/session.ts', from_line: 1, to_line: 120 },
      );
    }
    restoredRawChecks.push({
      kind,
      tab,
      selectionRetained: true,
      observationRetained: true,
      noRawTab: true,
    });
  }
  verification.legacyRawRestoration = {
    isolatedNativeTrajectoryHost: true,
    cases: restoredRawChecks,
  };
  await openTrajectory(page, '?semantic=1&noRun=1');
  await row('execution:semantic-no-run-model:part:thinking')
    .getByText('无Run旧记录的公开思考。', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.trajectory-run-band').count(), 0);
  const oldStages = [
    'execution:semantic-no-run-model:part:system',
    'execution:semantic-no-run-model:part:thinking',
    'execution:semantic-no-run-tool-one',
    'execution:semantic-no-run-tool-two',
    'interaction:semantic-no-run-approval',
  ];
  const noRunDepth = await row(oldStages[0]!).getAttribute('data-depth');
  for (const id of oldStages) {
    assert.equal(await row(id).getAttribute('data-trajectory-parent'), 'session');
    assert.equal(await row(id).getAttribute('data-depth'), noRunDepth);
    assert.equal(await row(id).locator('.trajectory-node-collapse').count(), 0);
  }
  assert.ok(
    (await page.locator('[data-trajectory-row]').allInnerTexts()).every(
      (text) => !text.includes('Agent loop') && !text.includes('决策步骤'),
    ),
  );
  const oldFacts = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: {
          facts: {
            sessionId: string;
            kind: string;
            runId?: string;
            executionId?: string;
            parentExecutionId?: string;
          }[];
        };
      }
    ).trajectoryFixture.facts.filter((fact) => fact.sessionId === 'a'),
  );
  assert.ok(oldFacts.every((fact) => fact.kind !== 'run' && fact.runId === undefined));
  assert.equal(
    oldFacts.find((fact) => fact.executionId === 'semantic-no-run-tool-two')?.parentExecutionId,
    'semantic-no-run-tool-one',
  );
  verification.semanticNoRun = {
    ordinaryStagesFlatUnderOriginalSession: true,
    noInventedRun: true,
    originalParentFactUnchanged: true,
  };
  await openTrajectory(page, '?semantic=1&twoLoops=1');
  assert.equal(await row('execution:semantic-loop-one').count(), 0);
  assert.equal(await row('execution:semantic-loop-two').count(), 0);
  assert.equal(await page.locator('.trajectory-run-band').count(), 1);
  await row('run:semantic-two-loop-run').getByText('Agent loop 1', { exact: true }).waitFor();
  const stageIds = [
    'message:semantic-loop-user',
    'execution:semantic-loop-one:part:system',
    'execution:semantic-loop-one:part:thinking',
    'execution:semantic-loop-read',
    'execution:semantic-loop-one:part:reply',
    'execution:semantic-loop-two:part:system',
    'execution:semantic-loop-two:part:thinking',
    'message:semantic-loop-reply',
  ];
  const phaseDepth = await row(stageIds[0]!).getAttribute('data-depth');
  for (const id of stageIds) {
    assert.equal(await row(id).getAttribute('data-trajectory-parent'), 'run:semantic-two-loop-run');
    assert.equal(await row(id).getAttribute('data-depth'), phaseDepth);
    assert.equal(await row(id).locator('.trajectory-node-collapse').count(), 0);
  }
  assert.ok(
    (await page.locator('[data-trajectory-row]').allInnerTexts()).every(
      (text) => !text.includes('决策步骤'),
    ),
  );
  assert.equal(await page.locator('[data-trajectory-row$=":part:input"]').count(), 0);
  assert.equal(await row('execution:semantic-loop-two:part:reply').count(), 0);
  await row('execution:semantic-loop-one:part:thinking')
    .getByText('第一轮公开思考：先读取认证配置，核对恢复是否启用。', { exact: true })
    .waitFor();
  await row('execution:semantic-loop-two:part:thinking')
    .getByText('第二轮公开思考：读取结果确认恢复已启用，需要等待恢复结束再判断权限。', {
      exact: true,
    })
    .waitFor();
  await select('execution:semantic-loop-two:part:thinking').click();
  await detail.getByRole('tab', { name: '请求信息', exact: true }).click();
  await detail.getByText('gpt-6-luna', { exact: true }).waitFor();
  const savedInput = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trajectoryFixture: {
          facts: {
            eventId: string;
            executionId?: string;
            evidenceRefs: { kind: string; evidenceId: string; contentVersion: string }[];
          }[];
          requests: {
            method: string;
            request: { eventId?: string; evidenceId?: string; contentVersion?: string };
          }[];
          semantic: { bodies: Map<string, unknown> };
        };
      }
    ).trajectoryFixture;
    const event = fixture.facts.find(
      (event) =>
        event.executionId === 'semantic-loop-two' &&
        event.evidenceRefs.some((ref) => ref.kind === 'model_input'),
    )!;
    const reference = event.evidenceRefs.find((ref) => ref.kind === 'model_input')!;
    return {
      opened: fixture.requests.some(
        (value) =>
          value.method === 'trajectory.evidence.open' &&
          value.request.eventId === event.eventId &&
          value.request.evidenceId === reference.evidenceId &&
          value.request.contentVersion === reference.contentVersion,
      ),
      body: fixture.semantic.bodies.get(
        `${event.eventId}:${reference.evidenceId}:${reference.contentVersion}`,
      ),
    };
  });
  assert.ok(savedInput.opened, 'request information reads exactly the second saved public input');
  assert.ok(
    (
      savedInput.body as {
        request: { messages: { role: string; content: string; toolCallId?: string }[] };
      }
    ).request.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.content === 'session.restore = true' &&
        message.toolCallId === 'semantic-loop-read-call',
    ),
  );
  await close();
  await select('message:semantic-loop-reply').click();
  assert.deepEqual(await detail.getByRole('tab').allTextContents(), ['内容']);
  await detail.getByRole('tab', { name: '内容', exact: true }).click();
  await detail
    .getByLabel('轨迹证据', { exact: true })
    .getByText('认证配置已启用恢复；等待会话恢复后再判断路由权限。', { exact: true })
    .waitFor();
  await close();
  await page.screenshot({ path: path.join(artifact, 'semantic-two-loops.png') });
  verification.semanticRunLoop = {
    controlledFixture: true,
    agentLoops: 1,
    decisionRequests: 2,
    ordinaryStagesFlatUnderRun: true,
    noVisibleDecisionWrappers: true,
    secondInputContainsExactToolResult: true,
    noDuplicateUserOrReplyParts: true,
  };
  await openTrajectory(page, '?semantic=1&twoRuns=1');
  assert.equal(await page.locator('.trajectory-run-band').count(), 2);
  await row('run:semantic-two-loop-run').getByText('Agent loop 1', { exact: true }).waitFor();
  await row('run:semantic-followup-run').getByText('Agent loop 2', { exact: true }).waitFor();
  await row('execution:semantic-followup-model:part:thinking').waitFor();
  assert.equal(
    await row('execution:semantic-followup-model:part:thinking').getAttribute(
      'data-trajectory-parent',
    ),
    'run:semantic-followup-run',
  );
  verification.semanticTwoRuns = {
    actualRuns: 2,
    agentLoops: 2,
    secondRunRestartsDecisionIndex: true,
  };
  await page.goto(new URL('?semantic=1&redundancy=1', page.url()).href);
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { holdMaterials(): void } }
    ).trajectoryFixture.holdMaterials(),
  );
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await page
    .getByRole('region', { name: '工具', exact: true })
    .getByRole('button', { name: '执行轨迹', exact: true })
    .click();
  await row('execution:semantic-loop-two:part:system').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const contextStageGeometry = () =>
    page.locator('[data-trajectory-row]').evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute('data-trajectory-row'),
        y: element.getBoundingClientRect().y,
        height: element.getBoundingClientRect().height,
      })),
    );
  const contextBefore = await contextStageGeometry();
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { releaseMaterials(): void } }
    ).trajectoryFixture.releaseMaterials(),
  );
  await row('execution:semantic-loop-one:part:thinking')
    .getByText('第一轮公开思考：先读取认证配置，核对恢复是否启用。', { exact: true })
    .waitFor();
  await row('execution:semantic-loop-two:part:thinking')
    .getByText('第二轮公开思考：读取结果确认恢复已启用，需要等待恢复结束再判断权限。', {
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-trajectory-row="execution:semantic-loop-two:part:system"]')
      ?.textContent?.includes('沿用系统准备'),
  );
  assert.equal(await row('execution:semantic-loop-one:part:system').count(), 1);
  assert.equal(await row('execution:semantic-loop-two:part:system').count(), 1);
  assert.deepEqual(
    await contextStageGeometry(),
    contextBefore,
    'admitting equal saved preparations changes the compact label without moving or hiding stages',
  );
  await page.screenshot({ path: path.join(artifact, 'semantic-repeated-context.png') });
  const repeatedInputs = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trajectoryFixture: {
          facts: unknown[];
          semantic: { bodies: Map<string, unknown> };
        };
      }
    ).trajectoryFixture;
    const requests = [...fixture.semantic.bodies.values()]
      .map((body) => (body as { request?: Record<string, unknown> }).request)
      .filter((request) => request?.requestId);
    return { facts: JSON.stringify(fixture.facts), requests };
  });
  assert.equal(repeatedInputs.requests.length, 2);
  const [firstRequest, secondRequest] = repeatedInputs.requests;
  assert.notEqual(firstRequest!.requestId, secondRequest!.requestId);
  const systems = (request: Record<string, unknown>) =>
    (request.messages as { role: string; content: string }[]).filter(
      (message) => message.role === 'system',
    );
  assert.deepEqual(systems(firstRequest!), systems(secondRequest!));
  assert.deepEqual(firstRequest!.tools, secondRequest!.tools);
  assert.notDeepEqual(firstRequest!.messages, secondRequest!.messages);
  await select('execution:semantic-loop-two:part:system').click();
  await detail
    .getByText('准确的系统指令：第一轮准确系统请求。保持权限校验并记录验证结论。', {
      exact: true,
    })
    .waitFor();
  await detail.getByRole('tab', { name: '工具', exact: true }).click();
  await detail.getByText('files.read', { exact: true }).waitFor();
  await close();
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture.facts,
      ),
    ),
    repeatedInputs.facts,
  );
  verification.semanticRepeatedContext = {
    controlledFixture: true,
    actualRequests: 2,
    identicalSavedSystemAndToolDefinitions: true,
    distinctConversationHistoryRetained: true,
    repeatedSystemStageCompactedWithoutRemovingItsOriginalSnapshot: true,
    sourceFactsUnchanged: true,
    materialAdmissionKeepsStagePositions: true,
  };
  await openTrajectory(page, '?semantic=1&redundancy=1&changedTools=1');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-trajectory-row="execution:semantic-loop-two:part:system"]')
      ?.textContent?.includes('系统准备已更新'),
  );
  assert.equal(
    await row('execution:semantic-loop-two:part:system')
      .getByText(/沿用系统准备/)
      .count(),
    0,
  );
  await page.screenshot({ path: path.join(artifact, 'semantic-updated-tools.png') });
  await select('execution:semantic-loop-two:part:system').click();
  await detail.getByRole('tab', { name: '工具', exact: true }).click();
  await detail.locator('details.trajectory-request-tool > summary').click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    {
      type: 'object',
      properties: { path: { type: 'string' }, from_line: { type: 'integer', minimum: 1 } },
    },
  );
  await close();
  verification.semanticChangedToolContext = {
    identicalSystem: true,
    changedPublicToolSchema: true,
    showsUpdatedPreparation: true,
    exactSecondRequestSchema: true,
  };
  await openTrajectory(page, '?semantic=1&legacyLoop=1');
  const legacyOwner = row('execution:semantic-legacy-model:part:thinking');
  await legacyOwner.waitFor();
  assert.equal(await row('execution:semantic-legacy-model').count(), 0);
  assert.equal(await page.locator('[data-trajectory-row^="message:"]').count(), 0);
  const legacyParts = {
    system: '准确的系统指令：旧记录的封存原请求。保持权限校验并记录验证结论。',
    input: '原请求中保存的用户问题：请解释登录恢复。',
    thinking: '旧记录保存的公开思考：需要先等待会话恢复，再核对权限。',
    reply: '旧记录的公开回复：登录恢复完成后再判断路由权限。',
  };
  for (const [kind, content] of Object.entries(legacyParts)) {
    const part = row(`execution:semantic-legacy-model:part:${kind}`);
    await part.getByText(content, { exact: true }).waitFor();
    await part.locator('.trajectory-node-select').click();
    await detail.getByText(content, { exact: true }).waitFor();
    assert.deepEqual(
      await detail.getByRole('tab').allTextContents(),
      kind === 'system'
        ? ['系统提示词', '工具']
        : kind === 'thinking'
          ? ['思考', '请求信息']
          : ['内容'],
    );
    assert.equal(await detail.getByRole('tab', { name: '生命周期', exact: true }).count(), 0);
    assert.equal(await detail.locator('dl.trajectory-metadata:visible').count(), 0);
    assert.ok(
      await detail.locator('dl.trajectory-metadata').evaluateAll((elements) =>
        elements.every((element) => {
          const records = element.closest<HTMLDetailsElement>('details.trajectory-timing-records');
          return !!records && !records.open;
        }),
      ),
    );
    assert.ok(!(await detail.innerText()).includes('model-opaque-legacy-adapter'));
    if (kind === 'input') {
      assert.equal(await detail.getByLabel('本次请求上下文', { exact: true }).count(), 1);
      assert.ok(
        (await detail.getByLabel('本次请求上下文', { exact: true }).innerText()).includes(content),
      );
      assert.ok(!(await detail.innerText()).includes('未将其推定为当前用户唯一一次'));
    }
    if (kind === 'system') {
      await detail.getByRole('tab', { name: '工具', exact: true }).click();
      await detail.getByText('files.read', { exact: true }).waitFor();
      await detail.getByText('Read the selected file', { exact: true }).waitFor();
      const schema = detail.locator('details.trajectory-request-tool');
      assert.equal(await schema.getAttribute('open'), null);
      await schema.locator('summary').click();
      assert.deepEqual(
        JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
        { type: 'object', properties: { path: { type: 'string' } } },
      );
      await page.screenshot({ path: path.join(artifact, 'semantic-system-tools.png') });
    }
    if (kind === 'thinking') {
      await detail.getByRole('tab', { name: '请求信息', exact: true }).click();
      await detail.getByText('gpt-6-luna', { exact: true }).waitFor();
      assert.ok(!(await detail.innerText()).includes('准确的系统指令：旧记录的封存原请求'));
      assert.ok(!(await detail.innerText()).includes('原请求中保存的用户问题'));
    }
    await close();
  }
  await legacyOwner.locator('.trajectory-node-select').click();
  await detail.getByRole('tab', { name: '请求信息', exact: true }).click();
  assert.ok((await detail.innerText()).includes('gpt-6-luna'));
  assert.equal(
    await detail
      .locator('dt')
      .filter({ hasText: /^父级$/ })
      .count(),
    0,
  );
  assert.ok(!(await detail.innerText()).includes('model-opaque-legacy-adapter'));
  await page.evaluate(() => {
    const state = window as unknown as {
      modelNameSamples: string[];
      modelNameObserver?: MutationObserver;
      trajectoryFixture: { disconnect(): void; holdMaterials(): void };
    };
    state.modelNameSamples = [];
    state.modelNameObserver = new MutationObserver(() => {
      const title = Array.from(document.querySelectorAll('.trajectory-detail dt')).find(
        (value) => value.textContent === '模型',
      );
      const detailText = document.querySelector('.trajectory-detail')?.textContent ?? '';
      state.modelNameSamples.push(
        title?.nextElementSibling?.textContent ??
          (detailText.includes('不可读')
            ? '材料暂不可读'
            : detailText.includes('正在读取原版本材料')
              ? '正在读取原版本材料…'
              : ''),
      );
    });
    state.modelNameObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    state.trajectoryFixture.holdMaterials();
    state.trajectoryFixture.disconnect();
  });
  await page.waitForFunction(() =>
    document.querySelector('.trajectory-detail')?.textContent?.includes('不可读'),
  );
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { reconnect(): void } }
    ).trajectoryFixture.reconnect(),
  );
  await detail.getByText('正在读取原版本材料…', { exact: true }).first().waitFor();
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { releaseMaterials(): void } }
    ).trajectoryFixture.releaseMaterials(),
  );
  await detail
    .locator('dd')
    .filter({ hasText: /^gpt-6-luna$/ })
    .waitFor();
  const modelNameSamples = await page.evaluate(() => {
    const state = window as unknown as {
      modelNameSamples: string[];
      modelNameObserver?: MutationObserver;
    };
    state.modelNameObserver?.disconnect();
    return [...new Set(state.modelNameSamples)];
  });
  verification.semanticModelNameRecovery = {
    samples: modelNameSamples,
    neverMisreportsMissing: !modelNameSamples.includes('模型名称未保存'),
  };
  assert.ok(modelNameSamples.includes('材料暂不可读'), JSON.stringify(modelNameSamples));
  assert.ok(modelNameSamples.includes('正在读取原版本材料…'));
  assert.ok(modelNameSamples.includes('gpt-6-luna'));
  assert.ok(
    !modelNameSamples.includes('模型名称未保存'),
    'a readable historical model name must not flash as absent during reconnect',
  );
  await close();
  await page.screenshot({ path: path.join(artifact, 'semantic-legacy-loop.png') });
  verification.semanticLegacyLoop = {
    displayMetadataAbsent: true,
    standaloneMessagesAbsent: true,
    exactPublicInputAndOutput: true,
    systemUserThoughtReplyReadable: true,
    actualProviderName: true,
    ordinaryParentMetadataRemoved: true,
  };
  await openTrajectory(page, '?semantic=1');
  await bounds(page, 'semantic-initial');
  const topStageIds = [
    'message:semantic-user',
    'execution:semantic-model:part:system',
    'execution:semantic-model:part:thinking',
    'execution:semantic-read',
    'execution:semantic-edit',
    'interaction:semantic-approval',
    'execution:semantic-shell-launch',
    'execution:semantic-spawn',
    'execution:semantic-compress',
    'message:semantic-reply',
  ];
  const topDepth = await row('message:semantic-user').getAttribute('data-depth');
  for (const id of topStageIds) {
    assert.equal(await row(id).getAttribute('data-trajectory-parent'), 'run:semantic-run');
    assert.equal(await row(id).getAttribute('data-depth'), topDepth);
    if (id !== 'execution:semantic-spawn')
      assert.equal(await row(id).locator('.trajectory-node-collapse').count(), 0);
  }
  assert.ok(
    (await page.locator('[data-trajectory-row]').allInnerTexts()).every(
      (text) => !text.includes('决策步骤'),
    ),
  );
  assert.equal(await row('execution:semantic-model').count(), 0);
  assert.equal(await page.locator('[data-trajectory-row^="execution:semantic-retry-"]').count(), 0);
  assert.equal(await row('execution:semantic-shell-launch').count(), 1);
  assert.equal(await row('execution:semantic-shell-job').count(), 0);
  assert.equal(
    await page.locator('[data-trajectory-row^="execution:semantic-shell-observe-"]').count(),
    0,
  );
  assert.equal(await row('execution:semantic-spawn').count(), 1);
  assert.equal(
    (await row('execution:semantic-spawn').innerText()).match(/回归检查/g)?.length,
    1,
    'the child task title and matching summary must not repeat on its row',
  );
  assert.equal(await row('execution:semantic-child-job').count(), 0);
  await row('execution:semantic-model:part:thinking').waitFor();
  const initialFacts = await page.evaluate(() =>
    JSON.stringify(
      (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture.facts,
    ),
  );
  const initialReads = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: { requests: { method: string; request: { evidenceId?: string } }[] };
      }
    ).trajectoryFixture.requests
      .filter((request) => request.method === 'trajectory.evidence.open')
      .map((request) => request.request.evidenceId),
  );
  assert.ok(
    initialReads.length <= 8,
    'at most four visible loops may read their saved input and output',
  );
  assert.ok(
    initialReads.every(
      (id) =>
        id?.startsWith('semantic-input-') ||
        id?.startsWith('semantic-output-') ||
        id?.startsWith('semantic-child-model-'),
    ),
    'opening a log may read only exact visible-loop input/output, never tool or polling bodies',
  );
  const assertRunCountsAbsent = async () => {
    assert.equal(
      await page.locator('.trajectory-run-count').count(),
      0,
      'Run headers must not render permanent summary statistics',
    );
  };
  await assertRunCountsAbsent();
  const initialPanelText = await page.locator('.trajectory-panel').innerText();
  assert.ok(!initialPanelText.includes('固定上界'));
  assert.ok(!initialPanelText.includes('上下文祖先'));
  assert.ok(!initialPanelText.includes('匹配'));
  const metadataSearch = page.getByRole('textbox', { name: '搜索元数据', exact: true });
  await metadataSearch.fill('src/auth/session.ts');
  await page.waitForFunction(() =>
    document.querySelector('.trajectory-tree-heading')?.textContent?.includes('找到'),
  );
  assert.equal(
    ((await page.locator('.trajectory-panel').innerText()).match(/找到\s*\d+\s*项/g) ?? []).length,
    1,
    'only the active filter reports a match count, once',
  );
  await assertRunCountsAbsent();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await row('execution:semantic-model:part:thinking').waitFor();
  await assertRunCountsAbsent();

  await select('execution:semantic-model:part:thinking').click();
  await detail.getByRole('tab', { name: '请求信息', exact: true }).click();
  await detail.locator('details.trajectory-request-retries > summary').click();
  assert.ok((await detail.innerText()).includes('重连 3 次 · 4 次已保存请求'));
  for (const label of ['首次请求', '第 1 次重连', '第 2 次重连', '第 3 次重连'])
    assert.equal(await detail.getByRole('button', { name: new RegExp(`^${label} ·`) }).count(), 1);
  await detail.getByRole('button', { name: /^第 1 次重连 ·/ }).click();
  const retrySource = detail.locator(
    '.trajectory-material-source[title="材料版本：semantic-input-1-5"]',
  );
  await retrySource.waitFor();
  assert.equal(await retrySource.innerText(), '来源 #5');
  await detail.getByRole('tab', { name: '思考', exact: true }).click();
  await detail.getByText('第 2 次请求保存的公开思考前缀。', { exact: true }).waitFor();
  const selectedRetryReads = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trajectoryFixture: {
          facts: { kind: string; executionId?: string; eventId: string }[];
          requests: {
            method: string;
            request: { evidenceId?: string; contentVersion?: string; eventId?: string };
          }[];
        };
      }
    ).trajectoryFixture;
    return {
      executions: [
        ...new Set(
          fixture.facts
            .filter(
              (value) =>
                value.kind === 'model' &&
                value.executionId?.startsWith('semantic-') &&
                !value.executionId?.includes('compress') &&
                !value.executionId?.includes('child'),
            )
            .map((value) => value.executionId),
        ),
      ],
      opens: fixture.requests
        .filter((value) => value.method === 'trajectory.evidence.open')
        .map((value) => value.request),
    };
  });
  assert.equal(
    selectedRetryReads.executions.filter(
      (id) => id === 'semantic-model' || id?.startsWith('semantic-retry-'),
    ).length,
    4,
  );
  assert.ok(
    selectedRetryReads.opens.some(
      (value) =>
        value.evidenceId === 'semantic-input-1' && value.contentVersion === 'semantic-input-1-5',
    ),
  );
  assert.ok(
    selectedRetryReads.opens.some(
      (value) =>
        value.evidenceId === 'semantic-output-1' && value.contentVersion === 'semantic-output-1-6',
    ),
  );
  await close();
  await select('execution:semantic-model:part:system').click();
  await detail.getByRole('tab', { name: '系统提示词', exact: true }).click();
  await detail.locator('details.trajectory-request-retries > summary').click();
  await detail.getByRole('button', { name: /^第 1 次重连 ·/ }).click();
  await detail
    .getByText('准确的系统指令：第 2 次请求。保持权限校验并记录验证结论。', { exact: true })
    .waitFor();
  assert.ok(!(await detail.innerText()).includes('准确的系统指令：第 4 次请求'));
  verification.semanticRetry = {
    logicalRows: 1,
    reconnects: 3,
    requests: 4,
    selectedAttempt: 2,
    accurateRequestRead: true,
  };
  await close();

  await select('execution:semantic-shell-launch').click();
  await detail.waitFor();
  await detail.getByRole('tab', { name: '概述', exact: true }).click();
  assert.ok(
    (await detail.getByLabel('命令与观察结果', { exact: true }).innerText()).includes('运行中'),
  );
  assert.equal(
    await detail
      .locator('dt:visible')
      .filter({ hasText: /^状态$/ })
      .count(),
    0,
  );
  assert.equal(await detail.getByText('命令状态', { exact: true }).count(), 1);
  await detail.getByText('相关读取与观察 · 5 次', { exact: true }).click();
  assert.equal(await detail.getByRole('button', { name: /^读取输出 ·/ }).count(), 3);
  assert.equal(await detail.getByRole('button', { name: /^等待结果 ·/ }).count(), 2);
  assert.equal(
    await detail.getByText('本次等待超时；不表示目标任务结束。', { exact: true }).count(),
    2,
  );
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="原公开 JSON"]')
      ?.textContent?.includes('npm test -- auth/session.test.ts'),
  );
  assert.deepEqual(
    JSON.parse(await detail.getByLabel('原公开 JSON', { exact: true }).innerText()),
    {
      command: 'npm test -- auth/session.test.ts',
      workdir: '/workspace/demo-app',
      background: true,
    },
  );
  await detail.getByRole('tab', { name: '结果', exact: true }).click();
  await detail.getByText('认证测试正在运行。', { exact: true }).waitFor();
  assert.equal(await detail.getByText('原启动回执', { exact: true }).count(), 1);
  const defaultShellReads = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: { requests: { method: string; request: { evidenceId?: string } }[] };
      }
    ).trajectoryFixture.requests
      .filter((request) => request.method === 'trajectory.evidence.open')
      .map((request) => request.request.evidenceId),
  );
  assert.equal(
    defaultShellReads.some((id) => id?.startsWith('semantic-shell-observe-')),
    false,
    'opening a command result must not pre-read polling bodies',
  );
  verification.semanticShell = {
    logicalRows: 1,
    readCount: 3,
    waitCount: 2,
    waitTimeoutsDoNotFinishCommand: true,
    originalParameters: true,
    noPollPrefetch: true,
  };
  await close();

  await select('execution:semantic-compress').click();
  await detail.getByRole('tab', { name: '概述', exact: true }).click();
  const compressionText = await detail.locator('.trajectory-compression').innerText();
  assert.match(compressionText, /12200\s*→\s*2600\s*Token/);
  assert.match(compressionText, /9600/);
  assert.match(compressionText, /78\.7%/);
  assert.equal(await detail.getByText('压缩已采用', { exact: true }).count(), 1);
  const compressionFacts = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: {
          facts: {
            kind: string;
            phase: string;
            executionId?: string;
            attributes: { action?: string; compression?: { adopted?: boolean } };
          }[];
        };
      }
    ).trajectoryFixture.facts
      .filter((fact) => fact.executionId === 'semantic-compress')
      .map((fact) => ({
        kind: fact.kind,
        phase: fact.phase,
        action: fact.attributes.action,
        adopted: fact.attributes.compression?.adopted,
      })),
  );
  assert.ok(
    compressionFacts.some(
      (fact) => fact.kind === 'model' && fact.phase === 'completed' && fact.adopted === false,
    ),
    'the original successful generation remains independent of adoption',
  );
  assert.ok(
    compressionFacts.some(
      (fact) => fact.kind === 'context' && fact.action === 'compressed' && fact.adopted === true,
    ),
    'only the original context fact proves adoption',
  );
  assert.equal(
    await detail
      .locator('dt:visible')
      .filter({ hasText: /^状态$/ })
      .count(),
    0,
  );
  await detail.getByRole('tab', { name: '预览', exact: true }).click();
  await detail.getByText('登录守卫已等待会话恢复。', { exact: true }).waitFor();
  await detail.getByText('权限拒绝逻辑保留。', { exact: true }).waitFor();
  await detail.getByText('后台认证测试尚在运行。', { exact: true }).waitFor();
  verification.semanticCompression = {
    sameBasisBeforeTokens: 12200,
    afterTokens: 2600,
    reducedTokens: 9600,
    ratio: '78.7%',
    completeAdoptedSummaryReadable: true,
    generationAndAdoptionNotConflated: true,
  };
  await close();

  const combinations = [];
  for (const value of [
    [false, false, false],
    [false, false, true],
    [false, true, true],
    [false, true, false],
    [true, true, false],
    [true, true, true],
    [true, false, true],
    [true, false, false],
  ]) {
    for (const [index, label] of ['轮次', '调用', '子调用'].entries())
      await setFlag(label, value[index]!);
    assert.deepEqual(await flags(), value.map(String));
    await assertRunCountsAbsent();
    assert.equal(await row('message:semantic-user').count(), 1);
    assert.equal((await page.locator('.trajectory-run-band').count()) > 0, true);
    assert.equal(await row('execution:semantic-model:part:thinking').count(), value[0] ? 1 : 0);
    assert.equal(
      await row('execution:semantic-model:part:system').count(),
      value[0] && value[1] ? 1 : 0,
    );
    assert.equal(await row('execution:semantic-shell-launch').count(), value[0] ? 1 : 0);
    if (value[0] && value[2])
      await page
        .locator('[data-trajectory-row$="execution:semantic-child-model:part:thinking"]')
        .waitFor();
    assert.equal(
      await page
        .locator('[data-trajectory-row$="execution:semantic-child-model:part:thinking"]')
        .count(),
      value[0] && value[2] ? 1 : 0,
    );
    combinations.push({
      flags: value,
      rows: await page
        .locator('[data-trajectory-row]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-trajectory-row')),
        ),
    });
  }
  verification.semanticCombinations = combinations;
  verification.semanticStableSummary = {
    runHeaderCountsAbsent: true,
    allEightCombinations: true,
    filteringDoesNotRestoreRunCounts: true,
    oneMatchCountOnlyWhenFiltered: true,
    noDefaultCursorOrAncestorCounts: true,
  };
  for (const name of ['轮次', '调用', '子调用']) await setFlag(name, true);
  await page
    .locator('[data-trajectory-row$="execution:semantic-child-model:part:thinking"]')
    .waitFor();
  const childRunRow = page.locator('[data-trajectory-row$="run:semantic-child-run"]');
  const childRunId = await childRunRow.getAttribute('data-trajectory-row');
  const runPositions = await page.evaluate(() => {
    const main = document.querySelector(
      '[data-trajectory-row="run:semantic-run"] .trajectory-node-select',
    )!;
    const child = document.querySelector(
      '[data-trajectory-row$="run:semantic-child-run"] .trajectory-node-select',
    )!;
    return { main: main.getBoundingClientRect().x, child: child.getBoundingClientRect().x };
  });
  assert.ok(
    runPositions.child >= runPositions.main + 25,
    'the nested child Run band must visibly indent below its carrier',
  );
  verification.semanticChildRunIndent = runPositions;
  assert.equal(
    await childRunRow.getAttribute('data-trajectory-parent'),
    'execution:semantic-spawn',
  );
  const childIds = [
    'message:semantic-child-user',
    'execution:semantic-child-model:part:system',
    'execution:semantic-child-model:part:thinking',
    'execution:semantic-child-read',
    'message:semantic-child-reply',
  ];
  const childDepth = await page
    .locator('[data-trajectory-row$="message:semantic-child-user"]')
    .getAttribute('data-depth');
  for (const id of childIds) {
    const childStage = page.locator(`[data-trajectory-row$="${id}"]`);
    assert.equal(await childStage.getAttribute('data-trajectory-parent'), childRunId);
    assert.equal(await childStage.getAttribute('data-depth'), childDepth);
    assert.equal(await childStage.locator('.trajectory-node-collapse').count(), 0);
  }
  assert.equal(
    await page.locator('[data-trajectory-row$="execution:semantic-child-model"]').count(),
    0,
  );
  const scopedReads = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: {
          requests: { method: string; request: { sessionId?: string; runId?: string } }[];
        };
      }
    ).trajectoryFixture.requests
      .filter((request) => request.method === 'trajectory.events')
      .map((request) => request.request),
  );
  assert.ok(
    scopedReads.some(
      (request) => request.sessionId === 'semantic-child' && request.runId === 'semantic-child-run',
    ),
  );
  await assertRunCountsAbsent();
  await select('execution:semantic-spawn').click();
  await detail.getByRole('tab', { name: '概述', exact: true }).click();
  assert.equal(
    await detail
      .locator('dt:visible')
      .filter({ hasText: /^状态$/ })
      .count(),
    0,
  );
  const childState = await detail.getByLabel('子 Agent 工作与返回', { exact: true }).innerText();
  assert.ok(childState.includes('已受理'));
  assert.ok(childState.includes('已完成'));
  assert.ok(childState.includes('父级已接收'));
  await close();
  await page.screenshot({ path: path.join(artifact, 'semantic-expanded.png') });
  verification.semanticChildScope = {
    exactSession: 'semantic-child',
    exactRun: 'semantic-child-run',
    originalScopesSeparate: true,
  };

  await transparentRowButton(
    page,
    '[data-trajectory-row="execution:semantic-read"] .trajectory-node-select',
    'semantic row',
  );
  await transparentRowButton(
    page,
    '[data-trajectory-row="run:semantic-run"] .trajectory-node-collapse',
    'semantic collapse',
  );
  await row('execution:semantic-read').scrollIntoViewIfNeeded();
  const before = await settledGeometry(page);
  await page.evaluate(() => {
    const measurement = window as unknown as {
      semanticFrameSamples: unknown[];
      semanticFrameRunning: boolean;
    };
    measurement.semanticFrameSamples = [];
    measurement.semanticFrameRunning = true;
    const sample = () => {
      measurement.semanticFrameSamples.push(
        [
          '.trajectory-panel',
          '.trajectory-toolbar',
          '.trajectory-timeline',
          '[aria-label="轨迹事件树"]',
        ].map((selector) => {
          const el = document.querySelector<HTMLElement>(selector)!;
          const bounds = el.getBoundingClientRect();
          return {
            selector,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            scrollTop: el.scrollTop,
            scrollLeft: el.scrollLeft,
          };
        }),
      );
      if (measurement.semanticFrameRunning) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await select('execution:semantic-read').click();
  await detail.waitFor();
  await page.waitForTimeout(220);
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  await page.waitForTimeout(220);
  const frames = await page.evaluate(() => {
    const value = window as unknown as {
      semanticFrameSamples: {
        selector: string;
        x: number;
        y: number;
        width: number;
        scrollTop: number;
        scrollLeft: number;
      }[][];
      semanticFrameRunning: boolean;
    };
    value.semanticFrameRunning = false;
    return value.semanticFrameSamples;
  });
  assert.ok(frames.length > 10);
  for (const frame of frames)
    for (const value of frame) {
      const baseline =
        value.selector === '.trajectory-panel'
          ? before.panel
          : value.selector === '.trajectory-toolbar'
            ? before.header
            : value.selector === '.trajectory-timeline'
              ? before.timeline
              : before.viewport;
      assert.ok(
        Math.abs(value.x - baseline!.x) <= 1 &&
          Math.abs(value.y - baseline!.y) <= 1 &&
          Math.abs(value.width - baseline!.width) <= 1,
        `detail transition moved ${value.selector}`,
      );
      assert.equal(value.scrollLeft, baseline!.scrollLeft);
      if (value.selector.includes('轨迹事件树')) assert.equal(value.scrollTop, baseline!.scrollTop);
    }
  verification.semanticTransitionFrames = frames;
  await select('execution:semantic-read').click();
  await page.getByRole('dialog').waitFor();
  const borders = [];
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      colorScheme,
    );
    const border = await page.getByRole('dialog').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        left: style.borderLeftWidth,
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        color: style.borderLeftColor,
        token: style.getPropertyValue('--border'),
      };
    });
    assert.deepEqual(
      [border.left, border.top, border.right, border.bottom],
      ['1px', '0px', '0px', '0px'],
    );
    borders.push({ colorScheme, ...border });
  }
  verification.semanticBorders = borders;
  await close();

  // Opening an old material, changing selection, and receiving its late reply cannot replace the new selection.
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { holdMaterials(): void } }
    ).trajectoryFixture.holdMaterials(),
  );
  await select('execution:semantic-read').click();
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await page.waitForFunction(
    () =>
      (
        window as unknown as { trajectoryFixture: { heldMaterials(): number } }
      ).trajectoryFixture.heldMaterials() > 0,
  );
  await close();
  await select('interaction:semantic-approval').click();
  await detail.getByRole('tab', { name: '预览', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { releaseMaterials(): void } }
    ).trajectoryFixture.releaseMaterials(),
  );
  await page.waitForFunction(() =>
    document.querySelector('.trajectory-detail')?.textContent?.includes('修改路由守卫'),
  );
  assert.equal(await detail.getByText('src/auth/session.ts', { exact: true }).count(), 0);
  await close();
  await page.waitForFunction(
    () =>
      (window as unknown as { trajectoryFixture: { leases: Map<string, unknown> } })
        .trajectoryFixture.leases.size === 0,
  );
  verification.semanticLateMaterial = {
    previousReadCancelled: true,
    selectedApprovalRetained: true,
    leasesReleased: true,
  };

  await select('execution:semantic-shell-launch').click();
  await detail.getByRole('tab', { name: '结果', exact: true }).click();
  await detail.getByText('认证测试正在运行。', { exact: true }).waitFor();
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { disconnect(): void } }
    ).trajectoryFixture.disconnect(),
  );
  await page.waitForFunction(
    () =>
      !document.querySelector('.trajectory-detail')?.textContent?.includes('认证测试正在运行。'),
  );
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { reconnect(): void } }
    ).trajectoryFixture.reconnect(),
  );
  await page.waitForFunction(() =>
    document.querySelector('.trajectory-detail')?.textContent?.includes('认证测试正在运行。'),
  );
  assert.equal(await row('execution:semantic-shell-launch').count(), 1);
  await close();
  await page.getByRole('button', { name: 'Fixture: 后台测试完成', exact: true }).click();
  await page.getByText('有新的执行记录，当前阅读位置保持不变。', { exact: true }).waitFor();
  assert.equal(
    await row('execution:semantic-shell-launch')
      .getByRole('img', { name: '运行中', exact: true })
      .count(),
    1,
  );
  await page
    .locator('.trajectory-new-records')
    .getByRole('button', { name: '返回最新', exact: true })
    .click();
  await page.locator('.trajectory-new-records').waitFor({ state: 'hidden' });
  await select('execution:semantic-shell-launch').click();
  await detail.getByRole('tab', { name: '结果', exact: true }).click();
  await detail.getByText('24 项认证测试通过，退出码 0。', { exact: true }).waitFor();
  assert.equal(await row('execution:semantic-shell-launch').count(), 1);
  assert.equal(await row('message:semantic-reply').count(), 1);
  verification.semanticLiveUpdate = {
    fixedPrefixHeld: true,
    commandRowIdentityStable: true,
    finalReplyIdentityStable: true,
  };
  await close();

  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.waitForTimeout(200);
  const outer = page.locator('#details-resize[role="separator"]');
  const outerRect = await outer.boundingBox();
  assert.ok(outerRect);
  await page.mouse.move(outerRect.x + outerRect.width / 2, outerRect.y + 120);
  await page.mouse.down();
  await page.mouse.move(250, outerRect.y + 120, { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector('.trajectory-workspace')?.getAttribute('data-detail-layout') ===
      'docked',
  );
  await select('execution:semantic-model:part:thinking').click();
  await detail.waitFor();
  const beforeWidth = (await detail.boundingBox())!.width;
  const separator = page.getByRole('separator', { name: '调整轨迹详情宽度', exact: true });
  const handle = await separator.boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
  await page.mouse.down();
  await page.mouse.move(handle.x - 60, handle.y + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(
    (before) =>
      document.querySelector('.trajectory-detail')!.getBoundingClientRect().width > before + 20,
    beforeWidth,
  );
  verification.semanticDetailResize = {
    before: beforeWidth,
    after: (await detail.boundingBox())!.width,
  };
  await page.screenshot({ path: path.join(artifact, 'semantic-docked.png') });
  await close();
  const childTool = page.locator('[data-trajectory-row$="execution:semantic-child-read"]');
  await childTool.waitFor();
  const childRowId = await childTool.getAttribute('data-trajectory-row');
  await childTool.locator('.trajectory-node-select').click();
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="原公开 JSON"]')
      ?.textContent?.includes('src/auth/guard.ts'),
  );
  await row('execution:semantic-spawn').locator('.trajectory-node-collapse').click();
  await detail.getByText('此记录当前被折叠，详情仍保留原选择。', { exact: true }).waitFor();
  assert.equal(await childTool.count(), 0);
  await page.evaluate(() => {
    const state = window as unknown as {
      semanticChildSamples: string[];
      semanticChildObserver?: MutationObserver;
    };
    state.semanticChildSamples = [];
    state.semanticChildObserver = new MutationObserver(() =>
      state.semanticChildSamples.push(
        document.querySelector('.trajectory-detail')?.textContent ?? '',
      ),
    );
    state.semanticChildObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (
      window as unknown as { trajectoryFixture: { disconnect(): void } }
    ).trajectoryFixture.disconnect();
  });
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[aria-label="原公开 JSON"]')
        ?.textContent?.includes('src/auth/guard.ts'),
  );
  await page.evaluate(() =>
    (
      window as unknown as { trajectoryFixture: { reconnect(): void } }
    ).trajectoryFixture.reconnect(),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="原公开 JSON"]')
      ?.textContent?.includes('src/auth/guard.ts'),
  );
  const childSamples = await page.evaluate(() => {
    const state = window as unknown as {
      semanticChildSamples: string[];
      semanticChildObserver?: MutationObserver;
    };
    state.semanticChildObserver?.disconnect();
    return state.semanticChildSamples;
  });
  assert.ok(childSamples.length > 0);
  assert.equal(
    childSamples.some((sample) => sample.includes('src/auth/session.ts')),
    false,
    'child detail was replaced by a parent material during reconnect',
  );
  assert.equal(
    await detail.getByRole('tab', { name: '参数', exact: true }).getAttribute('data-state'),
    'active',
  );
  assert.equal(await childTool.count(), 0);
  const childOpens = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: {
          requests: { method: string; request: { sessionId?: string; evidenceId?: string } }[];
        };
      }
    ).trajectoryFixture.requests
      .filter(
        (request) =>
          request.method === 'trajectory.evidence.open' &&
          request.request.evidenceId === 'semantic-child-read-input',
      )
      .map((request) => request.request),
  );
  assert.ok(childOpens.length >= 2);
  assert.ok(childOpens.every((request) => request.sessionId === 'semantic-child'));
  verification.semanticSelectedChildReconnect = {
    childRowId,
    carrierRemainsCollapsed: true,
    parameterTabRetained: true,
    accurateChildScopeReread: true,
    samples: childSamples,
  };
  await close();
  for (let index = 0; index < 24; index++) {
    if ((await page.locator('.trajectory-panel').boundingBox())!.width <= 325) break;
    await outer.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(35);
  }
  const sidebarWidth = (await page.locator('.trajectory-panel').boundingBox())!.width;
  assert.ok(sidebarWidth >= 299 && sidebarWidth <= 330);
  await select('execution:semantic-read').click();
  await page.getByRole('dialog').waitFor();
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="原公开 JSON"]')
      ?.textContent?.includes('src/auth/session.ts'),
  );
  await bounds(page, 'semantic-sidebar-320');
  await page.screenshot({ path: path.join(artifact, 'semantic-sidebar-320.png') });
  await close();
  assert.equal(
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.nodeId),
    'execution:semantic-read',
  );
  assert.equal(
    await page.evaluate(
      (prefix) =>
        JSON.stringify(
          (
            window as unknown as { trajectoryFixture: { facts: unknown[] } }
          ).trajectoryFixture.facts.slice(0, JSON.parse(prefix).length),
        ),
      initialFacts,
    ),
    initialFacts,
  );
  verification.semanticNoOriginalFactMutation = true;
  await Bun.write(
    path.join(artifact, 'semantic-verification.json'),
    JSON.stringify(verification, null, 2),
  );
}
