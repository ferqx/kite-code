import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import type { Plugin } from 'vite';
import type {} from './prompt-send-browser.fixture';

declare global {
  interface Window {
    historyRenders: Record<string, number>;
  }
}

/** Count even React executions that produce identical DOM. Only this test build has probes. */
export function countHistoryRenders(): Plugin {
  const probes = [
    ['Conversation.tsx', '  const [metadataNow,', 'message.id'],
    ['ConversationTrace.tsx', '  const first = steps[0];', 'steps[0]?.id'],
    [
      'native-user-images.tsx',
      'export function NativeUserImages(props: Props) {',
      'props.message.id',
    ],
    [
      'native-output-files.tsx',
      'function OutputFileReader(input: OutputReaderInput) {',
      'input.runId',
    ],
    [
      'OutputFiles.tsx',
      'export function OutputFiles({ items, ...actions }: OutputFilesProps) {',
      'items[0]?.name',
    ],
  ] as const;
  return {
    name: 'history-isolation-render-probes',
    enforce: 'pre',
    transform(code, id) {
      const probe = probes.find(([file]) => id.replaceAll('\\', '/').endsWith(`/${file}`));
      if (!probe) return;
      const [file, anchor, identity] = probe;
      assert.ok(code.includes(anchor), `Render probe missed ${file}`);
      const position = code.indexOf(anchor) + (anchor.endsWith('{') ? anchor.length : 0);
      const count = `
        if (window.historyRenders && (${identity})) {
          const key = "${file}:" + (${identity});
          window.historyRenders[key] = (window.historyRenders[key] ?? 0) + 1;
        }
      `;
      return code.slice(0, position) + count + code.slice(position);
    },
  };
}

async function verifyOldFileTargetThroughRescan(page: Page, oldTurn: Locator) {
  const target = oldTurn.getByRole('button', { name: '原档-1.md', exact: true });
  await target.click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => window.promptSendFixture.targetOpens?.length === 1);
  const retained = await target.evaluateHandle((element) => {
    const button = element as HTMLButtonElement;
    const slot = button.closest('.tool-step-target')!;
    const row = button.closest('.tool-activity-step')!;
    const icon = row.querySelector('.tool-step-icon')!;
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(slot, { childList: true, subtree: true });
    return {
      state: () => {
        const style = getComputedStyle(button);
        return {
          same: row.isConnected && row.contains(icon) && slot.querySelector('button') === button,
          disabled: button.disabled,
          readGated: button.dataset.readGated === 'true',
          businessDisabled: button.hasAttribute('data-disabled'),
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
          color: style.color,
          backgroundColor: style.backgroundColor,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          replacements: changes.length,
        };
      },
      stop: () => observer.disconnect(),
    };
  });
  const initial = await retained.evaluate((probe) => probe.state());
  assert.equal(initial.same, true);
  assert.equal(initial.disabled, false);
  assert.equal(initial.readGated, false);
  assert.equal(initial.businessDisabled, false);
  const editor = page.locator('textarea.prompt-editor');
  await editor.fill('下一轮触发历史重新核对');
  await editor.press('Enter');
  await page.getByText('下一轮触发历史重新核对', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.promptSendFixture.holdNextRescan!();
    window.promptSendFixture.accept();
    window.promptSendFixture.save();
  });
  await page.waitForFunction(() => window.promptSendFixture.rescanStarted!());
  const blocked = await retained.evaluate(async (probe) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return probe.state();
  });
  assert.deepEqual(blocked, { ...initial, disabled: true, readGated: true });
  await target.evaluate((button) => (button as HTMLButtonElement).click());
  assert.deepEqual(await page.evaluate(() => window.promptSendFixture.targetOpens), [
    'target-old-tool-1',
  ]);
  await page.evaluate(() => window.promptSendFixture.releaseRescan!());
  await page.locator('[data-message-id="saved-2"]').waitFor({ state: 'attached' });
  await page.waitForFunction(() => window.promptSendFixture.fileTargetsPending!());
  const metadataPending = await retained.evaluate(async (probe) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return probe.state();
  });
  assert.deepEqual(metadataPending, blocked);
  await target.evaluate((button) => (button as HTMLButtonElement).click());
  assert.deepEqual(await page.evaluate(() => window.promptSendFixture.targetOpens), [
    'target-old-tool-1',
  ]);
  await page.evaluate(() => window.promptSendFixture.releaseFileTargets!());
  await target.click();
  await page.mouse.move(0, 0);
  assert.deepEqual(await page.evaluate(() => window.promptSendFixture.targetOpens), [
    'target-old-tool-1',
    'target-old-tool-1-1',
  ]);
  const restored = await retained.evaluate((probe) => probe.state());
  assert.deepEqual(restored, initial);
  await page.evaluate(() => window.promptSendFixture.setHistoricalFileReadRevoked(true));
  await oldTurn.locator('button.file-link:disabled', { hasText: '原档-1.md' }).waitFor();
  const revoked = await retained.evaluate((probe) => probe.state());
  assert.deepEqual(revoked, blocked);
  await target.evaluate((button) => (button as HTMLButtonElement).click());
  assert.deepEqual(await page.evaluate(() => window.promptSendFixture.targetOpens), [
    'target-old-tool-1',
    'target-old-tool-1-1',
  ]);
  await retained.evaluate((probe) => probe.stop());
  return { initial, blocked, metadataPending, restored, revoked };
}

