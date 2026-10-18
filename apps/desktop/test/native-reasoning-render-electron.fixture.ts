import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [outdir, root, executablePath, control] = process.argv.slice(2) as string[];
const app = await _electron.launch({
  executablePath,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 15000,
});
let phase = 'launch';
const diagnostics: string[] = [];
try {
  const page = await app.firstWindow();
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
  const select = async (title: string, id: string) => {
    await page.getByRole('button', { name: title, exact: true }).click();
    await until(
      state,
      (value) => value.selection?.session.id === id && !value.selection.viewLoading,
      `selected ${id}`,
    );
  };
  await select('Reasoning Stream', 'parent');
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
          new URL(args[0] instanceof Request ? args[0].url : String(args[0])).pathname.endsWith(
            '/messages',
          )
        ) {
          const result = (await response.clone().json()) as import('@kite-ai/client').Message[];
          for (const message of Array.isArray(result) ? result : []) {
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
      at: number;
    };
    type Closed = { at: number; height: number; text: string };
    const global = globalThis as typeof globalThis & {
      reasoningRenderProbe: {
        violations: string[];
        mutations: number;
        frames: number;
        phase: string;
        samples: Sample[];
        closedFrames: Closed[];
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
      stop: () => {},
    };
    const probe = global.reasoningRenderProbe;
    let last = '';
    const sample = (kind: string) => {
      const conversation = document.querySelector('.conversation');
      if (!conversation) return;
      const text = conversation.textContent ?? '';
      const visible = (conversation as HTMLElement).innerText;
      if (/ACTUAL_READ_ONLY_TOOL_RESULT|"baseline"|"executionId"/.test(text))
        probe.violations.push(`${kind}:${probe.phase}:raw_tool_json`);
      if (text.includes('PRIVATE_REASONING_SENTINEL'))
        probe.violations.push(`${kind}:${probe.phase}:private_reasoning`);
      if (!['manual-open', 'manual-close', 'history'].includes(probe.phase)) {
        if (conversation.querySelector('.tool-activity-summary[aria-expanded="true"]'))
          probe.violations.push(`${kind}:${probe.phase}:tool_opened_without_user`);
        if (conversation.querySelector('.tool-activity-steps'))
          probe.violations.push(`${kind}:${probe.phase}:tool_items_mounted_without_user`);
      }
      const assistants = conversation.querySelectorAll('.message.assistant').length;
      const final = conversation.querySelectorAll('.agent-turn-final').length;
      if (probe.phase === 'first-reasoning' && assistants)
        probe.violations.push(`${kind}:first-reasoning:assistant_before_body`);
      if (
        ['first-reasoning', 'stage-prose', 'tool', 'second-reasoning', 'body'].includes(
          probe.phase,
        ) &&
        final
      )
        probe.violations.push(`${kind}:${probe.phase}:premature_final`);
      if (probe.phase === 'settled' && visible.includes('正在思考'))
        probe.violations.push(`${kind}:settled:thinking_after_final`);
      const value = {
        phase: probe.phase,
        assistants,
        thinking: visible.includes('正在思考'),
        final,
        at: performance.now(),
      };
      const signature = JSON.stringify([value.phase, assistants, value.thinking, final]);
      if (signature !== last) {
        probe.samples.push(value);
        last = signature;
      }
      const collapsed = conversation.querySelector(
        '.agent-turn-process:has(.agent-turn-summary[aria-expanded="false"])',
      );
      if (collapsed && final) {
        const viewport = conversation.getBoundingClientRect();
        const clipping = collapsed
          .querySelector('.collapsible-motion-content')
          ?.getBoundingClientRect();
        const prose = [...collapsed.querySelectorAll('.message.assistant')].find((node) =>
          node.textContent?.includes('PUBLIC_STAGE_PROSE'),
        );
        const rect = prose?.getBoundingClientRect();
        if (
          rect &&
          clipping &&
          Math.min(rect.bottom, clipping.bottom, viewport.bottom) >
            Math.max(rect.top, clipping.top, viewport.top) + 1
        )
          probe.closedFrames.push({
            at: performance.now(),
            height: clipping.height,
            text: prose!.textContent!.slice(0, 100),
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
          };
        }
      ).reasoningRenderProbe;
      return {
        violations: value.violations.slice(0, 20),
        mutations: value.mutations,
        frames: value.frames,
        samples: value.samples,
        closedFrames: value.closedFrames.slice(0, 20),
      };
    });
  const checkReasoning = async (label: string, expectedAssistants: number) => {
    assert.ok((await content()).includes('正在思考'), `${label}: thinking indicator`);
    assert.equal(
      await page.locator('.conversation .message.assistant').count(),
      expectedAssistants,
      `${label}: only actual prose rendered`,
    );
    assert.equal(
      await page.locator('.conversation .response-status').count(),
      0,
      `${label}: no replying before actual body`,
    );
    assert.deepEqual((await probe()).violations, [], `${label}: no transient disclosure`);
  };
  await setPhase('first-reasoning');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('REASONING_RENDER');
  const send = page.getByRole('button', { name: '发送明确的新轮次', exact: true });
  await until(() => send.isEnabled(), Boolean, 'send enabled');
  await send.click();
  await until(
    messages,
    (value) => value.some((message) => message.firstOutput === 'reasoning'),
    'real reasoning first output',
  );
  await until(content, (value) => value.includes('正在思考'), 'first reasoning painted');
  await page.waitForTimeout(300);
  await checkReasoning('inline-reasoning', 0);
  await step('long');
  await until(
    messages,
    (value) => value.some((message) => Number(message.outputBody?.reasoningBytes) > 100000),
    'reasoning Artifact recorded',
  );
  await page.waitForTimeout(300);
  await checkReasoning('artifact-reasoning', 0);
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
        .length === 2,
    'third reasoning Model recorded',
  );
  await setPhase('second-reasoning');
  await until(content, (value) => value.includes('正在思考'), 'third Model thinking indicator');
  await page.waitForTimeout(300);
  await checkReasoning('second-reasoning', 1);
  await until(content, (value) => value.includes('读取 3 次'), 'actual reads aggregated');
  assert.equal(
    await page.locator('.conversation .tool-activity-summary').getAttribute('aria-expanded'),
    'false',
    'tool aggregation starts collapsed while the Model continues',
  );
  assert.equal(await page.locator('.conversation .tool-activity-steps').count(), 0);
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
  assert.equal(await page.locator('.agent-turn-final').count(), 0);
  assert.equal(await page.locator('.message-copy[aria-label="复制本轮Agent回复"]').count(), 0);
  await step('later-reasoning');
  await page.waitForTimeout(400);
  assert.equal(
    await page.locator('.conversation .tool-activity-summary').getAttribute('aria-expanded'),
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
  assert.deepEqual(
    warm.closedFrames,
    [],
    'completed default-collapsed process must not paint former phase prose',
  );
  await setPhase('manual-open');
  await page.locator('.agent-turn-summary[aria-expanded="false"]').click();
  await until(
    content,
    (value) => value.includes('PUBLIC_STAGE_PROSE') && value.includes('读取 3 次'),
    'user opens original phase prose and read group',
  );
  await page.locator('.tool-activity-summary[aria-expanded="false"]').click();
  await until(
    content,
    (value) => value.includes('PUBLIC_STAGE_PROSE') && value.includes('read-only.txt'),
    'user opens original phase prose and actual read record',
  );
  assert.deepEqual((await probe()).violations, []);
  await page.locator('.agent-turn-content').evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.evaluate(() => {
    (
      globalThis as unknown as { reasoningRenderProbe: { closedFrames: unknown[] } }
    ).reasoningRenderProbe.closedFrames = [];
  });
  await setPhase('manual-close');
  await page.locator('.agent-turn-summary[aria-expanded="true"]').click();
  await page.waitForTimeout(100);
  const manual = await probe();
  assert.ok(manual.closedFrames.length > 0, 'explicit user close retains the existing animation');
  await page.waitForTimeout(350);
  assert.ok(!(await content()).includes('PUBLIC_STAGE_PROSE'), 'explicit process close finishes');

  await setPhase('history');
  await select('Other Stream', 'other');
  await select('Reasoning Stream', 'parent');
  await until(
    content,
    (value) => value.includes('PUBLIC_FINAL_REPLY'),
    'reopened warm history visible',
  );
  assert.ok(!(await content()).includes('正在思考'));
  assert.deepEqual((await probe()).violations, []);
  await page.reload();
  await page.getByRole('button', { name: 'Reasoning Stream', exact: true }).click();
  await until(content, (value) => value.includes('PUBLIC_FINAL_REPLY'), 'cold history visible');
  await page.waitForTimeout(400);
  const cold = await probe();
  assert.deepEqual(cold.violations, []);
  assert.ok(!(await content()).includes('正在思考'));
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
  const page = await app.firstWindow().catch(() => undefined);
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
  await app.evaluate(({ app }) => app.quit());
  await exited;
}
