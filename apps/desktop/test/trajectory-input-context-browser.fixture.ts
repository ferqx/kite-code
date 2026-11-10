import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { trajectoryInputContextData } from './trajectory-input-context-data.fixture';

/** Targeted public-input presentation; intentionally not another workbench matrix. */
export async function verifyTrajectoryInputContext(input: {
  page: Page;
  artifact: string;
  verification: Record<string, unknown>;
  baseUrl: string;
}) {
  const { page, artifact, verification, baseUrl } = input;
  await page.emulateMedia({ colorScheme: 'dark' });
  const cases = [];
  for (const pasteExactHost of [false, true]) {
    const expected = trajectoryInputContextData(pasteExactHost);
    const suffix = `?semantic=1&inputContext=1${pasteExactHost ? '&pasteExactHost=1' : ''}`;
    await page.goto(new URL(suffix, baseUrl).href);
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
    const row = page.locator(
      '[data-trajectory-row="execution:semantic-input-context-model:part:input"]',
    );
    await row.waitFor();
    const factsBefore = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture.facts,
      ),
    );
    const bodiesBefore = await page.evaluate(() =>
      JSON.stringify([
        ...(
          window as unknown as {
            trajectoryFixture: { semantic: { bodies: Map<string, unknown> } };
          }
        ).trajectoryFixture.semantic.bodies,
      ]),
    );
    assert.ok((await page.locator('.trajectory-panel').boundingBox())!.width <= 330);
    await row.locator('.trajectory-node-select').click();
    const detail = page.getByRole('region', { name: '选中节点详情', exact: true });
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await detail.getByRole('tab').allTextContents(), ['内容']);
    await page.waitForFunction(
      () =>
        (
          window as unknown as { trajectoryFixture: { heldMaterials(): number } }
        ).trajectoryFixture.heldMaterials() > 0,
    );
    await detail.evaluate((element) => {
      const state = window as unknown as {
        inputContextSamples: string[];
        inputContextObserver?: MutationObserver;
      };
      state.inputContextSamples = [element.textContent ?? ''];
      state.inputContextObserver = new MutationObserver(() =>
        state.inputContextSamples.push(element.textContent ?? ''),
      );
      state.inputContextObserver.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.evaluate(() =>
      (
        window as unknown as { trajectoryFixture: { releaseMaterials(): void } }
      ).trajectoryFixture.releaseMaterials(),
    );
    const context = detail.getByLabel('本次请求上下文', { exact: true });
    await context.getByText('你好', { exact: true }).waitFor();
    await context
      .getByText('此消息包含 1 张已保存图片，本阶段仅展示文字。', { exact: true })
      .waitFor();
    const text = await context.innerText();
    assert.ok(
      text.includes(expected.pastedJson),
      'a real unmarked user JSON message remains readable',
    );
    assert.equal(
      text.split(expected.pastedJson).length - 1,
      1,
      'only the unmarked user copy remains, even when identical to the host JSON',
    );
    assert.equal(
      await context.locator(':scope > section').count(),
      3,
      'only greeting, pasted JSON and the image-only message remain',
    );
    assert.ok(!text.includes('此消息正文为空'));
    assert.ok(!text.includes(expected.runtimeMessageContent));
    const detailText = await detail.innerText();
    assert.ok(!detailText.includes(expected.inputVersion));
    assert.ok(!detailText.includes('未将其推定为当前用户唯一一次'));
    assert.equal(
      await detail.locator('.trajectory-material-source').getAttribute('title'),
      `材料版本：${expected.inputVersion}`,
    );
    if (!pasteExactHost) assert.ok(!text.includes(expected.hostDirectory));
    const samples = await page.evaluate(() => {
      const state = window as unknown as {
        inputContextSamples: string[];
        inputContextObserver?: MutationObserver;
      };
      state.inputContextObserver?.disconnect();
      return state.inputContextSamples;
    });
    assert.ok(samples.length > 1);
    assert.ok(samples.every((value) => !value.includes('此消息正文为空')));
    assert.ok(samples.every((value) => !value.includes('runtime-state')));
    assert.ok(samples.every((value) => !value.includes('plan_requirement')));
    assert.ok(samples.every((value) => !value.includes(expected.inputVersion)));
    assert.ok(samples.every((value) => !value.includes('未将其推定为当前用户唯一一次')));
    if (!pasteExactHost)
      assert.ok(
        samples.every((value) => !value.includes(expected.hostDirectory)),
        'host-only paths never flash during material admission',
      );
    const original = await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          trajectoryFixture: {
            facts: {
              eventId: string;
              executionId?: string;
              runId?: string;
              evidenceRefs: { kind: string; evidenceId: string; contentVersion: string }[];
            }[];
            semantic: { bodies: Map<string, unknown> };
            requests: {
              method: string;
              request: { eventId?: string; evidenceId?: string; contentVersion?: string };
            }[];
          };
        }
      ).trajectoryFixture;
      const event = fixture.facts.find(
        (value) =>
          value.executionId === 'semantic-input-context-model' &&
          value.evidenceRefs.some((ref) => ref.kind === 'model_input'),
      )!;
      const ref = event.evidenceRefs.find((value) => value.kind === 'model_input')!;
      return {
        body: fixture.semantic.bodies.get(
          `${event.eventId}:${ref.evidenceId}:${ref.contentVersion}`,
        ),
        runId: event.runId,
        serializedBodies: JSON.stringify([...fixture.semantic.bodies]),
        exactOpen: fixture.requests.some(
          (request) =>
            request.method === 'trajectory.evidence.open' &&
            request.request.eventId === event.eventId &&
            request.request.evidenceId === ref.evidenceId &&
            request.request.contentVersion === ref.contentVersion,
        ),
      };
    });
    const saved = original.body as {
      request: { messages: { role: string; content: string; sourceIds?: string[] }[] };
      metadata: {
        context: {
          transformationId: string;
          sourceOrder: string;
          sources: { id: string; digest: string }[];
        };
      };
    };
    assert.ok(original.exactOpen);
    assert.equal(
      saved.request.messages.length,
      7,
      'presentation does not delete original host or empty records',
    );
    assert.equal(saved.request.messages.at(-2)!.content, expected.hostJson);
    assert.deepEqual(saved.request.messages.at(-2)!.sourceIds, [expected.sourceId]);
    assert.equal(saved.request.messages.at(-1)!.content, expected.runtimeMessageContent);
    assert.deepEqual(saved.request.messages.at(-1)!.sourceIds, [expected.runtimeSourceId]);
    assert.equal(original.runId, expected.runId);
    assert.equal(expected.runtimeSourceId, `builtin.planning:runtime:${original.runId}`);
    for (const [id, content] of [
      [expected.sourceId, expected.hostJson],
      [expected.runtimeSourceId, expected.runtimeSourceContent],
    ] as const)
      assert.equal(
        saved.metadata.context.sources.find((source) => source.id === id)?.digest,
        new Bun.CryptoHasher('sha256').update(content).digest('hex'),
      );
    assert.equal(original.serializedBodies, bodiesBefore);
    assert.equal(saved.request.messages[2]!.sourceIds, undefined);
    const name = pasteExactHost ? 'identical-user-json' : 'host-context';
    await detail.getByLabel('详情正文', { exact: true }).evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: path.join(artifact, `input-${name}-drawer.png`) });
    await detail.screenshot({ path: path.join(artifact, `input-${name}-detail.png`) });
    await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    const snippet = await row.locator('.trajectory-row-secondary').innerText();
    assert.ok(snippet.startsWith('你好 · '));
    assert.equal((snippet.match(/session_files/g) ?? []).length, 1);
    if (!pasteExactHost) assert.ok(!snippet.includes(expected.hostDirectory));
    assert.ok(!snippet.includes('runtime-state'));
    assert.ok(!snippet.includes('plan_requirement'));
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify(
          (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture
            .facts,
        ),
      ),
      factsBefore,
    );
    await page
      .locator('.trajectory-panel')
      .screenshot({ path: path.join(artifact, `input-${name}-panel.png`) });
    cases.push({
      pasteExactHost,
      visibleMessageBlocks: 3,
      exactOriginalInputRead: true,
      fullOriginalMessages: 7,
      runtimeSourceMatchesExactRun: true,
      sourceDigestsVerified: true,
      originalBodiesUnchanged: true,
      originalFactsUnchanged: true,
      snippet,
      samples,
    });
  }
  verification.inputContext = { controlledFixture: true, narrowDrawer: true, cases };
  await Bun.write(
    path.join(artifact, 'input-context-verification.json'),
    JSON.stringify(verification, null, 2),
  );
}
