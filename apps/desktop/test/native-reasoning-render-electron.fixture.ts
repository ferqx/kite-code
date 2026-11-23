import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron, type Locator } from 'playwright';
import { loopbackModelEnvironment } from '../../../tests/fixtures/loopback-model-environment';
import type { NativeState } from '../src/native-bridge';
import { selectNativeFixtureModel } from './native-model-selection.fixture';
import { nativeRootPage } from './native-root-page.fixture';

const [outdir, root, executablePath, control] = process.argv.slice(2) as string[];
const app = await _electron.launch({
  executablePath,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: {
    HOME: root!,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    ...loopbackModelEnvironment(new URL(control!)),
  },
  timeout: 15000,
});
let phase = 'launch';
const diagnostics: string[] = [];
try {
  const page = await nativeRootPage(app, 15000);
  await page.bringToFront();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => diagnostics.push(error.message));
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, label: string) {
    const deadline = Date.now() + 20000;
    for (;;) {
      const value = await read();
      if (check(value)) return value;
      assert.ok(Date.now() < deadline, label);
      await page.waitForTimeout(20);
    }
  }
  const waitForDisclosure = (locator: Locator) =>
    locator.evaluate(async (element) => {
      // Scroll-linked edge fades do not finish while stationary.
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.timeline === element.ownerDocument.timeline &&
              Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
              animation.playState !== 'finished' &&
              animation.playState !== 'idle',
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  const select = async (title: string, id: string) => {
    await page.getByRole('button', { name: title, exact: true }).click();
    await until(
      state,
      (value) => value.selection?.session.id === id && !value.selection.viewLoading,
      `selected ${id}`,
    );
  };
  await select('Reasoning Stream', 'parent');
  await app.evaluate(({ app, BaseWindow }) => {
    const windows = BaseWindow.getAllWindows();
    if (windows.length !== 1) throw Error('reasoning_window_identity_changed');
    windows[0]!.show();
    windows[0]!.focus();
    app.focus({ steal: true });
  });
  await page.bringToFront();
  await until(
    () => page.evaluate(() => document.hasFocus()),
    Boolean,
    'ordinary reasoning window focused',
  );
  assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '保留草稿', exact: true }).count(), 0);
  for (const kind of ['permission.trust', 'permission.mode'] as const) {
    await page.evaluate(async (kind) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const fresh = (await window.kiteNative!.request({
          method: 'permission.refresh',
          generation: 1,
        })) as NativeState;
        const observationId = fresh.selection!.permissions!.observationId;
        try {
          await window.kiteNative!.request(
            kind === 'permission.trust'
              ? { method: kind, generation: 1, observationId, trusted: true }
              : { method: kind, generation: 1, observationId, mode: 'full', makeDefault: false },
          );
          return;
        } catch (cause) {
          if (
            attempt === 5 ||
            !(cause instanceof Error) ||
            cause.message !== 'permission_observation_changed'
          )
            throw cause;
        }
      }
    }, kind);
  }
  await app.evaluate(() => {
    const global = globalThis as typeof globalThis & {
      reasoningMessages: import('@kite-ai/client').Message[];
      toolFactGate: { hold: boolean; blocked: number; releases: (() => void)[] };
    };
    global.reasoningMessages = [];
    global.toolFactGate = { hold: true, blocked: 0, releases: [] };
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        const path = new URL(args[0] instanceof Request ? args[0].url : String(args[0])).pathname;
        if (response.ok && /\/executions\/[^/]+$/.test(path)) {
          const execution = (await response.clone().json()) as { kind?: string; status?: string };
          if (
            execution.kind === 'tool' &&
            !['planned', 'dispatching', 'running'].includes(execution.status ?? '') &&
            global.toolFactGate.hold
          ) {
            global.toolFactGate.blocked++;
            await new Promise<void>((resolve) => global.toolFactGate.releases.push(resolve));
          }
        }
        if (
          response.ok &&
          /\/(?:messages|message-changes)$/.test(
            new URL(args[0] instanceof Request ? args[0].url : String(args[0])).pathname,
          )
        ) {
          const result = (await response.clone().json()) as
            | import('@kite-ai/client').Message[]
            | { messages: import('@kite-ai/client').Message[] };
          for (const message of Array.isArray(result) ? result : result.messages) {
            const index = global.reasoningMessages.findIndex((old) => old.id === message.id);
            if (index < 0) global.reasoningMessages.push(message);
            else global.reasoningMessages[index] = message;
          }
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
  const installProbe = () => {
    type Sample = {
      phase: string;
      assistants: number;
      thinking: boolean;
      final: number;
      timer: string;
      at: number;
    };
    type Closed = { at: number; height: number; text: string };
    type ProtectedDetails = {
      reasoning: HTMLElement;
      reasoningStep: HTMLElement;
      tool: HTMLElement;
      toolBody: HTMLElement;
      reasoningText: string;
      toolText: string;
      focus: Element | null;
      selection: string;
    };
    const global = globalThis as typeof globalThis & {
      reasoningRenderProbe: {
        violations: string[];
        mutations: number;
        frames: number;
        phase: string;
        samples: Sample[];
        closedFrames: Closed[];
        protectedFrames: number;
        protectedMutations: number;
        protect: (reasoning: HTMLElement, tool: HTMLElement, toolBody: HTMLElement) => void;
        unprotect: () => void;
        stop: () => void;
      };
    };
    global.reasoningRenderProbe = {
      violations: [],
      mutations: 0,
      frames: 0,
      phase: 'finished',
      samples: [],
      closedFrames: [],
      protectedFrames: 0,
      protectedMutations: 0,
      protect: () => {},
      unprotect: () => {},
      stop: () => {},
    };
    const probe = global.reasoningRenderProbe;
    let last = '';
    let originalTimer: HTMLElement | undefined;
    let lastElapsed = 0;
    let details: ProtectedDetails | undefined;
    probe.protect = (reasoning, tool, toolBody) => {
      const reasoningStep = reasoning.closest<HTMLElement>('.conversation-reasoning')!;
      const range = document.createRange();
      range.selectNodeContents(reasoning);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      details = {
        reasoning,
        reasoningStep,
        tool,
        toolBody,
        reasoningText: reasoning.textContent,
        toolText: tool.textContent,
        focus: document.activeElement,
        selection: selection.toString(),
      };
    };
    probe.unprotect = () => {
      details = undefined;
      getSelection()?.removeAllRanges();
    };
    const sample = (kind: string) => {
      const conversation = document.querySelector('.conversation');
      if (!conversation) return;
      const text = conversation.textContent ?? '';
      const visible = (conversation as HTMLElement).innerText;
      if (/ACTUAL_READ_ONLY_TOOL_RESULT|"baseline"|"executionId"/.test(text))
        probe.violations.push(`${kind}:${probe.phase}:raw_tool_json`);
      const reasoningOpen = [
        'reasoning-open',
        'tool-reasoning-open',
        'settled-reasoning-open',
      ].includes(probe.phase);
      if (text.includes('PRIVATE_REASONING_SENTINEL') && !reasoningOpen)
        probe.violations.push(`${kind}:${probe.phase}:reasoning_disclosed_without_user`);
      if (details) {
        if (kind === 'frame') probe.protectedFrames++;
        else probe.protectedMutations++;
        if (
          !details.reasoning.isConnected ||
          details.reasoning.textContent !== details.reasoningText ||
          details.reasoningStep.querySelector(':scope > button')?.getAttribute('aria-expanded') !==
            'true' ||
          !details.reasoning.getClientRects().length ||
          details.reasoningStep.textContent.includes('暂时无法读取思考内容')
        )
          probe.violations.push(`${kind}:${probe.phase}:open_reasoning_changed`);
        if (
          !details.toolBody.isConnected ||
          details.tool.textContent !== details.toolText ||
          details.tool
            .querySelector('button.tool-activity-summary')
            ?.getAttribute('aria-expanded') !== 'true' ||
          !details.toolBody.getClientRects().length
        )
          probe.violations.push(`${kind}:${probe.phase}:completed_tool_changed`);
        if (
          document.activeElement !== details.focus ||
          getSelection()?.toString() !== details.selection
        )
          probe.violations.push(`${kind}:${probe.phase}:protected_reading_position_changed`);
      }
      if (
        !reasoningOpen &&
        !['manual-open', 'manual-close', 'tools-complete-open', 'history'].includes(probe.phase)
      ) {
        if (conversation.querySelector('.conversation-trace-trigger[aria-expanded="true"]'))
          probe.violations.push(`${kind}:${probe.phase}:tool_opened_without_user`);
        if (conversation.querySelector('.conversation-trace-steps'))
          probe.violations.push(`${kind}:${probe.phase}:tool_items_mounted_without_user`);
      }
      for (const body of conversation.querySelectorAll('.conversation-reasoning-body')) {
        const owner = body.closest('.conversation-reasoning');
        const disclosure = owner?.querySelector(':scope > button');
        if (
          !disclosure ||
          (disclosure.getAttribute('aria-expanded') === 'true' &&
            disclosure.getAttribute('aria-controls') !== body.id)
        )
          probe.violations.push(`${kind}:${probe.phase}:reasoning_outside_own_disclosure`);
      }
      const assistants = conversation.querySelectorAll('.message.assistant').length;
      const final = conversation.querySelectorAll('.agent-turn-final').length;
      const timers = conversation.querySelectorAll<HTMLElement>('.agent-turn-running');
      const timer = timers[0];
      const timerText = timer?.innerText.replace(/\s+/g, ' ').trim() ?? '';
      if (timers.length > 1) probe.violations.push(`${kind}:${probe.phase}:duplicate_timer`);
      if (timer) {
        originalTimer ??= timer;
        if (timer !== originalTimer) probe.violations.push(`${kind}:${probe.phase}:replaced_timer`);
        if (timer.parentElement?.firstElementChild !== timer)
          probe.violations.push(`${kind}:${probe.phase}:timer_moved_from_turn_start`);
        const duration = /^进行中 (?:(\d+) 天 )?(?:(\d+) 小时 )?(?:(\d+) 分 )?(\d+) 秒$/.exec(
          timerText,
        );
        if (!duration) probe.violations.push(`${kind}:${probe.phase}:invalid_timer_text`);
        else {
          const [, days, hours, minutes, seconds] = duration;
          const elapsed =
            Number(days ?? 0) * 86400 +
            Number(hours ?? 0) * 3600 +
            Number(minutes ?? 0) * 60 +
            Number(seconds);
          if (elapsed < 1) probe.violations.push(`${kind}:${probe.phase}:timer_below_one_second`);
          if (elapsed < lastElapsed)
            probe.violations.push(`${kind}:${probe.phase}:timer_moved_backwards`);
          lastElapsed = elapsed;
        }
      } else if (
        originalTimer &&
        [
          'before-output',
          'first-reasoning',
          'reasoning-open',
          'stage-prose',
          'tool',
          'tools-complete',
          'tools-complete-open',
          'tool-reasoning-open',
          'second-reasoning',
          'body',
        ].includes(probe.phase)
      ) {
        probe.violations.push(`${kind}:${probe.phase}:timer_disappeared`);
      }
      if (
        timer &&
        ['settled', 'manual-open', 'manual-close', 'settled-reasoning-open', 'history'].includes(
          probe.phase,
        )
      )
        probe.violations.push(`${kind}:${probe.phase}:timer_after_settlement`);
      if (probe.phase === 'first-reasoning' && assistants)
        probe.violations.push(`${kind}:first-reasoning:assistant_before_body`);
      if (
        [
          'first-reasoning',
          'stage-prose',
          'tool',
          'tools-complete',
          'tools-complete-open',
          'tool-reasoning-open',
          'second-reasoning',
          'body',
        ].includes(probe.phase) &&
        final
      )
        probe.violations.push(`${kind}:${probe.phase}:premature_final`);
      if (probe.phase === 'settled' && visible.includes('思考中'))
        probe.violations.push(`${kind}:settled:thinking_after_final`);
      const segments = [
        ...conversation.querySelectorAll(
          '.conversation-trace-trigger:not(.conversation-trace-steps *)',
        ),
      ].map((button) => {
        const label = button.textContent;
        if (
          /^(进行中|等待工具执行|正在等待|等待处理|正在停止|需要恢复|执行状态待确认)/.test(label) ||
          (label === '思考中' && !button.querySelector('[data-status="running"]'))
        )
          probe.violations.push(`${kind}:${probe.phase}:trace_borrowed_turn_activity`);
        return {
          text: label,
          running: !!button.querySelector('[data-status="running"]'),
        };
      });
      if (
        ['tools-complete', 'tools-complete-open'].includes(probe.phase) &&
        (segments.length !== 2 ||
          segments[1]?.text !== '已读取 read-only.txt' ||
          segments[1].running)
      )
        probe.violations.push(`${kind}:${probe.phase}:unfinished_trace_lost_latest_tool`);
      if (
        probe.phase === 'body' &&
        visible.includes('PUBLIC_LIVE_PREFIX') &&
        (segments.length !== 2 ||
          segments[1]?.text !== '检查了文件读取了文件' ||
          segments[1].running)
      )
        probe.violations.push(`${kind}:${probe.phase}:finished_trace_missing_tool_summary`);
      if (visible.includes('PUBLIC_STAGE_PROSE') && segments.length > 1) {
        if (segments[0]?.running || /正在|待确认/.test(segments[0]?.text ?? ''))
          probe.violations.push(`${kind}:${probe.phase}:settled_segment_borrowed_turn_activity`);
      }
      const value = {
        phase: probe.phase,
        assistants,
        thinking: visible.includes('思考中'),
        final,
        segments,
        timer: timerText,
        at: performance.now(),
      };
      const signature = JSON.stringify([
        value.phase,
        assistants,
        value.thinking,
        final,
        segments,
        timerText,
      ]);
      if (signature !== last) {
        probe.samples.push(value);
        last = signature;
      }
      for (const collapsed of conversation.querySelectorAll(
        '.conversation-trace:has(> .conversation-trace-trigger[aria-expanded="false"])',
      )) {
        const viewport = conversation.getBoundingClientRect();
        const clipping = collapsed
          .querySelector('.collapsible-motion-content')
          ?.getBoundingClientRect();
        const step = collapsed.querySelector('.conversation-trace-steps > .tool-activity');
        const rect = step?.getBoundingClientRect();
        if (
          rect &&
          clipping &&
          Math.min(rect.bottom, clipping.bottom, viewport.bottom) >
            Math.max(rect.top, clipping.top, viewport.top) + 1
        )
          probe.closedFrames.push({
            at: performance.now(),
            height: clipping.height,
            text: step!.textContent!.slice(0, 100),
          });
      }
    };
    const observer = new MutationObserver(() => {
      probe.mutations++;
      sample('mutation');
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'data-state', 'hidden'],
    });
    let frame = 0;
    const tick = () => {
      probe.frames++;
      sample('frame');
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    probe.stop = () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  };
  await page.addInitScript(installProbe);
  await page.evaluate(installProbe);
  const setPhase = async (value: string) => {
    phase = value;
    console.log('native_reasoning_phase', value);
    await page.evaluate((value) => {
      (
        globalThis as unknown as { reasoningRenderProbe: { phase: string } }
      ).reasoningRenderProbe.phase = value;
    }, value);
  };
  const content = () => page.locator('.conversation').innerText();
  const messages = () =>
    app.evaluate(
      () =>
        (globalThis as unknown as { reasoningMessages: import('@kite-ai/client').Message[] })
          .reasoningMessages,
    );
  const step = (stage: string) =>
    fetch(`${control}/step?stage=${stage}`).then((response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
  const counts = () =>
    fetch(`${control}/count`).then((response) => response.json()) as Promise<{
      calls: number;
      active: boolean;
      toolObserved: boolean;
    }>;
  const probe = () =>
    page.evaluate(() => {
      const value = (
        globalThis as unknown as {
          reasoningRenderProbe: {
            violations: string[];
            mutations: number;
            frames: number;
            samples: unknown[];
            closedFrames: unknown[];
            protectedFrames: number;
            protectedMutations: number;
          };
        }
      ).reasoningRenderProbe;
      return {
        violations: value.violations.slice(0, 20),
        mutations: value.mutations,
        frames: value.frames,
        samples: value.samples,
        closedFrames: value.closedFrames.slice(0, 20),
        protectedFrames: value.protectedFrames,
        protectedMutations: value.protectedMutations,
      };
    });
  const checkBeforeReply = async (label: string, expectedAssistants: number) => {
    assert.equal(
      await page.locator('.conversation .message.assistant').count(),
      expectedAssistants,
      `${label}: only actual prose rendered`,
    );
    assert.equal(
      await page.locator('.conversation .response-status').count(),
      0,
      `${label}: running timer is the only reply status`,
    );
    assert.deepEqual((await probe()).violations, [], `${label}: no transient disclosure`);
  };
  const resetClosedFrames = () =>
    page.evaluate(() => {
      const probe = (globalThis as unknown as { reasoningRenderProbe: { closedFrames: unknown[] } })
        .reasoningRenderProbe;
      probe.closedFrames = [];
    });
  await setPhase('before-output');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('REASONING_RENDER');
  const send = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
  await selectNativeFixtureModel(page, 'fixture');
  await until(() => send.isEnabled(), Boolean, 'send enabled');
  await send.click();
  const timer = page.locator('.agent-turn-running');
  await timer.waitFor({ state: 'visible' });
  const readTimer = async () => (await timer.innerText()).replace(/\s+/g, ' ').trim();
  const initialTiming = await readTimer();
  assert.match(initialTiming, /^进行中 \d+ 秒$/);
  const advancedTiming = await until(readTimer, (value) => value !== initialTiming, 'elapsed tick');
  assert.match(advancedTiming, /^进行中 \d+ 秒$/);
  assert.ok(Number(advancedTiming.match(/\d+/)![0]) > Number(initialTiming.match(/\d+/)![0]));
  assert.equal(await page.locator('.conversation .message.assistant').count(), 0);
  assert.equal((await messages()).filter((message) => message.role === 'assistant').length, 0);
  await until(
    counts,
    (value) => value.calls === 1 && value.active,
    'first Model waiting for output',
  );
  await setPhase('first-reasoning');
  await step('initial-reasoning');
  await until(
    messages,
    (value) => value.some((message) => message.firstOutput === 'reasoning'),
    'real reasoning first output',
  );
  await until(content, (value) => value.includes('思考中'), 'first reasoning painted');
  await page.waitForTimeout(300);
  assert.ok((await content()).includes('思考中'), 'inline reasoning keeps its own heading');
  await checkBeforeReply('inline-reasoning', 0);
  await setPhase('reasoning-open');
  const thought = page.locator('.conversation-reasoning > button');
  const arrow = thought.locator('.conversation-trace-chevron');
  assert.equal(await arrow.evaluate((element) => getComputedStyle(element).opacity), '0');
  await thought.hover();
  assert.equal(await arrow.evaluate((element) => getComputedStyle(element).opacity), '1');
  await thought.click();
  await until(
    content,
    (value) => value.includes('PRIVATE_REASONING_SENTINEL_INITIAL'),
    'manually opened public reasoning',
  );
  const reasoningBody = page.locator('.conversation-reasoning-body .typeset-chat');
  assert.equal(await page.locator('.conversation .conversation-trace-trigger').count(), 1);
  assert.equal(await thought.innerText(), '正在思考…');
  assert.equal(await thought.getAttribute('aria-expanded'), 'true');
  assert.equal(
    await thought.getAttribute('aria-controls'),
    await page.locator('.conversation-reasoning-body').getAttribute('id'),
    'reasoning text is owned by the independent accessible thinking step',
  );
  await thought.focus();
  await page.keyboard.press('Enter');
  await until(
    content,
    (value) => !value.includes('PRIVATE_REASONING_SENTINEL_INITIAL'),
    'keyboard closes only reasoning',
  );
  assert.equal(await thought.getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Space');
  await until(
    content,
    (value) => value.includes('PRIVATE_REASONING_SENTINEL_INITIAL'),
    'keyboard reopens only reasoning',
  );
  await reasoningBody.locator('strong').getByText('PRIVATE_REASONING_SENTINEL_INITIAL').waitFor();
  const paragraph = reasoningBody.getByText('核对原记录。', { exact: true });
  await waitForDisclosure(page.locator('.conversation-trace'));
  await paragraph.scrollIntoViewIfNeeded();
  const textBounds = await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().toJSON();
  });
  const y = (textBounds.top + textBounds.bottom) / 2;
  await page.mouse.move(textBounds.left + 2, y);
  assert.equal(await arrow.evaluate((element) => getComputedStyle(element).opacity), '1');
  await page.mouse.down();
  await page.mouse.move(textBounds.right + 1, y, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '核对原记录。');
  assert.equal(await thought.getAttribute('aria-expanded'), 'true');
  await thought.click();
  await until(
    content,
    (value) => !value.includes('PRIVATE_REASONING_SENTINEL_INITIAL'),
    'public reasoning closed',
  );
  await setPhase('first-reasoning');
  await step('long');
  await until(
    messages,
    (value) => value.some((message) => Number(message.outputBody?.reasoningBytes) > 100000),
    'reasoning Artifact recorded',
  );
  await page.waitForTimeout(300);
  assert.ok((await content()).includes('思考中'), 'artifact reasoning keeps its own heading');
  await checkBeforeReply('artifact-reasoning', 0);
  const reasoningArtifactBytes = Math.max(
    ...(await messages()).map((message) => Number(message.outputBody?.reasoningBytes ?? 0)),
  );
  await setPhase('stage-prose');
  await step('stage-prose');
  await until(
    content,
    (value) => value.includes('PUBLIC_STAGE_PROSE'),
    'legitimate phase prose visible',
  );
  assert.equal(await page.locator('.agent-turn-final').count(), 0);
  await setPhase('tool');
  await step('tool');
  await until(
    counts,
    (value) => value.calls === 2 && value.toolObserved,
    'actual files.read reaches next Model',
  );
  await until(
    messages,
    (value) =>
      value.some(
        (message) =>
          message.role === 'tool' && message.content.includes('ACTUAL_READ_ONLY_TOOL_RESULT'),
      ),
    'real Tool receipt published while facts held',
  );
  const heldToolFacts = await until(
    () =>
      app.evaluate(
        () => (globalThis as unknown as { toolFactGate: { blocked: number } }).toolFactGate.blocked,
      ),
    (value) => value > 0,
    'real terminal Execution fact held',
  );
  await page.waitForTimeout(300);
  console.log('tool_fact_hold_probe', JSON.stringify(await probe()));
  assert.deepEqual(
    (await probe()).violations,
    [],
    'fact loading must not publish original Tool JSON',
  );
  await app.evaluate(() => {
    const gate = (
      globalThis as unknown as { toolFactGate: { hold: boolean; releases: (() => void)[] } }
    ).toolFactGate;
    gate.hold = false;
    for (const release of gate.releases.splice(0)) release();
  });
  const traceHeadings = page.locator(
    '.conversation-trace-trigger:not(.conversation-trace-steps *)',
  );
  const toolHeading = traceHeadings.nth(1);
  const latestReadTitle = '已读取 read-only.txt';
  await until(
    () => traceHeadings.allTextContents(),
    (labels) => labels.length === 2 && labels[1] === latestReadTitle,
    'the unfinished Trace shows the latest settled read while the next Model is held',
  );
  const originalToolHeading = await toolHeading.elementHandle();
  assert.equal(await toolHeading.getAttribute('aria-expanded'), 'false');
  assert.equal(await toolHeading.locator('[data-status="running"]').count(), 0);
  assert.deepEqual(await traceHeadings.allTextContents(), ['处理过程', latestReadTitle]);
  await setPhase('tools-complete');
  const toolTiming = await readTimer();
  await until(readTimer, (value) => value !== toolTiming, 'Run keeps ticking over the latest read');
  assert.deepEqual(await counts(), { calls: 2, active: true, toolObserved: true });
  await checkBeforeReply('completed-tools', 1);
  assert.deepEqual((await probe()).closedFrames, [], 'closed tools have not painted their details');
  await setPhase('tools-complete-open');
  await toolHeading.click();
  const activeToolSteps = page.locator('.conversation-trace-steps > .tool-activity');
  await until(
    () => activeToolSteps.count(),
    (count) => count === 2,
    'read results open in live Run',
  );
  assert.equal(await toolHeading.textContent(), latestReadTitle);
  const liveTrace = page.locator('.conversation-trace').nth(1);
  const missingTool = activeToolSteps.filter({ hasText: 'missing-read.txt' });
  const missingDisclosure = missingTool.locator('button.tool-activity-summary');
  await missingDisclosure.click();
  const completedDetail = missingTool.locator('.tool-activity-content').getByText('文件不存在', {
    exact: true,
  });
  await completedDetail.waitFor({ state: 'visible' });
  await setPhase('tool-reasoning-open');
  await step('tool-reasoning');
  const liveReasoningDisclosure = liveTrace.locator('.conversation-reasoning > button').first();
  await liveReasoningDisclosure.click();
  const liveReasoning = liveTrace.locator('.conversation-reasoning-body .typeset-chat');
  await liveReasoning.getByText('PRIVATE_REASONING_SENTINEL_TOOL_MODEL', { exact: true }).waitFor();
  await waitForDisclosure(liveTrace);
  await liveReasoningDisclosure.focus();
  await page.evaluate(
    ([reasoning, tool, toolBody]) => {
      (
        globalThis as unknown as {
          reasoningRenderProbe: { protect: (...elements: HTMLElement[]) => void };
        }
      ).reasoningRenderProbe.protect(
        reasoning as HTMLElement,
        tool as HTMLElement,
        toolBody as HTMLElement,
      );
    },
    [
      await liveReasoning.elementHandle(),
      await missingTool.elementHandle(),
      await completedDetail.elementHandle(),
    ],
  );
  const priorToolFacts = await app.evaluate(() => {
    const gate = (globalThis as unknown as { toolFactGate: { hold: boolean; blocked: number } })
      .toolFactGate;
    gate.hold = true;
    return gate.blocked;
  });
  await step('pure-tool');
  await until(
    counts,
    (value) => value.calls === 3 && value.toolObserved,
    'pure-tool Model followed by actual second read and third Model',
  );
  await until(
    messages,
    (value) =>
      value.filter((message) => message.role === 'assistant' && message.firstOutput === 'reasoning')
        .length === 3,
    'third reasoning Model recorded',
  );
  await until(
    () =>
      app.evaluate(
        () => (globalThis as unknown as { toolFactGate: { blocked: number } }).toolFactGate.blocked,
      ),
    (value) => value > priorToolFacts,
    'later Tool settled while the original disclosures stay open',
  );
  await app.evaluate(() => {
    const gate = (
      globalThis as unknown as { toolFactGate: { hold: boolean; releases: (() => void)[] } }
    ).toolFactGate;
    gate.hold = false;
    for (const release of gate.releases.splice(0)) release();
  });
  await until(
    () => activeToolSteps.count(),
    (count) => count === 3,
    'later Tool joined the Trace',
  );
  await until(
    () => traceHeadings.allTextContents(),
    (labels) => labels.length === 2 && labels[1] === latestReadTitle,
    'the latest read stays visible when the third Model emits reasoning',
  );
  await page.waitForTimeout(200);
  const changes = await probe();
  assert.ok(changes.protectedFrames > 0 && changes.protectedMutations > 0);
  assert.deepEqual(
    changes.violations,
    [],
    'expanded reasoning, result and selection survive later Tools',
  );
  assert.equal(await liveTrace.locator('.conversation-reasoning-body .typeset-chat').count(), 1);
  await page.evaluate(() =>
    (
      globalThis as unknown as { reasoningRenderProbe: { unprotect: () => void } }
    ).reasoningRenderProbe.unprotect(),
  );
  await liveReasoningDisclosure.click();
  await missingDisclosure.click();
  await toolHeading.click();
  await until(
    () => activeToolSteps.count(),
    (count) => count === 0,
    'user closes the active Trace after the later Tool',
  );
  await resetClosedFrames();
  await setPhase('second-reasoning');
  await until(
    () => toolHeading.textContent(),
    (value) => value === '思考中',
    'new reasoning takes over the unfinished tool Trace',
  );
  await checkBeforeReply('second-reasoning', 1);
  assert.deepEqual(
    await traceHeadings.allTextContents(),
    ['处理过程', '思考中'],
    'only the current trace shows the current Model phase',
  );
  assert.equal(
    await toolHeading.evaluate((element, original) => element === original, originalToolHeading),
    true,
    'the tool heading retains its node across the Model handoff',
  );
  assert.equal(
    await toolHeading.getAttribute('aria-expanded'),
    'false',
    'tool aggregation stays closed after explicit user action',
  );
  assert.equal(await page.locator('.conversation .conversation-trace-steps').count(), 0);
  assert.ok((await content()).includes('PUBLIC_STAGE_PROSE'), 'actual stage prose preserved');
  const secondMessage = (await messages())
    .filter((message) => message.role === 'assistant')
    .at(-1)!;
  await setPhase('body');
  await step('body');
  await until(
    content,
    (value) => value.includes('PUBLIC_LIVE_PREFIX'),
    'actual prefix visible before Model finish',
  );
  assert.deepEqual(
    await traceHeadings.allTextContents(),
    ['处理过程', '检查了文件读取了文件'],
    'actual prose ends the Trace and summary distinguishes missing files from reads',
  );
  assert.equal(
    await toolHeading.evaluate((element, original) => element === original, originalToolHeading),
    true,
    'the tool heading retains its node when the Trace ends',
  );
  assert.equal(await page.locator('.agent-turn-final').count(), 0);
  assert.equal(await page.locator('.message-copy[aria-label="复制本轮Agent回复"]').count(), 0);
  await step('later-reasoning');
  await page.waitForTimeout(400);
  assert.equal(await toolHeading.textContent(), '检查了文件读取了文件');
  assert.equal(
    await toolHeading.getAttribute('aria-expanded'),
    'false',
    'later Model output does not open tool aggregation',
  );
  assert.ok(
    (await content()).includes('PUBLIC_LIVE_PREFIX'),
    'later reasoning preserves actual body',
  );
  assert.ok(
    (await messages()).some(
      (message) =>
        message.id === secondMessage.id &&
        message.firstOutput === 'reasoning' &&
        message.content.includes('PUBLIC_LIVE_PREFIX'),
    ),
    'historical first reasoning does not hide actual content',
  );
  assert.deepEqual((await probe()).violations, []);
  await setPhase('finished');
  await step('finish');
  const finished = await until(
    state,
    (value) => value.selection!.runs.some((run) => run.status === 'completed' && !run.isActive),
    'original Run completed',
  );
  await until(
    () => page.locator('.agent-turn-final').count(),
    (value) => value === 1,
    'one final reply',
  );
  await until(content, (value) => value.includes('PUBLIC_FINAL_REPLY'), 'final body visible');
  assert.equal(await timer.count(), 0);
  await setPhase('settled');
  await page.waitForTimeout(800);
  const warm = await probe();
  console.log('warm_render_probe', JSON.stringify(warm));
  assert.deepEqual(warm.violations, []);
  assert.equal(finished.selection!.runs.length, 1);
  const actualReadTools = finished.selection!.executions.filter(
    (execution) => execution.definitionId === 'files.read' && execution.status === 'succeeded',
  ).length;
  assert.equal(actualReadTools, 3);
  assert.equal((await counts()).calls, 3);
  assert.ok((await counts()).toolObserved);
  assert.deepEqual(warm.closedFrames, [], 'completed collapsed trace must not paint tool details');
  await setPhase('manual-open');
  const elapsed = page.getByRole('button', { name: /^用时 .*展开本轮处理过程$/ });
  assert.equal(await elapsed.count(), 1);
  const finishedTiming = await elapsed.innerText();
  assert.equal(await page.locator('.conversation .conversation-trace').count(), 0);
  await elapsed.click();
  const readTrace = page.locator('.conversation-trace').filter({ hasText: '读取了文件' });
  const trigger = readTrace.locator(':scope > .conversation-trace-trigger');
  await trigger.click();
  await until(
    content,
    (value) => value.includes('PUBLIC_STAGE_PROSE') && value.includes('read-only.txt'),
    'user opens original phase prose and actual read record',
  );
  assert.equal(
    await readTrace.locator('.conversation-trace-steps > .tool-activity').count(),
    3,
    'the actual aggregate retains all three original read receipts',
  );
  assert.deepEqual((await probe()).violations, []);
  console.log(
    'native_reasoning_animation_state',
    JSON.stringify(
      await readTrace.locator('.conversation-trace-steps').evaluate((element) =>
        element.getAnimations({ subtree: true }).map((animation) => ({
          playState: animation.playState,
          currentTime: animation.currentTime,
          timing: animation.effect?.getTiming(),
          documentTimeline: animation.timeline === element.ownerDocument.timeline,
          timeline: animation.timeline?.constructor.name,
        })),
      ),
    ),
  );
  await waitForDisclosure(readTrace);
  const stepColumns = await readTrace
    .locator('.conversation-trace-steps [data-trace-line]')
    .evaluateAll((rows) =>
      rows.map((row) => ({
        icon: row.querySelector(':scope > [data-slot="trace-icon"]')!.getBoundingClientRect().left,
        label: row.querySelector(':scope > [data-slot="trace-title"]')!.getBoundingClientRect()
          .left,
      })),
    );
  assert.equal(
    stepColumns.length,
    5,
    'two reasoning steps and three expanded tool rows share the trace layout',
  );
  assert.ok(
    stepColumns.every(
      ({ icon, label }) =>
        Math.abs(icon - stepColumns[0]!.icon) < 0.5 &&
        Math.abs(label - stepColumns[0]!.label) < 0.5,
    ),
    'reasoning and tool columns line up',
  );
  await setPhase('settled-reasoning-open');
  const readThought = readTrace.locator('.conversation-reasoning > button').last();
  assert.equal(await readThought.getAttribute('aria-expanded'), 'false');
  await readThought.click();
  await until(
    () => readTrace.innerText(),
    (value) => value.includes('PRIVATE_REASONING_SENTINEL_SECOND_MODEL'),
    'the reasoning from the third Model is readable in its own step',
  );
  assert.equal(await trigger.textContent(), '检查了文件读取了文件');
  await readThought.click();
  await until(
    () => readTrace.innerText(),
    (value) => !value.includes('PRIVATE_REASONING_SENTINEL_SECOND_MODEL'),
    'closing the reasoning step leaves the tool result in place',
  );
  await resetClosedFrames();
  await setPhase('manual-close');
  await trigger.click();
  await page.waitForTimeout(100);
  const manual = await probe();
  assert.ok(manual.closedFrames.length > 0, 'explicit user close retains the existing animation');
  await page.waitForTimeout(350);
  assert.ok(!(await content()).includes('read-only.txt'), 'explicit trace close finishes');
  assert.ok(
    (await content()).includes('PUBLIC_STAGE_PROSE'),
    'stage prose keeps its original place',
  );
  await page.getByRole('button', { name: /^用时 .*收起本轮处理过程$/ }).click();
  await until(content, (value) => !value.includes('PUBLIC_STAGE_PROSE'), 'elapsed process closes');

  await setPhase('history');
  await select('Other Stream', 'other');
  await select('Reasoning Stream', 'parent');
  await until(
    content,
    (value) => value.includes('PUBLIC_FINAL_REPLY'),
    'reopened warm history visible',
  );
  assert.ok(!(await content()).includes('思考中'));
  assert.equal(await timer.count(), 0);
  assert.equal(await elapsed.innerText(), finishedTiming);
  assert.deepEqual((await probe()).violations, []);
  await page.reload();
  await page.getByRole('button', { name: 'Reasoning Stream', exact: true }).click();
  await until(content, (value) => value.includes('PUBLIC_FINAL_REPLY'), 'cold history visible');
  await page.waitForTimeout(400);
  const cold = await probe();
  assert.deepEqual(cold.violations, []);
  assert.equal(await elapsed.count(), 1);
  assert.equal(await timer.count(), 0);
  assert.equal(await elapsed.innerText(), finishedTiming);
  assert.ok(!(await content()).includes('思考中'));
  assert.equal((await counts()).calls, 3);
  const report = {
    warm,
    manual,
    cold,
    reasoningArtifactBytes,
    actualModels: 3,
    actualReadTool: true,
    actualReadTools,
    heldToolFacts,
    diagnosticsAbsent: true,
  };
  console.log(JSON.stringify(report));
  writeFileSync(join(root!, 'render-report.json'), JSON.stringify(report, null, 2));
  await page.evaluate(() =>
    (
      globalThis as unknown as { reasoningRenderProbe: { stop: () => void } }
    ).reasoningRenderProbe.stop(),
  );
} catch (cause) {
  console.error('native_reasoning_render_failed', phase, cause, diagnostics);
  const page = await nativeRootPage(app, 15000).catch(() => undefined);
  if (page) {
    console.error('conversation', await page.locator('.conversation').innerText());
    await page.screenshot({ path: join(root!, 'failure.png') });
  }
  throw cause;
} finally {
  await app
    .evaluate(() => {
      const gate = (
        globalThis as unknown as { toolFactGate?: { hold: boolean; releases: (() => void)[] } }
      ).toolFactGate;
      if (gate) {
        gate.hold = false;
        for (const release of gate.releases.splice(0)) release();
      }
    })
    .catch(() => {});
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  console.log('native_reasoning_phase', 'owned_quit');
  await app.evaluate(({ app }) => app.quit());
  await exited;
  console.log('native_reasoning_phase', 'owned_exited');
}