export async function verifyHistoryIsolation(browser: Browser, url: URL, artifact: string) {
  url.searchParams.set('history-isolation', '');
  let historyIsolationCases = 0;
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 800],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 750 }, colorScheme: theme });
    try {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.historyRenders = {};
      });
      await page.goto(url.toString());
      const oldReply = page.locator('[data-message-id="old-reply-1"]');
      const oldTurn = oldReply.locator('xpath=ancestor::*[@data-entry-kind="turn"]');
      await oldReply.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await oldTurn.getByText('成果-1', { exact: true }).waitFor();
      const oldLatest = page.locator(
        '[data-message-id="old-reply-4"] > .message-meta[data-default-visible]',
      );
      await oldLatest.waitFor({ state: 'attached' });
      const disclosure = oldTurn.locator('button.agent-turn-summary');
      if ((await disclosure.getAttribute('aria-expanded')) === 'false') await disclosure.click();
      await oldTurn.locator('.conversation-trace-process').waitFor();
      await oldTurn.getByRole('button', { name: '原档-1.md', exact: true }).waitFor();
      await oldTurn.evaluate(async (element) => {
        const animations = element.getAnimations({ subtree: true });
        await Promise.allSettled(
          animations
            .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
            .map((animation) => animation.finished),
        );
      });
      await oldReply.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const observed = await page.evaluateHandle(async () => {
        for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame);
        const answer = document.querySelector('[data-message-id="old-reply-1"]')!;
        const entry = answer.closest('[data-entry-kind="turn"]')!;
        const input = document.querySelector('[data-message-id="old-input-1"]')!;
        const attachment = input.querySelector('.native-user-images')!;
        const body = answer.querySelector('.typeset-chat')!;
        const cards = [...answer.querySelectorAll('.output-file-card')];
        const viewport = document.querySelector('.conversation-viewport')!;
        const summary = entry.querySelector('.agent-turn-summary')!;
        const snapshot = () => ({
          top: body.getBoundingClientRect().top,
          height: body.getBoundingClientRect().height,
          scroll: viewport.scrollTop,
          retained: [answer, body, input, attachment, ...cards].every((node) => node?.isConnected),
          open: summary.getAttribute('aria-expanded'),
          cards: answer.querySelectorAll('.output-file-card').length,
        });
        const mutations: { added: number; removed: number; type: string }[] = [];
        const observer = new MutationObserver((records) => {
          for (const record of records)
            mutations.push({
              type: record.type,
              added: record.addedNodes.length,
              removed: record.removedNodes.length,
            });
        });
        for (const node of [entry, input])
          observer.observe(node, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        const initial = snapshot();
        const mounted = Object.keys(window.historyRenders);
        window.historyRenders = {};
        window.promptSendFixture.outputQueries!.length = 0;
        let frame = 0;
        const frames: ReturnType<typeof snapshot>[] = [];
        const sample = () => {
          frames.push(snapshot());
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        const read = () => ({
          frames: frames.splice(0),
          mutations: mutations.splice(0),
          renders: Object.entries(window.historyRenders).filter(([key]) =>
            /:old-|:成果-/.test(key),
          ),
          queries: window.promptSendFixture.outputQueries!.splice(0).filter(Boolean),
        });
        return {
          initial,
          mounted,
          read,
          stop: () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
          },
        };
      });
      const editor = page.locator('textarea.prompt-editor');
      await editor.fill('新轮次输入');
      await editor.press('Enter');
      await page.getByText('新轮次输入', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.promptSendFixture.accept();
        window.promptSendFixture.save();
      });
      await page.locator('[data-message-id="saved-1"]').waitFor({ state: 'attached' });
      for (let index = 1; index <= 8; index++) {
        const chunk = `流式片段-${index}。`;
        await page.evaluate((text) => window.promptSendFixture.stream(text), chunk);
        await page
          .locator('[data-message-id="reply-1"]')
          .getByText(chunk, { exact: false })
          .waitFor({ state: 'attached' });
      }
      await page.evaluate(() => window.promptSendFixture.finishStream());
      const newReply = page.locator('[data-message-id="reply-1"][data-final-reply="true"]');
      await newReply.waitFor({ state: 'attached' });
      await newReply.locator('.message-meta[data-default-visible]').waitFor({ state: 'attached' });
      assert.equal(await oldLatest.count(), 0);
      const normal = await observed.evaluate(async (state) => {
        for (let frame = 0; frame < 6; frame++) await new Promise(requestAnimationFrame);
        return { initial: state.initial, mounted: state.mounted, ...state.read() };
      });
      await page.evaluate(() => window.promptSendFixture.publishLateOutput());
      await oldTurn.getByText('旧轮晚到', { exact: true }).waitFor();
      const late = await observed.evaluate(async (state) => {
        await new Promise(requestAnimationFrame);
        state.stop();
        return state.read();
      });
      assert.ok(normal.initial.retained);
      assert.equal(normal.initial.open, 'true');
      assert.equal(normal.initial.cards, 2);
      for (const probe of [
        'Conversation.tsx:old-reply-1',
        'ConversationTrace.tsx:old-tool-1',
        'native-user-images.tsx:old-input-1',
        'native-output-files.tsx:old-run-1',
        'OutputFiles.tsx:成果-1.pdf',
      ])
        assert.ok(normal.mounted.includes(probe), `Unobserved mount: ${probe}`);
      assert.ok(normal.frames.length >= 12);
      assert.ok(
        normal.frames.every((frame) => JSON.stringify(frame) === JSON.stringify(normal.initial)),
      );
      assert.deepEqual(normal.renders, [], `${theme}: a saved entry rendered during a new Turn`);
      assert.deepEqual(normal.mutations, []);
      assert.deepEqual(normal.queries, []);
      assert.deepEqual(late.queries, ['old-run-1']);
      assert.deepEqual(late.mutations, [{ type: 'childList', added: 1, removed: 0 }]);
      assert.deepEqual(late.frames.at(-1), { ...normal.initial, cards: 3 });
      assert.ok(
        late.renders.every(([key]) => /:old-(?:reply|tool|run)-1$|:成果-1\.pdf$/.test(key)),
      );
      await disclosure.click();
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      await disclosure.click();
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
      await newReply.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await newReply.getByRole('button', { name: '预览 新轮次产出.pdf', exact: true }).waitFor();
      assert.equal(
        await oldTurn.getByRole('button', { name: '预览 新轮次产出.pdf', exact: true }).count(),
        0,
      );
      const fileTarget = await verifyOldFileTargetThroughRescan(page, oldTurn);
      await Bun.write(
        join(artifact, `history-${theme}.json`),
        JSON.stringify({ normal, late, fileTarget, errors }, null, 2),
      );
      assert.deepEqual(errors, []);
      historyIsolationCases++;
    } finally {
      await page.close();
    }
  }
  return { historyIsolationCases };
}
