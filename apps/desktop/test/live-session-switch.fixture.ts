import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';

export function liveSwitchReply(marker: string) {
  return [
    `# ${marker}`,
    ...Array.from({ length: 36 }, (_, i) => `Reading ${marker} paragraph ${i + 1}.`),
    `${marker}_INITIAL_TAIL`,
    ['```ts', `const owner = "${marker}_CODE";`].join('\n'),
  ].join('\n\n');
}

export function liveSwitchDelta(marker: string, tick: number) {
  const formatting =
    tick === 1
      ? ['', '```', '', '| Record | Result |', '| --- | --- |', `| Owner | ${marker}_CELL |`].join(
          '\n',
        )
      : '';
  return `${formatting}\n\n${marker}_TICK_${tick}\n\n`;
}

type PendingRead = {
  arm(): Promise<void>;
  waitHeld(): Promise<void>;
  afterSwitch(): Promise<void>;
};
type SwitchControls =
  | {
      client: 'desktop';
      reasoningReads(): Promise<number>;
      appendReasoning(): Promise<void>;
      pendingRead: PendingRead;
    }
  | { client: 'web'; pendingRead?: PendingRead };

async function selectReceiptText(page: Page, body: Locator, marker: string) {
  await body.scrollIntoViewIfNeeded();
  const point = await body.evaluate((element, marker) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(marker) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw Error(`missing selectable text: ${marker}`);
  }, marker);
  await page.mouse.dblclick(point.x, point.y);
  assert.equal((await page.evaluate(() => getSelection()?.toString()))?.trim(), marker);
  return body.elementHandle();
}

/** Both Web rows use the same Tool. Read each original public receipt to identify it. */
async function openWebReceipt(viewport: Locator, marker: string) {
  const rows = viewport.locator('article[data-message-role="tool"] details');
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.locator('> .typeset-chat, > .message-markdown').count(), 0);
  for (const row of await rows.all()) {
    const control = row.locator('summary');
    await control.press('Enter');
    const body = row.locator('.message-markdown');
    await body.waitFor();
    if ((await body.innerText()).includes(marker)) return body;
    await control.press('Space');
    await body.waitFor({ state: 'detached' });
  }
  throw Error(`missing original tool receipt: ${marker}`);
}

