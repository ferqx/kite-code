import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { writeFixtureFile } from '../../../scripts/tooling/files';
import { outputStateCases } from './trajectory-output-state.fixture';

/** Focused output admission and reading-position checks against the real Native renderer. */
export async function verifyTrajectoryOutputState(input: {
  page: Page;
  artifact: string;
  verification: Record<string, unknown>;
  baseUrl: string;
}) {
  const { page, artifact, verification, baseUrl } = input;
  await page.emulateMedia({ colorScheme: 'dark' });
  const cases = [];
  for (const caseName of outputStateCases) {
    await page.goto(new URL(`?outputState=1&outputCase=${caseName}`, baseUrl).href);
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
    await page.locator('.trajectory-panel [role="treegrid"]').waitFor();
    const state = await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          trajectoryFixture: {
            outputState: {
              rowId: string;
              hiddenInitially: boolean;
              hiddenFinally: boolean;
              text: string;
            };
            facts: unknown[];
          };
        }
      ).trajectoryFixture;
      return { ...fixture.outputState, facts: JSON.stringify(fixture.facts) };
    });
    const output = page.locator(`[data-trajectory-row="${state.rowId}"]`);
    assert.equal(
      await output.count(),
      state.hiddenInitially ? 0 : 1,
      `${caseName}: initial output visibility`,
    );
    const anchor = page.locator('[data-trajectory-row="execution:output-anchor-9"]');
    await anchor.scrollIntoViewIfNeeded();
    const selectedId = state.hiddenInitially
      ? 'execution:output-subject:part:thinking'
      : state.rowId;
    const selected = page.locator(`[data-trajectory-row="${selectedId}"]`);
    await selected.scrollIntoViewIfNeeded();
    const detail = page.getByRole('region', { name: '选中节点详情', exact: true });
    await page.evaluate(() => {
      const state = window as unknown as { outputSamples: unknown[]; outputSampling: boolean };
      state.outputSamples = [];
      state.outputSampling = true;
      const sample = () => {
        const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
        const box = viewport.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>('[data-trajectory-row]')].map(
          (element) => ({
            id: element.dataset.trajectoryRow!,
            top: element.getBoundingClientRect().top - box.top,
            height: element.getBoundingClientRect().height,
          }),
        );
        state.outputSamples.push({
          rows,
          scrollTop: viewport.scrollTop,
          scrollLeft: viewport.scrollLeft,
          regions: [
            '.trajectory-panel',
            '.trajectory-toolbar',
            '.trajectory-timeline',
            '[aria-label="轨迹事件树"]',
          ].map((selector) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        });
        if (state.outputSampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await selected.locator('.trajectory-node-select').click();
    await detail.waitFor();
    await page.waitForTimeout(160);
    // Cancel one held read, then reopen under a new hold; late admission must not alter rows.
    await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    await page.evaluate(() =>
      (
        window as unknown as { trajectoryFixture: { releaseMaterials(): void } }
      ).trajectoryFixture.releaseMaterials(),
    );
    await page.waitForTimeout(80);
    await page.evaluate(() =>
      (
        window as unknown as { trajectoryFixture: { holdMaterials(): void } }
      ).trajectoryFixture.holdMaterials(),
    );
    await selected.locator('.trajectory-node-select').click();
    await detail.waitFor();
    await page.waitForTimeout(160);
    await page.evaluate(() =>
      (
        window as unknown as { trajectoryFixture: { releaseMaterials(): void } }
      ).trajectoryFixture.releaseMaterials(),
    );
    if (
      !state.hiddenInitially &&
      !caseName.startsWith('generating-') &&
      !['failed', 'unknown'].includes(caseName)
    )
      await detail.getByText(state.text, { exact: true }).waitFor();
    await page.waitForTimeout(160);
    await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    await page.waitForTimeout(120);
    const frames = await page.evaluate(() => {
      const state = window as unknown as {
        outputSamples: {
          rows: { id: string; top: number; height: number }[];
          scrollTop: number;
          scrollLeft: number;
          regions: { selector: string; x: number; y: number; width: number; height: number }[];
        }[];
        outputSampling: boolean;
      };
      state.outputSampling = false;
      return state.outputSamples;
    });
    assert.ok(frames.length > 8, `${caseName}: enough transition frames`);
    const baseline = frames[0]!;
    for (const frame of frames) {
      const ids = frame.rows.map((row) => row.id);
      assert.deepEqual(
        ids,
        baseline.rows.map((row) => row.id),
        `${caseName}: material loading changed row identities`,
      );
      assert.equal(new Set(ids).size, ids.length, `${caseName}: duplicate row identity`);
      assert.equal(
        frame.scrollTop,
        baseline.scrollTop,
        `${caseName}: material/detail transition changed scrollTop`,
      );
      assert.equal(frame.scrollLeft, baseline.scrollLeft);
      frame.rows.forEach((row, index) => {
        assert.ok(
          Math.abs(row.top - baseline.rows[index]!.top) <= 1 &&
            Math.abs(row.height - baseline.rows[index]!.height) <= 1,
          `${caseName}: material transition moved ${row.id}`,
        );
      });
      frame.regions.forEach((region, index) => {
        const before = baseline.regions[index]!;
        for (const dimension of ['x', 'y', 'width', 'height'] as const)
          assert.ok(
            Math.abs(region[dimension] - before[dimension]) <= 1,
            `${caseName}: ${region.selector} ${dimension} moved`,
          );
      });
    }
    assert.equal(await output.count(), state.hiddenInitially ? 0 : 1);
    const toggles = [];
    for (const name of ['轮次', '调用', '子调用']) {
      const toggle = page.getByRole('button', { name, exact: true });
      const before = await toggle.getAttribute('aria-pressed');
      await toggle.click();
      await page.waitForTimeout(80);
      await toggle.click();
      await page.waitForTimeout(80);
      assert.equal(await toggle.getAttribute('aria-pressed'), before);
      toggles.push(name);
    }
    assert.equal(
      await output.count(),
      state.hiddenInitially ? 0 : 1,
      `${caseName}: toggles resurrected an empty reply`,
    );
    const factsAfter = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture.facts,
      ),
    );
    assert.equal(factsAfter, state.facts, `${caseName}: presentation mutated original facts`);
    const reads = await page.evaluate(() => {
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
      return fixture.requests
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
        }));
    });
    assert.ok(
      reads.every((read) => read.exact),
      `${caseName}: read a foreign or inferred material binding`,
    );
    if (!messageCaseWithoutOutput(caseName))
      assert.ok(reads.length > 0, `${caseName}: did not exercise original material admission`);
    let advanceFrames: { top: number; present: boolean; ids: string[] }[] = [];
    let finalNavigationFrames: boolean[] = [];
    if (caseName.startsWith('generating-')) {
      await anchor.scrollIntoViewIfNeeded();
      const before = await anchor.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          document.querySelector('[aria-label="轨迹事件树"]')!.getBoundingClientRect().top,
      );
      await page.evaluate((rowId) => {
        const state = window as unknown as {
          advanceSamples: { top: number; present: boolean; ids: string[] }[];
          advanceSampling: boolean;
        };
        state.advanceSamples = [];
        state.advanceSampling = true;
        const sample = () => {
          const anchor = document.querySelector(
            '[data-trajectory-row="execution:output-anchor-9"]',
          )!;
          const ids = [...document.querySelectorAll<HTMLElement>('[data-trajectory-row]')].map(
            (row) => row.dataset.trajectoryRow!,
          );
          state.advanceSamples.push({
            top:
              anchor.getBoundingClientRect().top -
              document.querySelector('[aria-label="轨迹事件树"]')!.getBoundingClientRect().top,
            present: ids.includes(rowId),
            ids,
          });
          if (state.advanceSampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, state.rowId);
      await page.evaluate(() =>
        (
          window as unknown as { trajectoryFixture: { advanceOutputState(): void } }
        ).trajectoryFixture.advanceOutputState(),
      );
      await page.waitForTimeout(250);
      advanceFrames = await page.evaluate(() => {
        const state = window as unknown as {
          advanceSamples: { top: number; present: boolean; ids: string[] }[];
          advanceSampling: boolean;
        };
        state.advanceSampling = false;
        return state.advanceSamples;
      });
      verification.outputStateInProgress = { caseName, before, advanceFrames };
      let transitions = 0;
      for (let index = 0; index < advanceFrames.length; index++) {
        const frame = advanceFrames[index]!;
        assert.ok(
          Math.abs(frame.top - before) <= 1,
          `${caseName}: intermediate state moved the reading anchor`,
        );
        assert.equal(new Set(frame.ids).size, frame.ids.length);
        if (index && frame.present !== advanceFrames[index - 1]!.present) transitions++;
      }
      assert.ok(transitions <= 1, `${caseName}: reply flickered during factual state progression`);
      await page.getByRole('button', { name: '返回最新', exact: true }).waitFor();
      assert.equal(
        await output.count(),
        state.hiddenInitially ? 0 : 1,
        `${caseName}: a pinned cursor displayed future output`,
      );
      await page.evaluate((rowId) => {
        const state = window as unknown as {
          finalOutputSamples: boolean[];
          finalOutputSampling: boolean;
        };
        state.finalOutputSamples = [];
        state.finalOutputSampling = true;
        const sample = () => {
          state.finalOutputSamples.push(
            !!document.querySelector(`[data-trajectory-row="${rowId}"]`),
          );
          if (state.finalOutputSampling) requestAnimationFrame(sample);
        };
        sample();
      }, state.rowId);
      await page.getByRole('button', { name: '返回最新', exact: true }).click();
      await page.waitForTimeout(250);
      finalNavigationFrames = await page.evaluate(() => {
        const state = window as unknown as {
          finalOutputSamples: boolean[];
          finalOutputSampling: boolean;
        };
        state.finalOutputSampling = false;
        return state.finalOutputSamples;
      });
      let navigationTransitions = 0;
      for (let index = 1; index < finalNavigationFrames.length; index++)
        if (finalNavigationFrames[index] !== finalNavigationFrames[index - 1])
          navigationTransitions++;
      assert.equal(
        navigationTransitions,
        state.hiddenInitially !== state.hiddenFinally ? 1 : 0,
        `${caseName}: returning to latest repeated an output-state transition`,
      );
      assert.equal(
        await output.count(),
        state.hiddenFinally ? 0 : 1,
        `${caseName}: final output visibility`,
      );
      if (!state.hiddenFinally) {
        await output.locator('.trajectory-node-select').click();
        await detail.getByText(state.text, { exact: true }).waitFor();
        await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
        await detail.waitFor({ state: 'hidden' });
      }
    }
    await page
      .locator('.trajectory-panel')
      .screenshot({ path: path.join(artifact, `output-${caseName}.png`) });
    cases.push({
      caseName,
      initialReplyVisible: !state.hiddenInitially,
      finalReplyVisible: !state.hiddenFinally,
      transitionFrames: frames,
      toggles,
      originalFactsUnchangedBeforeAdvance: true,
      exactMaterialReads: reads,
      advanceFrames,
      finalNavigationFrames,
    });
  }
  verification.outputState = {
    controlledFixture: true,
    materialLoadingNeverChangesRows: true,
    cases,
  };
  await writeFixtureFile(
    path.join(artifact, 'output-state-verification.json'),
    JSON.stringify(verification, null, 2),
  );
}

function messageCaseWithoutOutput(caseName: string) {
  return caseName === 'empty-message';
}