/** Observe the ordinary sidebars and message viewports without instrumenting either client. */
export async function exerciseLiveSessionSwitches(
  page: Page,
  controls: SwitchControls,
  evidence: string,
  produced: () => Promise<{ marker: string; tick: number }[]>,
  finish: (id: number) => Promise<number>,
) {
  const { client, pendingRead } = controls;
  const selectors =
    client === 'desktop'
      ? {
          link: 'button.session-row',
          title: '.session-header .breadcrumb strong',
          viewport: '.history-panel .conversation-viewport',
        }
      : {
          link: 'nav a[href*="/sessions/"]',
          title: '.conversation-header h1',
          viewport: 'section[aria-label="History"]',
        };
  const choose = (id: number) =>
    (client === 'desktop'
      ? page.getByRole('button', { name: `Live Root ${id}`, exact: true })
      : page.locator(`nav a[href="/sessions/root-${id}"]`)
    ).click();
  await page.locator(`${selectors.link}[aria-current="page"]`).waitFor();
  const capture = await page.evaluateHandle((selectors) => {
    const idOf = (text?: string | null) => {
      const match = /(?:Live Root |root-)(\d+)/.exec(text ?? '');
      return match ? Number(match[1]) : undefined;
    };
    const sample = () => {
      const header = document.querySelector(selectors.title);
      const title = idOf(header?.querySelector('.sr-only')?.textContent ?? header?.textContent);
      const selected = document.querySelector(`${selectors.link}[aria-current="page"]`);
      const nav = idOf(selected?.getAttribute('aria-label') ?? selected?.textContent);
      const viewport = document.querySelector<HTMLElement>(selectors.viewport);
      const visible =
        viewport?.checkVisibility() &&
        !viewport.closest('[hidden]') &&
        !viewport.closest('.conversation')?.querySelector('.conversation-loading');
      const visibleText = visible ? viewport!.innerText : '';
      const owners = [
        ...new Set([...visibleText.matchAll(/ROOT_([012])/g)].map((m) => Number(m[1]))),
      ];
      const ticks = [...visibleText.matchAll(/ROOT_\d+_TICK_(\d+)/g)].map((m) => Number(m[1]));
      return {
        at: performance.now(),
        title,
        nav,
        owners,
        tick: ticks.at(-1) ?? 0,
        duplicate: new Set(ticks).size !== ticks.length,
        reasoning: [...visibleText.matchAll(/ROOT_[01]_THOUGHT_\w+/g)].map((m) => m[0]),
        errorDetail: /文件不存在|ROOT_[01]_TOOL_ERROR/.test(visibleText),
        successDetail: /ROOT_[01]_TOOL_OK/.test(visibleText),
        reasoningReadError: visibleText.includes('暂时无法读取思考内容'),
        finalCount: [...visibleText.matchAll(/ROOT_[012]_(?:FINAL|DONE)/g)].length,
        body: /ROOT_\d+_(?:INITIAL_TAIL|FINAL|DONE)/.test(visibleText),
        done: /ROOT_\d+_(?:DONE|FINAL)/.test(visibleText),
        running:
          !!viewport?.querySelector('.agent-turn-running') ||
          document
            .querySelector('[aria-label="Run status"]')
            ?.textContent?.includes(' · active') === true,
        top: viewport?.scrollTop ?? 0,
        gap: viewport ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop : 0,
      };
    };
    const frames: ReturnType<typeof sample>[] = [];
    const clicks: { at: number; id: number; trusted: boolean }[] = [];
    const click = (event: Event) => {
      const button = (event.target as Element | null)?.closest(selectors.link);
      const id = idOf(button?.getAttribute('aria-label') ?? button?.textContent);
      if (id !== undefined) clicks.push({ at: performance.now(), id, trusted: event.isTrusted });
    };
    document.addEventListener('click', click, true);
    let raf = 0;
    let afterLayout = 0;
    const watch = () => {
      // ResizeObserver can restore the tail after rAF but before the same paint.
      afterLayout = window.setTimeout(() => frames.push(sample()), 0);
      raf = requestAnimationFrame(watch);
    };
    watch();
    return {
      frames,
      clicks,
      stop: () => {
        cancelAnimationFrame(raf);
        clearTimeout(afterLayout);
        document.removeEventListener('click', click, true);
      },
    };
  }, selectors);
  const waitForBody = (id: number, tick: number, done = false) =>
    page.waitForFunction(
      ({ capture, id, tick, done }) => {
        const frame = capture.frames.at(-1);
        return (
          frame?.title === id &&
          frame.nav === id &&
          frame.body &&
          frame.owners.length === 1 &&
          frame.owners[0] === id &&
          frame.tick >= tick &&
          (!done || (frame.done && !frame.running))
        );
      },
      { capture, id, tick, done },
      { timeout: 15000 },
    );
  try {
    await waitForBody(0, 1);
    const viewport = page.locator(selectors.viewport);
    const verifyFinalReply = async (id: number, lastProduced: number) => {
      assert.ok(Number.isSafeInteger(lastProduced) && lastProduced > 0);
      const marker = `ROOT_${id}`;
      const reply = viewport
        .locator('[data-final-reply="true"]')
        .filter({ hasText: `${marker}_DONE` });
      await reply.waitFor();
      const ticks = (await reply.innerText()).match(/\bROOT_\d+_TICK_\d+\b/g) ?? [];
      assert.deepEqual(
        ticks,
        Array.from({ length: lastProduced }, (_, i) => `${marker}_TICK_${i + 1}`),
        `final reply must contain every emitted ${marker} fragment exactly once and in order`,
      );
    };
    const trace = viewport.locator('.conversation-trace > .conversation-trace-trigger');
    const thoughts = viewport.locator('.conversation-reasoning > button');
    const thoughtBody = (marker: string) =>
      viewport.locator('.conversation-reasoning-body .typeset-chat').filter({ hasText: marker });
    const missing = (id: number) =>
      viewport.locator('.tool-activity').filter({
        has: page.locator('button.tool-activity-summary', { hasText: `ROOT_${id}-missing.txt` }),
      });
    const failure = (id: number) =>
      missing(id).locator('.tool-activity-content').getByText('文件不存在', { exact: true });
    const webBody = (marker: string) =>
      viewport
        .locator('article[data-message-role="tool"] details[open] .message-markdown')
        .filter({ hasText: marker });
    const screenshot = async (name: string) => {
      if (client === 'web') await viewport.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `${name}.png`) });
    };
    const draft = page.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
    const verifyDisclosure = async (id: number) => {
      await viewport
        .locator('pre code')
        .filter({ hasText: `ROOT_${id}_CODE` })
        .waitFor();
      await viewport.getByRole('cell', { name: `ROOT_${id}_CELL`, exact: true }).waitFor();
      if (client === 'web') {
        await webBody(`ROOT_${id}_TOOL_${id === 0 ? 'ERROR' : 'OK'}`).waitFor();
        assert.equal(await viewport.locator('details[open]').count(), 1);
      } else {
        assert.equal(await draft.inputValue(), `Draft for ${id}`);
        await thoughtBody(`ROOT_${id}_THOUGHT_INITIAL`).waitFor();
        if (id === 0) {
          await thoughtBody('ROOT_0_THOUGHT_MORE').waitFor();
          await failure(0).waitFor();
        } else {
          assert.equal(await thoughts.last().getAttribute('aria-expanded'), 'false');
          assert.equal(
            await missing(1).locator('button').first().getAttribute('aria-expanded'),
            'false',
          );
        }
      }
    };
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const selectedMarker = client === 'desktop' ? 'ROOT_0_THOUGHT_LIVE' : 'ROOT_0_TOOL_ERROR';
    let selectedBody: Locator;
    if (client === 'desktop') {
      await trace.click();
      await missing(0).locator('button.tool-activity-summary').click();
      await failure(0).waitFor();
      await thoughts.last().press('Space');
      selectedBody = thoughtBody(selectedMarker);
      await selectedBody.waitFor();
      await thoughts.last().press('Enter');
      await selectedBody.waitFor({ state: 'hidden' });
      await thoughts.last().press('Space');
    } else selectedBody = await openWebReceipt(viewport, selectedMarker);
    await selectedBody.waitFor();
    const originalNode = await selectReceiptText(page, selectedBody, selectedMarker);
    const nextTick = (await produced()).find((s) => s.marker === 'ROOT_0')!.tick + 1;
    let reasoningReads: { textOnly: number; appended: number } | undefined;
    if (controls.client === 'desktop') {
      const before = await controls.reasoningReads();
      assert.ok(before > 0, 'the open reading came from the active Model');
      await waitForBody(0, nextTick + 2);
      const afterText = await controls.reasoningReads();
      assert.equal(afterText, before, 'reply-only updates reread the open thinking body');
      await controls.appendReasoning();
      await thoughtBody('ROOT_0_THOUGHT_MORE').waitFor();
      const afterThought = await controls.reasoningReads();
      assert.equal(afterThought, afterText + 1, 'new reasoning needs one fresh read');
      reasoningReads = { textOnly: afterText - before, appended: afterThought - afterText };
    }
    await waitForBody(0, nextTick);
    assert.ok(
      await originalNode!.evaluate((node) => node.isConnected),
      'streaming replaced the body being read',
    );
    assert.equal(
      (await page.evaluate(() => getSelection()?.toString()))?.trim(),
      selectedMarker,
      'streaming cleared the reader’s selection',
    );
    await originalNode!.dispose();
    await screenshot('selected-a');
    if (client === 'desktop') await draft.fill('Draft for 0');
    await pendingRead?.arm();
    if (client === 'desktop') await thoughts.first().click();
    await pendingRead?.waitHeld();
    const parked = await viewport.evaluate((element) => {
      if (element.scrollHeight - element.clientHeight < 240)
        throw Error('live history must scroll');
      element.scrollTop = 120;
      return element.scrollTop;
    });
    await page.waitForFunction(({ capture, parked }) => capture.frames.at(-1)?.top === parked, {
      capture,
      parked,
    });
    let staticHistory: { mutations: number; sameNodes: boolean; dwellMs: number } | undefined;
    const visits = [];
    const seen = new Map<number, number>();
    for (const id of [2, 0, 1, 0, 1, 0, 1, 0]) {
      const emitted = (await produced()).find((s) => s.marker === `ROOT_${id}`)?.tick ?? 0;
      const before = id === 2 ? 0 : Math.max(emitted, (seen.get(id) ?? 0) + 1);
      await choose(id);
      await waitForBody(id, before, id === 2);
      const result = await capture.evaluate(
        ({ clicks, frames }, { id, emitted }) => {
          const click = clicks.at(-1)!;
          const matching = frames.filter(
            (f) =>
              f.at >= click.at && f.title === id && f.nav === id && f.body && f.owners.includes(id),
          );
          const first = matching[0]!;
          const caught = matching.find((frame) => frame.tick >= emitted)!;
          const latest = frames.at(-1)!;
          return {
            id,
            click,
            firstBodyMs: first.at - click.at,
            catchUpMs: caught.at - click.at,
            top: latest.top,
            gap: latest.gap,
            tick: latest.tick,
          };
        },
        { id, emitted },
      );
      assert.ok(result.click.trusted && result.click.id === id);
      const firstVisit = !seen.has(id);
      seen.set(id, result.tick);
      if (id === 0)
        assert.ok(
          Math.abs(result.top - parked) <= 1,
          `A lost its reading position: ${JSON.stringify(result)}`,
        );
      if (id === 1)
        assert.ok(result.gap <= 2, `B stopped following its output: ${JSON.stringify(result)}`);
      if (id === 2) {
        await pendingRead?.afterSwitch();
        if (client === 'desktop') assert.equal(await draft.inputValue(), '');
        const watching = await viewport.evaluateHandle((element) => {
          const bodies = [...element.querySelectorAll('.typeset-chat,.message-markdown')];
          let mutations = 0;
          const observer = new MutationObserver((records) => {
            mutations += records.length;
          });
          for (const body of bodies)
            observer.observe(body, { childList: true, characterData: true, subtree: true });
          return () => {
            mutations += observer.takeRecords().length;
            observer.disconnect();
            return {
              mutations,
              sameNodes:
                bodies.length > 0 &&
                bodies.every((body) => body.isConnected && element.contains(body)),
            };
          };
        });
        const start = await produced(),
          entered = Date.now();
        assert.deepEqual(start.map((s) => s.marker).sort(), ['ROOT_0', 'ROOT_1']);
        for (;;) {
          const now = await produced();
          if (
            Date.now() - entered >= 2100 &&
            start.every((s) => now.some((row) => row.marker === s.marker && row.tick >= s.tick + 2))
          )
            break;
          assert.ok(Date.now() - entered < 10000, 'background streams stopped');
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        staticHistory = {
          ...(await watching.evaluate((stop) => stop())),
          dwellMs: Date.now() - entered,
        };
        await watching.dispose();
        assert.ok(
          staticHistory.sameNodes && staticHistory.mutations === 0,
          `background output rewrote the static history: ${JSON.stringify(staticHistory)}`,
        );
      }
      if (id === 1 && firstVisit) {
        if (client === 'desktop') {
          assert.equal(await draft.inputValue(), '');
          await draft.fill('Draft for 1');
          assert.equal(await trace.getAttribute('aria-expanded'), 'false');
          await trace.press('Enter');
          await thoughts.first().press('Space');
        } else await openWebReceipt(viewport, 'ROOT_1_TOOL_OK');
        await verifyDisclosure(id);
        await screenshot('expanded-b');
        // Go back to live-follow after inspecting the earlier Tool.
        await viewport.evaluate((element) => {
          element.scrollTop = 0;
        });
        await page
          .getByRole('button', {
            name: client === 'desktop' ? '回到最新消息' : 'Back to latest messages',
            exact: true,
          })
          .click();
      } else if (id !== 2) await verifyDisclosure(id);
      if (firstVisit) await screenshot(['reading-a', 'following-b', 'static'][id]!);
      visits.push(result);
    }
    // Overlap new inputs with old selection reads, including two generations of the same session.
    for (const id of [1, 0, 1, 0, 1]) await choose(id);
    await waitForBody(1, (await produced()).find((s) => s.marker === 'ROOT_1')!.tick + 1);
    await verifyDisclosure(1);
    await choose(0);
    await waitForBody(0, 1);
    await verifyDisclosure(0);
    const finalTickB = await finish(1);
    await waitForBody(0, (await produced()).find((s) => s.marker === 'ROOT_0')!.tick + 1);
    assert.ok(
      await capture.evaluate(({ frames }) => frames.at(-1)!.running && !frames.at(-1)!.done),
    );
    await choose(1);
    await waitForBody(1, 1, true);
    assert.ok(await capture.evaluate(({ frames }) => frames.at(-1)!.gap <= 2));
    await verifyFinalReply(1, finalTickB);
    if (client === 'desktop') {
      await viewport.getByRole('button', { name: /^用时 .*展开本轮处理过程$/ }).click();
      await viewport.getByRole('button', { name: /^用时 .*收起本轮处理过程$/ }).waitFor();
      await trace.waitFor();
    } else await verifyDisclosure(1);
    await screenshot('finished-b');
    await choose(0);
    await waitForBody(0, 1);
    await verifyDisclosure(0);
    const finalTickA = await finish(0);
    await waitForBody(0, 1, true);
    await verifyFinalReply(0, finalTickA);
    if (client === 'desktop') assert.equal(await draft.inputValue(), 'Draft for 0');
    assert.ok(
      await capture.evaluate(({ frames }, top) => Math.abs(frames.at(-1)!.top - top) <= 1, parked),
    );
    await screenshot('finished-a');
    const observation = await capture.evaluate(({ frames, clicks }) => ({ frames, clicks }));
    assert.ok(observation.frames.length > 10);
    const wrong = observation.frames.filter((f) =>
      f.owners.some((owner) => owner !== f.title || owner !== f.nav),
    );
    assert.deepEqual(wrong.slice(0, 3), [], 'cross-session content under the selected heading');
    assert.ok(
      !observation.frames.some((f) => f.title === 2 && f.body && f.running),
      'static session showed an active response',
    );
    for (const id of [0, 1])
      assert.ok(
        observation.frames.some((f) => f.title === id && f.body && f.running && !f.done),
        'active session did not show its running status',
      );
    assert.ok(
      observation.frames.every((f) => !f.duplicate),
      'a delta appeared twice',
    );
    assert.ok(
      observation.frames.every((f) => f.finalCount <= 1),
      'duplicate final reply',
    );
    assert.ok(
      observation.frames.every((f) => !f.reasoningReadError),
      'a retired or pending reader flashed a failure',
    );
    // Both sets of disclosure choices have been read before these return visits.
    for (const [index, visit] of visits.entries()) {
      if (index < 3) continue;
      const nextClick = observation.clicks[index + 1]!;
      const visible = observation.frames.filter(
        (f) => f.at >= visit.click.at && f.at < nextClick.at && f.title === visit.id && f.body,
      );
      assert.ok(visible.length > 0);
      assert.ok(
        visible.every((f) => f.errorDetail === (visit.id === 0)),
        'a restored Tool disclosure flashed closed or opened',
      );
      if (client === 'desktop') {
        const expected =
          visit.id === 0
            ? ['ROOT_0_THOUGHT_INITIAL', 'ROOT_0_THOUGHT_LIVE', 'ROOT_0_THOUGHT_MORE']
            : ['ROOT_1_THOUGHT_INITIAL'];
        for (const frame of visible)
          assert.deepEqual(
            frame.reasoning,
            expected,
            'restored thinking disappeared or duplicated',
          );
      } else
        assert.ok(
          visible.every((f) => f.successDetail === (visit.id === 1)),
          'a restored public receipt flashed',
        );
    }
    if (client === 'web')
      assert.ok(
        observation.frames.every((f) => f.reasoning.length === 0),
        'ordinary Web History exposed raw reasoning',
      );
    const lastTick = new Map<number, number>();
    for (const f of observation.frames) {
      if (!f.body || f.title === undefined || !f.tick) continue;
      assert.ok(
        f.tick >= (lastTick.get(f.title) ?? 0),
        `visible output went backwards: ${JSON.stringify(f)}`,
      );
      lastTick.set(f.title, f.tick);
    }
    return {
      visits,
      ...observation,
      parked,
      staticHistory,
      reasoningReads,
      finalTicks: { ROOT_0: finalTickA, ROOT_1: finalTickB },
    };
  } catch (error) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
    console.error(
      'last switch observations',
      JSON.stringify(
        await capture.evaluate(({ frames, clicks }) => ({
          frames: frames.slice(-2),
          clicks: clicks.slice(-4),
        })),
      ),
      (
        await page
          .locator(selectors.viewport)
          .innerText()
          .catch(() => '')
      ).slice(0, 1600),
    );
    throw error;
  } finally {
    await capture.evaluate((observation) => observation.stop());
    await capture.dispose();
  }
}
