import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentClient, Execution, Message as NativeMessage } from '@kite-ai/client';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import { NativeToolMessages } from '../electron/tool-messages';
import type { NativeToolMessageRequest, NativeToolMessageScope } from '../src/tool-messages-bridge';

type Sample = {
  phase: string;
  cause: 'raf' | 'task' | 'mutation';
  time: number;
  activities: {
    node: number;
    text: string;
    expanded: string | null;
    box: number[];
    titleWidth: number;
    chevronBox: number[] | null;
    titleNode: number | null;
    titleBox: number[] | null;
    statusNode: number | null;
    statusText: string;
    statusBox: number[] | null;
    chevronNode: number | null;
  }[];
  messages: { node: number; role: string; text: string; box: number[] }[];
  shells: {
    node: number;
    expanded: boolean;
    commandLength: number;
    viewportNode: number | null;
    scrollTop: number | null;
    headerBox: number[] | null;
  }[];
  selection: string;
  outsideTools: number;
  footer: number[] | null;
  scrollTop: number | null;
  scrollHeight: number | null;
  width: number;
  overflow: boolean;
  conversationOverflow: boolean;
  raw: boolean;
  steps: number;
  nestedButtons: number;
  summaryExtras: number;
  mutations: number;
};
declare global {
  interface Window {
    liveAggregationSamples: Sample[];
    liveAggregationPhase: string;
  }
}
const directory = import.meta.dir;
const handoff = process.env.KITE_AGGREGATION_SCENARIO === 'model-handoff';
const longGroup = process.env.KITE_AGGREGATION_SCENARIO === 'long-group';
const toolDetails = process.env.KITE_AGGREGATION_SCENARIO === 'tool-details';
const nativeShell = process.env.KITE_AGGREGATION_SCENARIO === 'native-shell';
const nativeShellCase = process.env.KITE_NATIVE_SHELL_CASE;
const baseline = process.env.KITE_AGGREGATION_BASELINE === 'pre-empty-model-fix';
let handoffFailures = 0;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'native-live-tool-aggregation-'));
const output = path.join(artifact, 'dist');
await build({
  root: path.dirname(directory),
  configFile: false,
  envFile: false,
  plugins: [
    ...(baseline
      ? [
          {
            name: 'isolated-pre-empty-model-fix',
            enforce: 'pre' as const,
            transform(code: string, id: string) {
              if (!id.endsWith('/apps/desktop/src/native-presentation.ts')) return undefined;
              const projection =
                "      ...(toolDeclaration ? { presentation: 'hidden' as const } : {}),";
              if (!code.includes(projection)) throw Error('fixture_baseline_projection_changed');
              return code.replace(projection, '');
            },
          },
        ]
      : []),
    react(),
    tailwindcss(),
  ],
  base: './',
  logLevel: 'error',
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: output,
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: path.join(directory, 'native-live-tool-aggregation-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/native-shell-metadata' && request.method === 'POST') {
      const fixture = (await request.json()) as {
        messageIds: string[];
        commandOffsets?: Record<string, number>;
        messages: NativeMessage[];
        executions: Execution[];
        observedExecutions: Execution[];
        scope: NativeToolMessageScope;
        input: Extract<NativeToolMessageRequest, { method: 'toolMessages.list' }>;
      };
      const reader = new NativeToolMessages(
        {
          async verifyConnection() {},
          async getExecution(id: string) {
            const execution = fixture.executions.find((value) => value.id === id);
            if (!execution) throw Error('fixture_native_execution_unavailable');
            return execution;
          },
        } as unknown as AgentClient,
        () => fixture.scope,
        () => new Map(fixture.messages.map((message) => [message.id, message])),
        () => fixture.observedExecutions,
      );
      return Response.json((await reader.list(fixture.input)).entries);
    }
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (pathname === '/')
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = path.resolve(output, `.${pathname}`);
    return file.startsWith(output + path.sep)
      ? new Response(Bun.file(file))
      : new Response(null, { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });
const report = {
  browser: browser.version(),
  scenario: handoff
    ? 'model-handoff'
    : longGroup
      ? 'long-group'
      : toolDetails
        ? 'tool-details'
        : nativeShell
          ? 'native-shell'
          : 'mixed-tools',
  baseline: baseline
    ? 'current code with only toolDeclaration hidden projection disabled in isolated build'
    : undefined,
  nativeShellCase: nativeShell ? nativeShellCase : undefined,
  cases: [] as {
    theme: string;
    width: number;
    errors: string[];
    screenshotFrames: number;
    samples: Sample[];
    verification?: Record<string, unknown>;
  }[],
};
try {
  for (const { theme, width } of handoff || longGroup || toolDetails || nativeShell
    ? [
        { theme: 'light' as const, width: 1280 },
        { theme: 'dark' as const, width: 780 },
      ]
    : [
        { theme: 'light' as const, width: 1280 },
        { theme: 'dark' as const, width: 780 },
        { theme: 'dark' as const, width: 390 },
      ]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      colorScheme: theme,
      locale: 'zh-CN',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const label = `${theme}-${width}`;
    const frames = path.join(artifact, `${label}-frames`);
    mkdirSync(frames);
    const cdp = await page.context().newCDPSession(page);
    let screenshotFrames = 0;
    cdp.on('Page.screencastFrame', (event) => {
      writeFileSync(
        path.join(frames, `${String(screenshotFrames++).padStart(4, '0')}.jpg`),
        Buffer.from(event.data, 'base64'),
      );
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 });
    await page.addInitScript(() => {
      const identities = new WeakMap<Element, number>();
      let next = 1,
        mutations = 0;
      const id = (node: Element) => {
        let value = identities.get(node);
        if (!value) {
          value = next++;
          identities.set(node, value);
        }
        return value;
      };
      window.liveAggregationSamples = [];
      window.liveAggregationPhase = 'boot';
      const sample = (cause: Sample['cause']) => {
        const conversation = [...document.querySelectorAll('.conversation')].find(
          (node) => node.getBoundingClientRect().height > 0,
        );
        const viewport = conversation?.querySelector<HTMLElement>('.conversation-viewport');
        const footer = [...document.querySelectorAll('.conversation-footer')]
          .find((node) => node.getBoundingClientRect().height > 0)
          ?.getBoundingClientRect();
        const activities = [...(conversation?.querySelectorAll('.tool-activity') ?? [])].filter(
          (node) => !node.parentElement?.closest('.tool-activity'),
        );
        window.liveAggregationSamples.push({
          phase: window.liveAggregationPhase,
          cause,
          time: performance.now(),
          activities: activities.map((node) => {
            const box = node.getBoundingClientRect();
            const title = node.querySelector('.tool-activity-title')?.getBoundingClientRect();
            const chevron = node.querySelector('.tool-activity-chevron')?.getBoundingClientRect();
            const status = node.querySelector(
              ':scope > .tool-activity-summary .tool-activity-state',
            );
            const boxOf = (element: Element | null) => {
              const rect = element?.getBoundingClientRect();
              return rect ? [rect.x, rect.y, rect.width, rect.height] : null;
            };
            const titleElement = node.querySelector('.tool-activity-title');
            const chevronElement = node.querySelector('.tool-activity-chevron');
            return {
              node: id(node),
              text:
                node.querySelector('.tool-activity-title')?.textContent ?? node.textContent ?? '',
              expanded:
                node.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded') ?? null,
              box: [box.x, box.y, box.width, box.height],
              titleWidth: title?.width ?? 0,
              chevronBox: chevron ? [chevron.x, chevron.y, chevron.width, chevron.height] : null,
              titleNode: titleElement ? id(titleElement) : null,
              titleBox: boxOf(titleElement),
              statusNode: status ? id(status) : null,
              statusText: status?.textContent ?? '',
              statusBox: boxOf(status),
              chevronNode: chevronElement ? id(chevronElement) : null,
            };
          }),
          messages: [...(conversation?.querySelectorAll('.message') ?? [])].map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              node: id(node),
              role: node.className,
              text: node.textContent?.slice(0, 240) ?? '',
              box: [rect.x, rect.y, rect.width, rect.height],
            };
          }),
          shells: [...(conversation?.querySelectorAll('.shell-activity') ?? [])].map((node) => {
            const viewport = node.querySelector<HTMLElement>('.shell-output-viewport');
            const header = node.querySelector('.shell-output-header')?.getBoundingClientRect();
            return {
              node: id(node),
              expanded:
                node.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded') ===
                'true',
              commandLength: node.querySelector('.shell-command-text')?.textContent?.length ?? 0,
              viewportNode: viewport ? id(viewport) : null,
              scrollTop: viewport?.scrollTop ?? null,
              headerBox: header ? [header.x, header.y, header.width, header.height] : null,
            };
          }),
          selection: getSelection()?.toString() ?? '',
          outsideTools: [...(conversation?.querySelectorAll('.tool-activity-step') ?? [])].filter(
            (node) => !node.closest('.tool-activity-steps'),
          ).length,
          footer: footer ? [footer.x, footer.y, footer.width, footer.height] : null,
          scrollTop: viewport?.scrollTop ?? null,
          scrollHeight: viewport?.scrollHeight ?? null,
          width: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
          conversationOverflow: !!viewport && viewport.scrollWidth > viewport.clientWidth + 1,
          raw: conversation?.textContent?.includes('PRIVATE_RAW_RECEIPT_SENTINEL') ?? false,
          steps: conversation?.querySelectorAll('.tool-activity-steps > *').length ?? 0,
          nestedButtons: conversation?.querySelectorAll('button button').length ?? 0,
          summaryExtras: activities.reduce(
            (count, node) =>
              count +
              node.querySelectorAll(
                ':scope > .tool-activity-summary :is(.tool-activity-state,.tool-activity-count,.tool-approval,.tool-step-status)',
              ).length,
            0,
          ),
          mutations,
        });
      };
      const tick = () => {
        sample('raf');
        setTimeout(() => sample('task'), 0);
        requestAnimationFrame(tick);
      };
      addEventListener('DOMContentLoaded', () =>
        new MutationObserver(() => {
          mutations++;
          sample('mutation');
        }).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        }),
      );
      requestAnimationFrame(tick);
    });
    await page.goto(`${server.url}${toolDetails ? '?island=tool-details' : ''}`);
    if (!toolDetails) await page.getByRole('button', { name: 'Session A', exact: true }).click();
    await page.waitForFunction(
      () =>
        !!document.querySelector('.conversation-viewport') &&
        !document.querySelector('.conversation-loading'),
    );
    const stage = async (name: string, perform?: () => void) => {
      await page.evaluate((phase) => {
        window.liveAggregationPhase = phase;
      }, name);
      if (perform) await page.evaluate(perform);
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(artifact, `${label}-${name}.png`) });
    };
    if (nativeShell) {
      const allCases = [
        { kind: 'launch', title: '已请求运行', footer: /已受理/, success: false },
        { kind: 'read', title: '已读取输出', footer: /执行中/, success: false },
        { kind: 'wait', title: '等待超时', footer: /等待超时.*命令仍在运行/, success: false },
        { kind: 'stop', title: '已请求停止', footer: /已请求停止.*等待结束/, success: false },
        { kind: 'execute', title: '已运行', footer: /^成功$/, success: true },
        { kind: 'execute-large', title: '已运行', footer: /^成功$/, success: true },
        { kind: 'execute-model-late', title: '已运行', footer: /^成功$/, success: true },
        { kind: 'execute-failed', title: '运行失败', footer: /失败.*退出码 7/, success: false },
        { kind: 'execute-unknown', title: '结果未知', footer: /结果未知/, success: false },
        { kind: 'execute-rejected', title: '运行命令', footer: null, success: false },
        { kind: 'execute-live', title: '已运行', footer: /^成功$/, success: true },
      ] as const;
      const cases = allCases.filter((entry) => !nativeShellCase || entry.kind === nativeShellCase);
      assert.ok(cases.length > 0, 'unknown Native Shell case filter');
      const verified = [];
      const priorNativeSamples: Sample[] = [];
      const priorNativeRequests: Extract<
        NativeToolMessageRequest,
        { method: 'toolMessages.list' }
      >[] = [];
      let coldVerification: unknown;
      const commandTail = async (
        item: ReturnType<typeof page.locator>,
        aggregate: ReturnType<typeof page.locator>,
        phase: string,
      ) => {
        const outer = aggregate.locator('.tool-activity-viewport').first();
        await outer.focus();
        await page.keyboard.press('End');
        await stage(phase);
        const geometry = await item.locator('.shell-command-text').evaluate((node) => {
          const text = node.firstChild!;
          const range = document.createRange();
          const length = text.textContent!.length;
          range.setStart(text, Math.max(0, length - 2));
          range.setEnd(text, length);
          const tail = range.getBoundingClientRect();
          const clip = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
          return {
            tailTop: tail.top,
            tailBottom: tail.bottom,
            clipTop: clip.top,
            clipBottom: clip.bottom,
            whiteSpace: getComputedStyle(node).whiteSpace,
            headerHeight: node.closest('.shell-output-header')!.getBoundingClientRect().height,
          };
        });
        assert.equal(geometry.whiteSpace, 'pre-wrap');
        assert.ok(
          geometry.tailTop >= geometry.clipTop - 1 &&
            geometry.tailBottom <= geometry.clipBottom + 1,
          `full command tail inaccessible in aggregate: ${JSON.stringify(geometry)}`,
        );
        return geometry;
      };
      for (const [index, entry] of cases.entries()) {
        const expected = await page.evaluate((kind) => {
          window.liveAggregationPhase = `native-${kind}-live`;
          return window.liveAggregationFixture.startNativeShell(kind);
        }, entry.kind);
        const aggregate = page.locator('.conversation:visible .tool-activity-aggregate').first();
        await aggregate.waitFor();
        if (
          (await aggregate
            .locator(':scope > .tool-activity-summary')
            .getAttribute('aria-expanded')) === 'false'
        )
          await aggregate.locator(':scope > .tool-activity-summary').click();
        const item = aggregate.locator('.tool-activity-steps > .shell-activity').nth(index);
        await item.waitFor();
        await item.locator(':scope > .tool-activity-summary').click();
        await stage(`native-${entry.kind}-live-open`);
        const liveNode = await item.elementHandle();
        assert.ok(liveNode);
        const livePhases = [];
        let commandReadingOffset: number | undefined;
        let liveCommandGeometry: unknown;
        if (entry.kind === 'execute-live') {
          const viewportBefore = await item.locator('.shell-output-viewport').elementHandle();
          assert.ok(viewportBefore);
          for (const phase of ['queued', 'auto', 'human', 'running'] as const) {
            if (phase !== 'queued')
              await page.evaluate(
                (phase) => window.liveAggregationFixture.phaseNativeShell('execute-live', phase),
                phase,
              );
            await page.waitForFunction(
              (command) => document.querySelector('.shell-command-text')?.textContent === command,
              expected.command,
            );
            await stage(`native-execute-live-${phase}`);
            const state = await item.evaluate(
              (node, { before, viewportBefore }) => ({
                sameNode: node === before,
                sameViewport: node.querySelector('.shell-output-viewport') === viewportBefore,
                expanded: node
                  .querySelector('.tool-activity-summary')
                  ?.getAttribute('aria-expanded'),
                title: node.querySelector('.tool-activity-title')?.textContent,
                approval:
                  node.querySelector('.tool-approval')?.getAttribute('aria-label') ??
                  node.querySelector('.tool-approval')?.textContent ??
                  '',
                approvalText: node.querySelector('.tool-approval')?.textContent ?? '',
                command: node.querySelector('.shell-command-text')?.textContent,
                headerHeight: node.querySelector('.shell-output-header')?.getBoundingClientRect()
                  .height,
                successChecks: node.querySelectorAll('.shell-result-icon').length,
              }),
              { before: liveNode, viewportBefore },
            );
            assert.ok(
              state.sameNode && state.sameViewport && state.expanded === 'true',
              `live Shell ${phase} replaced or collapsed its card`,
            );
            assert.equal(
              state.command,
              expected.command,
              `live Shell ${phase} lost original Unicode/multiline command`,
            );
            assert.ok(
              state.headerHeight! > 100,
              `live Shell ${phase} did not render original command on multiple lines`,
            );
            assert.equal(state.successChecks, 0, `live Shell ${phase} falsely reported success`);
            if (phase === 'auto') assert.equal(state.approval, '正在自动审批');
            if (phase === 'human') assert.match(state.approval, /等待人工/);
            if (phase === 'running') assert.equal(state.approval, '已人工批准');
            if (phase === 'running') {
              assert.equal(state.approvalText, '', 'approved Shell retained permanent status text');
              const marker = item.locator('.tool-approval-approved');
              const summary = item.locator(':scope > .tool-activity-summary');
              const geometry = async () => ({
                summary: await summary.boundingBox(),
                header: await item.locator('.shell-output-header').boundingBox(),
                marker: await marker.boundingBox(),
              });
              const beforeTooltip = await geometry();
              const icon = await marker.locator('svg').boundingBox();
              assert.equal(icon?.width, 14);
              assert.equal(icon?.height, 14);
              const chevron = await summary.locator('.tool-activity-chevron').boundingBox();
              assert.ok(
                beforeTooltip.marker &&
                  chevron &&
                  beforeTooltip.marker.x + beforeTooltip.marker.width <= chevron.x,
                'approved marker is not between command and chevron',
              );
              const tooltip = page.locator('.tool-approval-tooltip:not([data-state="closed"])');
              await marker.hover();
              await tooltip.waitFor({ state: 'visible' });
              assert.match((await tooltip.textContent()) ?? '', /已人工批准/);
              await stage('native-execute-live-approved-hover');
              assert.deepEqual(
                await geometry(),
                beforeTooltip,
                'approval hover tooltip displaced tool geometry',
              );
              await page.mouse.move(5, 5, { steps: 8 });
              await stage('native-execute-live-approved-pointer-exit');
              await Bun.write(
                path.join(artifact, `${label}-approval-pointer-exit.json`),
                JSON.stringify(
                  await summary.evaluate((node) => ({
                    activeClass: document.activeElement?.className,
                    focusVisible: node.matches(':focus-visible'),
                    hovered: node.matches(':hover'),
                    tooltipOpen: !!document.querySelector(
                      '.tool-approval-tooltip:not([data-state="closed"])',
                    ),
                  })),
                  null,
                  2,
                ),
              );
              await tooltip.waitFor({ state: 'hidden' });
              await summary.focus();
              await page.keyboard.press('Shift+Tab');
              await page.keyboard.press('Tab');
              await tooltip.waitFor({ state: 'visible' });
              assert.ok(
                await summary.evaluate((node) => document.activeElement === node),
                'keyboard did not reach approved tool summary',
              );
              await stage('native-execute-live-approved-keyboard');
              assert.deepEqual(
                await geometry(),
                beforeTooltip,
                'approval focus tooltip displaced tool geometry',
              );
              await page.keyboard.press('Escape');
              await tooltip.waitFor({ state: 'hidden' });
              assert.ok(
                await summary.evaluate((node) => document.activeElement === node),
                'Escape moved focus away from tool summary',
              );
              assert.equal(
                await summary.getAttribute('aria-expanded'),
                'true',
                'approval tooltip changed tool disclosure',
              );
              await stage('native-execute-live-approved-tooltip-closed');
              await page.keyboard.press('Tab');
            }
            const { command: _command, ...readingState } = state;
            livePhases.push({ phase, ...readingState, commandLength: state.command?.length });
          }
          liveCommandGeometry = await commandTail(
            item,
            aggregate,
            'native-execute-live-command-tail',
          );
          const outer = aggregate.locator('.tool-activity-viewport').first();
          await outer.focus();
          await page.keyboard.press('Home');
          await stage('native-execute-live-command-start');
          await page.keyboard.press('PageDown');
          await stage('native-execute-live-command-reading');
          commandReadingOffset = await outer.evaluate((node) => node.scrollTop);
        }
        await page.evaluate((kind) => {
          window.liveAggregationPhase = `native-${kind}-receipt`;
          window.liveAggregationFixture.holdNativeShellMetadata();
          window.liveAggregationFixture.settleNativeShell(kind);
        }, entry.kind);
        await page.waitForFunction(
          () => window.liveAggregationFixture.nativeShellMetadataPending() > 0,
        );
        await stage(`native-${entry.kind}-metadata-pending`);
        const pendingRow = aggregate.locator('.tool-activity-steps > .tool-activity').nth(index);
        const pendingNode = await pendingRow.elementHandle();
        assert.ok(pendingNode);
        const pending = await page.evaluate(
          ({ before, current }) => ({
            sameNode: before === current,
            beforeConnected: before.isConnected,
            className: current.className,
            title: current.querySelector('.tool-activity-title')?.textContent,
            expanded: current
              .querySelector('.tool-activity-summary')
              ?.getAttribute('aria-expanded'),
            card: !!current.querySelector('.shell-output'),
            consoleText: current.querySelector('.shell-console-output')?.textContent ?? '',
            cardText: current.querySelector('.shell-output')?.textContent ?? '',
            command: current.querySelector('.shell-command-text')?.textContent ?? null,
            outerScrollTop: current.closest('.tool-activity-viewport')?.scrollTop,
          }),
          { before: liveNode, current: pendingNode },
        );
        await page.evaluate((kind) => {
          window.liveAggregationPhase = `native-${kind}-metadata-released`;
          window.liveAggregationFixture.releaseNativeShellMetadata();
        }, entry.kind);
        if (entry.kind === 'execute-model-late') {
          await page.waitForFunction(() =>
            document.querySelector('.shell-result')?.textContent?.includes('成功'),
          );
          await page.waitForFunction(
            (command) => document.querySelector('.shell-command-text')?.textContent === command,
            expected.command,
          );
          await stage('native-execute-model-late-authoritative-first-read');
          const lateOutput = item.locator('.shell-output-viewport');
          const originalViewport = await lateOutput.elementHandle();
          assert.ok(originalViewport);
          await aggregate.locator('.tool-activity-viewport').first().focus();
          await page.keyboard.press('End');
          await page.waitForFunction(() => {
            const node = document.querySelector('.tool-activity-viewport');
            return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
          });
          await lateOutput.focus();
          await page.keyboard.press('Home');
          await page.waitForFunction(
            () =>
              (document.querySelector<HTMLElement>('.shell-output-viewport')?.scrollTop ?? 1) <= 1,
          );
          await stage('native-execute-model-late-manual-reading');
          const readLateModel = () =>
            item.evaluate(
              (node, { before, originalViewport }) => ({
                sameNode: node === before,
                beforeConnected: before.isConnected,
                sameViewport: node.querySelector('.shell-output-viewport') === originalViewport,
                scrollTop: node.querySelector('.shell-output-viewport')?.scrollTop ?? 0,
                scrollHeight: node.querySelector('.shell-output-viewport')?.scrollHeight ?? 0,
                viewportHeight: node.querySelector('.shell-output-viewport')?.clientHeight ?? 0,
                title: node.querySelector('.tool-activity-title')?.textContent,
                command: node.querySelector('.shell-command-text')?.textContent ?? null,
                footer: node.querySelector('.shell-result')?.textContent,
                rawVisible:
                  node.querySelector('.shell-output')?.textContent?.includes('"execution"') ??
                  false,
                expanded: node
                  .querySelector('.tool-activity-summary')
                  ?.getAttribute('aria-expanded'),
              }),
              { before: liveNode, originalViewport },
            );
          const beforeModel = await readLateModel();
          const readsBeforeModel = (
            await page.evaluate(() => window.liveAggregationFixture.nativeShellMetadataPages())
          ).length;
          assert.equal(
            beforeModel.command,
            expected.command,
            'exact Tool input waited for Model completion',
          );
          assert.equal(beforeModel.rawVisible, false, 'exact Tool input retained original JSON');
          const completedModel = await page.evaluate(() =>
            window.liveAggregationFixture.completeNativeShellModel('execute-model-late'),
          );
          await stage('native-execute-model-late-model-complete');
          await stage('native-execute-model-late-after-complete');
          const afterModel = await readLateModel();
          const readsAfterModel = (
            await page.evaluate(() => window.liveAggregationFixture.nativeShellMetadataPages())
          ).length;
          await Bun.write(
            path.join(artifact, `${label}-native-late-model.json`),
            JSON.stringify(
              {
                beforeModel,
                afterModel,
                completedModel,
                readsBeforeModel,
                readsAfterModel,
                metadataPages: await page.evaluate(() =>
                  window.liveAggregationFixture.nativeShellMetadataPages(),
                ),
                samples: await page.evaluate(() => window.liveAggregationSamples),
              },
              null,
              2,
            ),
          );
          assert.equal(
            afterModel.command,
            expected.command,
            'Native Shell lost its authoritative command after Model history completed',
          );
          assert.equal(
            readsAfterModel,
            readsBeforeModel,
            'completed matching Model history redownloaded authoritative Tool input',
          );
          assert.ok(
            afterModel.sameNode && afterModel.beforeConnected && afterModel.expanded === 'true',
            'Native Shell Model completion replaced or collapsed the opened tool',
          );
          assert.equal(
            afterModel.rawVisible,
            false,
            'Native Shell retained raw JSON after verification',
          );
          assert.ok(
            afterModel.sameViewport && afterModel.scrollHeight > afterModel.viewportHeight,
            'Native Shell Model completion replaced or lost the scroll viewport',
          );
          assert.equal(
            afterModel.scrollTop,
            beforeModel.scrollTop,
            'Native Shell Model completion displaced manual output reading',
          );
          assert.equal(
            await item.getByRole('button', { name: '回到最新输出', exact: true }).count(),
            0,
          );
          await lateOutput.focus();
          await page.keyboard.press('End');
          await aggregate.locator('.tool-activity-viewport').first().focus();
          await page.keyboard.press('End');
          await stage('native-execute-model-late-latest-output');
        }
        await page.waitForFunction(
          ({ index, title }) =>
            document
              .querySelectorAll('.tool-activity-steps > .shell-activity')
              [index]?.querySelector('.tool-activity-title')?.textContent === title,
          { index, title: entry.title },
        );
        const expanded = await item
          .locator(':scope > .tool-activity-summary')
          .getAttribute('aria-expanded');
        await stage(`native-${entry.kind}-receipt`);
        const settledNode = await item.elementHandle();
        assert.ok(settledNode);
        const handoff = await page.evaluate(
          ({ before, current }) => ({
            sameNode: before === current,
            beforeConnected: before.isConnected,
            className: current.className,
            title: current.querySelector('.tool-activity-title')?.textContent,
            expanded: current
              .querySelector('.tool-activity-summary')
              ?.getAttribute('aria-expanded'),
            card: !!current.querySelector('.shell-output'),
            outerScrollTop: current.closest('.tool-activity-viewport')?.scrollTop,
          }),
          { before: liveNode, current: settledNode },
        );
        await Bun.write(
          path.join(artifact, `${label}-native-${entry.kind}-handoff.json`),
          JSON.stringify(
            { pending, handoff, samples: await page.evaluate(() => window.liveAggregationSamples) },
            null,
            2,
          ),
        );
        assert.ok(
          pending.sameNode && pending.expanded === 'true' && pending.card,
          `Native ${entry.kind} replaced live Shell with original tool reader while metadata was pending: ${JSON.stringify(pending)}`,
        );
        assert.ok(
          !/"(?:ref|execution|accepted)"\s*:/.test(pending.cardText),
          `Native ${entry.kind} leaked receipt JSON while metadata was pending`,
        );
        if (entry.kind === 'execute-live')
          assert.equal(
            pending.command,
            expected.command,
            'live Shell lost command while receipt metadata was pending',
          );
        if (entry.kind === 'execute-live') {
          assert.equal(
            pending.outerScrollTop,
            commandReadingOffset,
            'receipt pending displaced command reading',
          );
          assert.equal(
            handoff.outerScrollTop,
            commandReadingOffset,
            'receipt completion displaced command reading',
          );
        }
        assert.equal(
          expanded,
          'true',
          `Native ${entry.kind} lost live Shell disclosure at receipt handoff`,
        );
        const command = item.locator('.shell-command-text');
        if (expected.command) {
          await page.waitForFunction(
            ({ index, text }) =>
              document
                .querySelectorAll('.tool-activity-steps > .shell-activity')
                [index]?.querySelector('.shell-command-text')?.textContent === text,
            { index, text: expected.command },
          );
          assert.equal(
            await command.textContent(),
            expected.command,
            `Native ${entry.kind} command paging lost bytes`,
          );
        } else
          assert.equal(
            await command.count(),
            0,
            `Native ${entry.kind} invented a command from shellId`,
          );
        const result = item.locator('.shell-result');
        const footer = (await result.count()) ? ((await result.textContent()) ?? '') : '';
        if (entry.footer) assert.match(footer, entry.footer, `Native ${entry.kind} result differs`);
        else
          assert.equal(
            footer,
            '',
            `Native ${entry.kind} invented execution result after approval failure`,
          );
        assert.equal(
          await item.locator('.shell-result-icon').count(),
          entry.success ? 1 : 0,
          `Native ${entry.kind} promoted Tool acceptance to Job success`,
        );
        const output = (await item.locator('.shell-console-output').textContent()) ?? '';
        if (entry.kind === 'read')
          assert.equal(
            output,
            'Native read 原输出\n第二行 👩‍💻\nNative stderr\n',
            'Native read output order/content differs',
          );
        if (entry.kind === 'execute-failed')
          assert.ok(
            output.includes('NATIVE_REAL_FAILURE_REASON'),
            'Native actual failure reason hidden',
          );
        if (entry.kind === 'execute-unknown')
          assert.ok(
            output.includes('NATIVE_OUTCOME_UNKNOWN_REASON'),
            'Native unknown reason hidden',
          );
        if (entry.kind === 'execute-rejected')
          assert.equal(
            output.split('NATIVE_APPROVAL_REJECTION_REASON').length - 1,
            1,
            'Native rejection reason must appear exactly once',
          );
        await stage(`native-${entry.kind}-verified`);
        verified.push({
          livePhases,
          liveCommandGeometry,
          kind: entry.kind,
          pending,
          handoff,
          expanded,
          title: entry.title,
          footer,
          output,
          commandLength: expected.command?.length ?? 0,
          commandBytes: new TextEncoder().encode(expected.command ?? '').length,
          commandSource:
            entry.kind === 'execute-large'
              ? 'exact Tool input with omitted Model calls; ordinary parentExecutionId null'
              : expected.command
                ? 'complete original Model tool call'
                : 'no command proof',
        });
        await item.locator(':scope > .tool-activity-summary').click();
        await page.waitForTimeout(280);
        if (entry.kind === 'execute-live') {
          priorNativeSamples.push(...(await page.evaluate(() => window.liveAggregationSamples)));
          priorNativeRequests.push(
            ...(await page.evaluate(() =>
              window.liveAggregationFixture.requests.filter(
                (request) => request.method === 'toolMessages.list',
              ),
            )),
          );
          await page.goto(`${server.url}?cold-shell=execute-live`);
          await page.getByRole('button', { name: 'Session A', exact: true }).click();
          const coldProcess = page.locator('.agent-turn-summary').first();
          await coldProcess.waitFor();
          if ((await coldProcess.getAttribute('aria-expanded')) === 'false')
            await coldProcess.click();
          const coldAggregate = page
            .locator('.conversation:visible .tool-activity-aggregate')
            .first();
          await coldAggregate.waitFor();
          if (
            (await coldAggregate
              .locator(':scope > .tool-activity-summary')
              .getAttribute('aria-expanded')) === 'false'
          )
            await coldAggregate.locator(':scope > .tool-activity-summary').click();
          const coldItem = coldAggregate.locator('.shell-activity').first();
          await coldItem.waitFor();
          if (
            (await coldItem
              .locator(':scope > .tool-activity-summary')
              .getAttribute('aria-expanded')) === 'false'
          )
            await coldItem.locator(':scope > .tool-activity-summary').click();
          await page.waitForFunction(
            (command) => document.querySelector('.shell-command-text')?.textContent === command,
            expected.command,
          );
          await stage('native-execute-live-cold-command-start');
          const coldCommandGeometry = await commandTail(
            coldItem,
            coldAggregate,
            'native-execute-live-cold-command-tail',
          );
          await stage('native-execute-live-cold-reopened');
          const coldState = await coldItem.evaluate((node) => ({
            title: node.querySelector('.tool-activity-title')?.textContent,
            command: node.querySelector('.shell-command-text')?.textContent,
            output: node.querySelector('.shell-console-output')?.textContent,
            footer: node.querySelector('.shell-result')?.textContent,
            successChecks: node.querySelectorAll('.shell-result-icon').length,
            expanded: node.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded'),
          }));
          const coldRequests = await page.evaluate(() =>
            window.liveAggregationFixture.requests.filter(
              (request) => request.method === 'toolMessages.list',
            ),
          );
          assert.equal(
            coldState.command,
            expected.command,
            'cold completed session failed to restore command',
          );
          assert.equal(coldState.title, '已运行');
          assert.match(coldState.footer ?? '', /^成功$/);
          assert.equal(coldState.successChecks, 1);
          assert.ok(
            coldRequests.every((request) => !request.executionIds?.length),
            'cold completed session relied on a live View Tool',
          );
          coldVerification = {
            commandGeometry: coldCommandGeometry,
            state: coldState,
            requests: coldRequests,
            metadataPages: await page.evaluate(() =>
              window.liveAggregationFixture.nativeShellMetadataPages(),
            ),
          };
        }
      }
      const requests = [
        ...priorNativeRequests,
        ...(await page.evaluate(() =>
          window.liveAggregationFixture.requests.filter(
            (request) => request.method === 'toolMessages.list',
          ),
        )),
      ];
      if (cases.some((entry) => entry.kind === 'execute-live'))
        assert.ok(
          requests.some(
            (request) =>
              (request.commandOffsets?.['native-execution:native-shell-execute-live'] ?? 0) > 0,
          ),
          'live original command did not cross real Main reader paging boundary',
        );
      if (cases.some((entry) => entry.kind === 'execute'))
        assert.ok(
          requests.some(
            (request) =>
              request.method === 'toolMessages.list' &&
              (request.commandOffsets?.['receipt-native-shell-execute'] ?? 0) > 0,
          ),
          'Native command did not cross actual Main paging boundary',
        );
      if (cases.some((entry) => entry.kind === 'execute-large'))
        assert.ok(
          requests.some(
            (request) =>
              request.method === 'toolMessages.list' &&
              (request.commandOffsets?.['receipt-native-shell-execute-large'] ?? 0) > 0,
          ),
          'large Native command did not page from exact Tool input',
        );
      const samples = [
        ...priorNativeSamples,
        ...(await page.evaluate(() => window.liveAggregationSamples)),
      ];
      await cdp.send('Page.stopScreencast');
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: { verified, requests, coldVerification },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      assert.deepEqual(errors, [], 'Native Shell page errors');
      assert.ok(
        samples.every(
          (sample) => !sample.overflow && !sample.conversationOverflow && !sample.nestedButtons,
        ),
        'Native Shell overflow or nested button',
      );
      for (const checkedKind of ['execute-live', 'execute-model-late'] as const) {
        if (!cases.some((entry) => entry.kind === checkedKind)) continue;
        const expectedLength: number = verified.find(
          (entry) => entry.kind === checkedKind,
        )!.commandLength;
        for (const sample of samples) {
          if (
            checkedKind === 'execute-model-late' &&
            ![
              'native-execute-model-late-authoritative-first-read',
              'native-execute-model-late-manual-reading',
              'native-execute-model-late-model-complete',
              'native-execute-model-late-after-complete',
              'native-execute-model-late-latest-output',
            ].includes(sample.phase)
          )
            continue;
          if (
            !sample.phase.startsWith(`native-${checkedKind}-`) ||
            ['native-execute-live-live', 'native-execute-live-live-open'].includes(sample.phase)
          )
            continue;
          for (const shell of sample.shells.filter((shell) => shell.expanded)) {
            assert.equal(
              shell.commandLength,
              expectedLength,
              `live command briefly disappeared during ${sample.phase}/${sample.cause}`,
            );
            assert.ok(
              shell.headerBox && shell.headerBox[2]! > 40 && shell.headerBox[3]! > 0,
              `live command Header briefly vanished during ${sample.phase}/${sample.cause}`,
            );
          }
        }
      }
      console.log(
        JSON.stringify({
          nativeShell,
          theme,
          width,
          samples: samples.length,
          screenshotFrames,
          verified: verified.map(({ kind, title, footer, commandLength }) => ({
            kind,
            title,
            footer,
            commandLength,
          })),
          errors,
        }),
      );
      await page.close();
      continue;
    }
    if (toolDetails) {
      const inspectFade = (scroll: ReturnType<typeof page.locator>) =>
        scroll.evaluate((node) => {
          const style = getComputedStyle(node);
          const length = (value: string) => {
            const probe = document.createElement('span');
            probe.style.cssText =
              'position:absolute;visibility:hidden;pointer-events:none;width:1px;top:0';
            probe.style.height = value;
            node.append(probe);
            const pixels = probe.getBoundingClientRect().height;
            probe.remove();
            return pixels;
          };
          return {
            top: length(style.getPropertyValue('--scroll-fade-t')),
            bottom: length(style.getPropertyValue('--scroll-fade-b')),
            mask: style.maskImage,
            slot: node.getAttribute('data-slot'),
          };
        });
      const shell = page.locator('.conversation .shell-activity').first();
      await shell.locator(':scope > .tool-activity-summary').click();
      const output = shell.getByRole('region', { name: 'Shell 执行输出', exact: true });
      await output.waitFor();
      await stage('island-shell-open');
      assert.equal(
        await output.locator('.shell-command-text').count(),
        0,
        'Shell command remained inside the scrolling output',
      );
      const commandHeader = shell.locator('.shell-output-header');
      const headerBorder = await commandHeader.evaluate(
        (node) => getComputedStyle(node).borderBottomWidth,
      );
      assert.equal(headerBorder, '0px', 'Shell Header retained an internal bottom border');
      const headerBeforeScroll = await commandHeader.boundingBox();
      assert.ok(
        headerBeforeScroll && headerBeforeScroll.height > 60,
        'Shell original multiline command was collapsed into a summary',
      );
      const readStandaloneGeometry = () =>
        shell.evaluate((node) => {
          const measure = (element: Element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              tag: element.tagName,
              className: element.className,
              box: [box.x, box.y, box.width, box.height],
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              minWidth: style.minWidth,
              width: style.width,
              overflowX: style.overflowX,
              display: style.display,
              inlineStyle: element.getAttribute('style'),
            };
          };
          const ancestors = [];
          for (let current: Element | null = node; current; current = current.parentElement)
            ancestors.push(measure(current));
          return {
            ancestors,
            row: measure(node.querySelector(':scope > .tool-activity-summary')!),
            card: measure(node.querySelector('.shell-output')!),
            chevron: measure(node.querySelector('.tool-activity-chevron')!),
            clip: measure(node.closest('.conversation-viewport')!),
            viewportWidth: innerWidth,
          };
        });
      const standaloneGeometry = await readStandaloneGeometry();
      await Bun.write(
        path.join(artifact, `${theme}-${width}-standalone-shell-geometry.json`),
        JSON.stringify(standaloneGeometry, null, 2),
      );
      for (const [name, geometry] of Object.entries({
        row: standaloneGeometry.row,
        card: standaloneGeometry.card,
        chevron: standaloneGeometry.chevron,
      })) {
        const [x, , width] = geometry.box;
        const [clipX, , clipWidth] = standaloneGeometry.clip.box;
        assert.ok(
          x! >= clipX! - 1 && x! + width! <= clipX! + clipWidth! + 1,
          `standalone Shell ${name} clipped by conversation viewport: ${JSON.stringify(standaloneGeometry)}`,
        );
      }
      const readScroll = () =>
        output.evaluate((node) => ({
          top: node.scrollTop,
          height: node.clientHeight,
          total: node.scrollHeight,
          left: node.scrollLeft,
          width: node.clientWidth,
          wide: node.scrollWidth,
          slot: node.getAttribute('data-slot'),
        }));
      const initial = await readScroll();
      const initialFade = await inspectFade(output);
      assert.equal(initial.slot, 'scroll-area-viewport', 'Shell retained the pre as scroll owner');
      assert.ok(
        initial.height <= 256.5 && initial.total > initial.height,
        'Shell viewport cap or scroll range differs',
      );
      assert.ok(
        initial.total - initial.height - initial.top <= 1,
        'Shell did not initially follow latest output',
      );
      assert.ok(
        initialFade.mask !== 'none' && initialFade.top > 0 && initialFade.bottom === 0,
        'Shell initial fade did not match latest position',
      );
      await stage('island-shell-append', () => window.toolScrollIsland.appendShell());
      const appended = await readScroll();
      assert.ok(
        appended.total > initial.total && appended.total - appended.height - appended.top <= 1,
        'Shell appended output did not follow actual viewport',
      );
      await output.focus();
      await page.keyboard.press('PageUp');
      await stage('island-shell-middle');
      const middleFade = await inspectFade(output);
      assert.ok(middleFade.top > 0 && middleFade.bottom > 0, 'Shell middle fade differs');
      await output.focus();
      await page.keyboard.press('Home');
      assert.equal(
        await shell.getByRole('button', { name: '回到最新输出', exact: true }).count(),
        0,
      );
      await page.waitForFunction(
        () => (document.querySelector<HTMLElement>('.shell-output-viewport')?.scrollTop ?? 1) <= 1,
      );
      const paused = await readScroll();
      const pausedFade = await inspectFade(output);
      assert.deepEqual(
        await commandHeader.boundingBox(),
        headerBeforeScroll,
        'Shell output scrolling displaced the fixed command header',
      );
      assert.ok(pausedFade.top === 0 && pausedFade.bottom > 0, 'Shell manual top fade differs');
      await stage('island-shell-paused-append', () => window.toolScrollIsland.appendShell());
      assert.equal(
        (await readScroll()).top,
        paused.top,
        'Shell append displaced manual reading position',
      );
      await output.focus();
      await page.keyboard.press('End');
      await stage('island-shell-latest');
      await stage('island-shell-resumed-append', () => window.toolScrollIsland.appendShell());
      const latest = await readScroll();
      const latestFade = await inspectFade(output);
      assert.deepEqual(
        await commandHeader.boundingBox(),
        headerBeforeScroll,
        'Shell return to latest displaced the fixed command header',
      );
      assert.ok(
        latest.total - latest.height - latest.top <= 1,
        'Shell latest action did not scroll viewport',
      );
      assert.ok(latestFade.top > 0 && latestFade.bottom === 0, 'Shell latest fade state differs');
      assert.equal(
        await output.locator('pre').getAttribute('tabindex'),
        '-1',
        'inner Shell pre remained a separate keyboard scroll stop',
      );
      const expectedShell = await page.evaluate(() => window.toolScrollIsland.shellText());
      assert.equal(
        await output.locator('.shell-console-output').textContent(),
        expectedShell,
        'Shell output lost bytes',
      );
      const expectedCommand = await page.evaluate(() => window.toolScrollIsland.commandText());
      assert.equal(
        await shell.locator('.shell-command-text').textContent(),
        expectedCommand,
        'multiline Shell command changed',
      );
      assert.equal(
        await commandHeader.locator('.shell-command-text').textContent(),
        expectedCommand,
        'fixed Shell header lost the original command',
      );
      const copyCommand = commandHeader.getByRole('button', { name: '复制代码', exact: true });
      assert.equal(await copyCommand.count(), 1, 'full Shell command has no copy action');
      await copyCommand.isEnabled().then((enabled) => assert.ok(enabled));
      await stage('island-standalone-success', () =>
        window.toolScrollIsland.shellScenario('execute-success'),
      );
      await page.evaluate(() => window.toolScrollIsland.shellScenario('execute-running'));
      const diffItem = page
        .locator('.conversation .tool-activity')
        .filter({ has: page.getByText('fixture-diff.ts', { exact: true }) })
        .first();
      await diffItem
        .getByRole('button', { name: '展开 fixture-diff.ts 的差异', exact: true })
        .click();
      const diff = diffItem.getByRole('region', { name: '文件差异', exact: true });
      await diff.waitFor();
      const expectedDiff = await page.evaluate(() => window.toolScrollIsland.diffText());
      assert.equal(
        await diff.locator('pre').textContent(),
        `${expectedDiff}\n`,
        'diff full content changed',
      );
      const diffInitial = await diff.evaluate((node) => ({
        width: node.clientWidth,
        wide: node.scrollWidth,
        height: node.clientHeight,
        total: node.scrollHeight,
        slot: node.getAttribute('data-slot'),
      }));
      assert.equal(diffInitial.slot, 'scroll-area-viewport');
      assert.ok(
        diffInitial.wide > diffInitial.width && diffInitial.total > diffInitial.height,
        'diff did not expose both scroll axes',
      );
      await diff.hover({ position: { x: 30, y: 20 } });
      await page.mouse.wheel(180, 110);
      await page.waitForTimeout(150);
      const diffWheel = await diff.evaluate((node) => ({
        left: node.scrollLeft,
        top: node.scrollTop,
      }));
      assert.ok(diffWheel.left > 0 && diffWheel.top > 0, 'diff wheel did not move both axes');
      await diffItem.locator('.tool-diff-scroll').hover();
      const horizontalThumb = diffItem.locator(
        '.tool-diff-scroll > [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] [data-slot="scroll-area-thumb"]',
      );
      await horizontalThumb.waitFor({ state: 'visible' });
      const thumb = await horizontalThumb.boundingBox();
      assert.ok(thumb);
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
      await page.mouse.down();
      await page.mouse.move(thumb.x + thumb.width / 2 + 60, thumb.y + thumb.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      const diffDragged = await diff.evaluate((node) => node.scrollLeft);
      assert.ok(diffDragged > diffWheel.left, 'diff horizontal thumb did not scroll viewport');
      await diff.focus();
      await page.keyboard.press('End');
      await stage('island-diff-end');
      const diffEnd = await diff.evaluate((node) => ({
        top: node.scrollTop,
        height: node.clientHeight,
        total: node.scrollHeight,
      }));
      assert.ok(
        diffEnd.total - diffEnd.height - diffEnd.top <= 1,
        'diff keyboard End did not reach full tail',
      );
      const diffEndFade = await inspectFade(diff);
      assert.ok(diffEndFade.top > 0 && diffEndFade.bottom === 0, 'diff end fade differs');
      await stage('island-grouped', () => window.toolScrollIsland.groupTools());
      const aggregate = page.locator('.conversation .tool-activity-aggregate').first();
      await aggregate.locator(':scope > .tool-activity-summary').click();
      const nestedShell = aggregate.locator('.shell-activity').first();
      await nestedShell.locator(':scope > .tool-activity-summary').click();
      const nestedOutput = nestedShell.getByRole('region', { name: 'Shell 执行输出', exact: true });
      await stage('island-group-shell-open');
      const groupViewport = aggregate.locator('.tool-activity-viewport').first();
      await groupViewport.focus();
      await page.keyboard.press('Home');
      await stage('island-group-fade-top');
      const groupTopFade = await inspectFade(groupViewport);
      assert.ok(groupTopFade.top === 0 && groupTopFade.bottom > 0, 'aggregate top fade differs');
      await groupViewport.evaluate((node) => {
        node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
      });
      await stage('island-group-fade-middle');
      const groupMiddleFade = await inspectFade(groupViewport);
      assert.ok(
        groupMiddleFade.top > 0 && groupMiddleFade.bottom > 0,
        'aggregate middle fade differs',
      );
      await aggregate.locator('.tool-activity-viewport').first().focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => {
        const node = document.querySelector('.tool-activity-viewport');
        return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
      });
      await stage('island-group-fade-end');
      const groupEndFade = await inspectFade(groupViewport);
      assert.ok(groupEndFade.top > 0 && groupEndFade.bottom === 0, 'aggregate end fade differs');
      await nestedOutput.focus();
      await page.keyboard.press('End');
      await stage('island-group-shell-inner-end');
      await aggregate.locator('.tool-activity-viewport').first().focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => {
        const node = document.querySelector('.tool-activity-viewport');
        return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
      });
      await stage('island-group-shell-tail');
      const nestedGeometry = await nestedOutput.evaluate((node) => {
        const inner = node.getBoundingClientRect(),
          outer = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
        const pre = node.querySelector('pre')!;
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode()!,
          next = walker.nextNode();
        while (next) {
          if (next.textContent?.trim()) text = next;
          next = walker.nextNode();
        }
        const length = text.textContent?.length ?? 0;
        const range = document.createRange();
        range.setStart(text, Math.max(0, length - 20));
        range.setEnd(text, length);
        const tail = range.getBoundingClientRect();
        return {
          height: inner.height,
          outerHeight: outer.height,
          tailTop: tail.top,
          tailBottom: tail.bottom,
          visibleTop: Math.max(inner.top, outer.top),
          visibleBottom: Math.min(inner.bottom, outer.bottom),
          aggregateHeight: node.closest('.tool-activity-aggregate')!.getBoundingClientRect().height,
        };
      });
      assert.ok(nestedGeometry.aggregateHeight <= 400.5, 'nested Shell exceeded aggregate cap');
      assert.ok(
        nestedGeometry.tailTop >= nestedGeometry.visibleTop - 1 &&
          nestedGeometry.tailBottom <= nestedGeometry.visibleBottom + 1,
        `nested Shell tail clipped ${JSON.stringify(nestedGeometry)}`,
      );
      await nestedShell.locator(':scope > .tool-activity-summary').click();
      const nestedDiffItem = aggregate
        .locator('.tool-activity')
        .filter({ has: page.getByText('fixture-diff.ts', { exact: true }) })
        .first();
      await nestedDiffItem
        .getByRole('button', { name: '展开 fixture-diff.ts 的差异', exact: true })
        .click();
      const nestedDiff = nestedDiffItem.getByRole('region', { name: '文件差异', exact: true });
      await nestedDiff.focus();
      await page.keyboard.press('End');
      await stage('island-group-diff-tail');
      const nestedDiffGeometry = await nestedDiff.evaluate((node) => {
        const box = node.getBoundingClientRect(),
          outer = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !text.textContent?.includes('DIFF_FULL_END')) text = walker.nextNode();
        if (!text) throw Error('fixture_nested_diff_tail_missing');
        const start = text.textContent!.indexOf('DIFF_FULL_END'),
          range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'DIFF_FULL_END'.length);
        const tail = range.getBoundingClientRect();
        return {
          height: box.height,
          tailTop: tail.top,
          tailBottom: tail.bottom,
          visibleTop: Math.max(box.top, outer.top),
          visibleBottom: Math.min(box.bottom, outer.bottom),
          aggregateHeight: node.closest('.tool-activity-aggregate')!.getBoundingClientRect().height,
        };
      });
      assert.ok(
        nestedDiffGeometry.aggregateHeight <= 400.5 &&
          nestedDiffGeometry.tailTop >= nestedDiffGeometry.visibleTop - 1 &&
          nestedDiffGeometry.tailBottom <= nestedDiffGeometry.visibleBottom + 1,
        `nested diff tail clipped ${JSON.stringify(nestedDiffGeometry)}`,
      );
      const shellMatrix = [];
      await nestedDiffItem
        .getByRole('button', { name: '收起 fixture-diff.ts 的差异', exact: true })
        .click();
      const cases = [
        { scenario: 'execute-running', title: '运行中', footer: /执行中/, success: false },
        { scenario: 'execute-success', title: '已运行', footer: /^成功$/, success: true },
        { scenario: 'execute-failed', title: '运行失败', footer: /失败.*退出码 7/, success: false },
        { scenario: 'execute-unknown', title: '结果未知', footer: /结果未知/, success: false },
        { scenario: 'execute-rejected', title: '运行命令', footer: null, success: false },
        { scenario: 'launch-accepted', title: '已请求运行', footer: /已受理/, success: false },
        { scenario: 'launch-running', title: '已请求运行', footer: /执行中/, success: false },
        { scenario: 'read-running', title: '已读取输出', footer: /执行中/, success: false },
        {
          scenario: 'wait-timeout',
          title: '等待超时',
          footer: /等待超时.*命令仍在运行/,
          success: false,
        },
        {
          scenario: 'stop-requested',
          title: '已请求停止',
          footer: /已请求停止.*等待结束/,
          success: false,
        },
        { scenario: 'legacy-success', title: '已运行', footer: /^成功$/, success: true },
      ] as const;
      const matrixShell = aggregate.locator('.shell-activity').first();
      await matrixShell.locator(':scope > .tool-activity-summary').click();
      for (const entry of cases) {
        await page.evaluate((scenario) => {
          window.liveAggregationPhase = `island-state-${scenario}`;
          window.toolScrollIsland.shellScenario(scenario);
        }, entry.scenario);
        await page.waitForTimeout(80);
        const title = await matrixShell
          .locator(':scope > .tool-activity-summary .tool-activity-title')
          .textContent();
        assert.equal(title, entry.title, `Shell ${entry.scenario} title differs`);
        const result = matrixShell.locator('.shell-result');
        const footer = (await result.count()) ? ((await result.textContent()) ?? '') : '';
        if (entry.footer)
          assert.match(footer, entry.footer, `Shell ${entry.scenario} result differs`);
        else assert.equal(footer, '', `Shell ${entry.scenario} invented an execution result`);
        assert.equal(
          await matrixShell.locator('.shell-result-icon').count(),
          entry.success ? 1 : 0,
          `Shell ${entry.scenario} used an unqualified success check`,
        );
        await aggregate.locator('.tool-activity-viewport').first().focus();
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const node = document.querySelector('.tool-activity-viewport');
          return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        });
        const geometry = await matrixShell.evaluate((node) => {
          const card = node.querySelector('.shell-output')!.getBoundingClientRect();
          const result = node.querySelector('.shell-result');
          const box = result?.getBoundingClientRect();
          const clip = node.closest('.tool-activity-viewport')?.getBoundingClientRect();
          return {
            card: [card.x, card.y, card.width, card.height],
            footer: box ? [box.x, box.y, box.width, box.height] : null,
            fontSize: result ? getComputedStyle(result).fontSize : null,
            clip: clip ? [clip.x, clip.y, clip.width, clip.height] : null,
          };
        });
        if (geometry.footer) {
          const [x, y, w, h] = geometry.footer,
            [cx, cy, cw, ch] = geometry.card;
          assert.ok(
            x! >= cx! + cw! / 2 && y! + h! <= cy! + ch! + 1 && x! + w! <= cx! + cw! + 1,
            `Shell ${entry.scenario} status is not at card bottom right`,
          );
          assert.equal(geometry.fontSize, '13px', 'Shell footer auxiliary text differs');
          if (geometry.clip) {
            const [, clipY, , clipHeight] = geometry.clip;
            assert.ok(
              y! >= clipY! - 1 && y! + h! <= clipY! + clipHeight! + 1,
              `Shell ${entry.scenario} footer clipped by aggregate viewport`,
            );
          }
        }
        assert.equal(
          await matrixShell.locator('.shell-command-text').textContent(),
          expectedCommand,
          `Shell ${entry.scenario} lost command bytes`,
        );
        await stage(`island-state-${entry.scenario}`);
        shellMatrix.push({ scenario: entry.scenario, title, footer, geometry });
      }
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: {
          standaloneGeometry,
          headerBeforeScroll,
          headerBorder,
          initial,
          initialFade,
          appended,
          middleFade,
          paused,
          pausedFade,
          latest,
          latestFade,
          diffInitial,
          diffWheel,
          diffDragged,
          diffEnd,
          diffEndFade,
          nestedGeometry,
          groupTopFade,
          groupMiddleFade,
          groupEndFade,
          nestedDiffGeometry,
          shellMatrix,
        },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      assert.deepEqual(errors, [], 'tool island page errors');
      for (const sample of samples) {
        assert.equal(sample.overflow, false, 'tool island overflowed page');
        assert.equal(sample.conversationOverflow, false, 'tool island overflowed conversation');
        assert.equal(sample.nestedButtons, 0, 'tool island nested buttons');
      }
      console.log(
        JSON.stringify({
          toolDetails,
          theme,
          width,
          samples: samples.length,
          screenshotFrames,
          nestedGeometry,
          errors,
        }),
      );
      await page.close();
      continue;
    }
    if (longGroup) {
      const detail = await page.evaluate(() => {
        window.liveAggregationPhase = 'long-receipts';
        return window.liveAggregationFixture.longGroup();
      });
      await page.waitForFunction(() => window.liveAggregationFixture.pending() > 0);
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.evaluate(() => window.liveAggregationFixture.flush());
        await page.waitForTimeout(35);
      }
      const aggregate = page.locator('.conversation:visible .tool-activity-aggregate').first();
      const summary = aggregate.locator(':scope > .tool-activity-summary');
      await stage('long-collapsed');
      assert.equal(
        (await summary.textContent())?.trim(),
        (await summary.locator('.tool-activity-title').textContent())?.trim(),
        'aggregate title appended summary text',
      );
      assert.ok(
        !(await aggregate.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'collapsed group leaked failure reason',
      );
      assert.ok(
        !(await aggregate.textContent())?.includes('APPROVAL_REJECTION_START'),
        'collapsed group leaked approval reason',
      );
      await summary.click();
      const viewport = aggregate.locator(
        '.tool-activity-viewport[role="region"][aria-label="工具执行明细"]',
      );
      const steps = viewport.locator('.tool-activity-steps');
      await viewport.waitFor();
      await stage('long-expanded');
      assert.equal(await steps.locator(':scope > *').count(), 36, 'long group omitted tools');
      assert.ok(
        !(await steps.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'expanded aggregate leaked unopened failure reason',
      );
      assert.ok(
        !(await steps.textContent())?.includes('APPROVAL_REJECTION_START'),
        'expanded aggregate leaked unopened approval reason',
      );
      const initial = await aggregate.evaluate((node) => {
        const scroll = node.querySelector<HTMLElement>('.tool-activity-viewport')!;
        const list = node.querySelector<HTMLElement>('.tool-activity-steps')!;
        const header = node.querySelector('.tool-activity-summary')!.getBoundingClientRect();
        return {
          height: node.getBoundingClientRect().height,
          clientHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          rowGap: getComputedStyle(list).rowGap,
          tabIndex: scroll.tabIndex,
          header: [header.x, header.y, header.width, header.height],
          viewportTop: node.closest('.conversation-viewport')?.scrollTop,
          footer: [...document.querySelectorAll('.conversation-footer')]
            .find((item) => item.getBoundingClientRect().height > 0)
            ?.getBoundingClientRect()
            .toJSON(),
        };
      });
      assert.ok(
        initial.height <= 400.5 && initial.height >= 399,
        'expanded aggregate did not respect the 400px cap',
      );
      assert.ok(
        initial.scrollHeight > initial.clientHeight,
        'long details did not overflow internally',
      );
      assert.equal(initial.tabIndex, 0, 'details are not keyboard focusable');
      assert.equal(initial.rowGap, '0px', 'aggregate tool rows did not respect the zero gap');
      const fadeState = (scroll: typeof viewport) =>
        scroll.evaluate((node) => {
          const style = getComputedStyle(node);
          const usedLength = (value: string) => {
            const probe = document.createElement('span');
            probe.style.cssText =
              'position:absolute;visibility:hidden;pointer-events:none;width:1px;top:0';
            probe.style.height = value;
            node.append(probe);
            const pixels = probe.getBoundingClientRect().height;
            probe.remove();
            return pixels;
          };
          return {
            scrollTop: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            top: usedLength(style.getPropertyValue('--scroll-fade-t')),
            bottom: usedLength(style.getPropertyValue('--scroll-fade-b')),
            topRaw: style.getPropertyValue('--scroll-fade-t'),
            bottomRaw: style.getPropertyValue('--scroll-fade-b'),
            mask: style.maskImage,
            timeline: style.getPropertyValue('animation-timeline'),
            slot: node.getAttribute('data-slot'),
            nativeScrollTimeline: CSS.supports('animation-timeline', 'scroll()'),
          };
        });
      const pointerScroll = async (
        scroll: typeof viewport,
        root: typeof aggregate,
        phase: string,
      ) => {
        await scroll.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        const top = await fadeState(scroll);
        assert.equal(top.slot, 'scroll-area-viewport', `${phase}: wrong scrolling node`);
        assert.ok(
          top.nativeScrollTimeline && top.mask !== 'none',
          `${phase}: scroll fade did not load`,
        );
        assert.ok(
          top.top === 0 && top.bottom > 0,
          `${phase}: top fade state differs ${JSON.stringify(top)}`,
        );
        await scroll.hover({ position: { x: 40, y: 25 } });
        await page.mouse.wheel(0, 90);
        await page.waitForTimeout(150);
        const wheel = await fadeState(scroll);
        assert.ok(
          wheel.scrollTop > 0 && wheel.top > 0 && wheel.bottom > 0,
          `${phase}: wheel did not scroll/fade actual viewport`,
        );
        await stage(`${phase}-wheel`);
        await scroll.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        await root.hover();
        const thumb = root.locator(
          ':scope > [data-slot="scroll-area-scrollbar"][data-orientation="vertical"] [data-slot="scroll-area-thumb"]',
        );
        await thumb.waitFor({ state: 'visible' });
        const box = await thumb.boundingBox();
        assert.ok(box && box.height > 0, `${phase}: Radix thumb missing`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(100);
        const dragged = await fadeState(scroll);
        assert.ok(
          dragged.scrollTop > 0 && dragged.top > 0,
          `${phase}: thumb did not scroll actual viewport`,
        );
        await stage(`${phase}-thumb`);
        await scroll.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        return { top, wheel, dragged };
      };
      const aggregatePointer = await pointerScroll(
        viewport,
        aggregate.locator('.tool-activity-scroll').first(),
        'long-aggregate',
      );
      await viewport.focus();
      await page.keyboard.press('PageDown');
      await page.waitForFunction(
        () =>
          (document.querySelector<HTMLElement>('.conversation .tool-activity-viewport')
            ?.scrollTop ?? 0) > 0,
      );
      const pageDownTop = await viewport.evaluate((node) => node.scrollTop);
      await page.keyboard.press('End');
      await page.waitForTimeout(180);
      const endTop = await viewport.evaluate((node) => node.scrollTop);
      assert.ok(endTop > pageDownTop, 'End did not reach later tool rows');
      await stage('long-keyboard-end');
      const aggregateEndFade = await fadeState(viewport);
      assert.ok(
        aggregateEndFade.top > 0 && aggregateEndFade.bottom === 0,
        'aggregate end fade state differs',
      );
      const failed = steps
        .locator('.tool-activity')
        .filter({ has: page.getByText('fixture-target-execution-2', { exact: true }) })
        .first();
      const denied = steps
        .locator('.tool-activity')
        .filter({ has: page.getByText('fixture-target-execution-4', { exact: true }) })
        .first();
      const readReasonTail = async (item: typeof failed, marker: string, phase: string) => {
        const detail = item.getByRole('region', { name: '工具异常详情', exact: true });
        assert.ok(
          await detail.evaluate(
            (node) =>
              node.classList.contains('tool-detail-viewport') &&
              node.classList.contains('scroll-fade-y'),
          ),
        );
        const pointer = await pointerScroll(
          detail,
          item.locator('.tool-detail-scroll').first(),
          phase,
        );
        await detail.focus();
        await page.keyboard.press('End');
        await page.waitForTimeout(180);
        const geometry = await detail.evaluate((node, endMarker) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text: Node | null = walker.nextNode();
          while (text && !text.textContent?.includes(endMarker)) text = walker.nextNode();
          if (!text) throw Error('fixture_detail_tail_missing');
          const start = text.textContent!.indexOf(endMarker);
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + endMarker.length);
          const tail = range.getBoundingClientRect(),
            box = node.getBoundingClientRect();
          const outer = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
          return {
            scrollTop: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            tailTop: tail.top,
            tailBottom: tail.bottom,
            visibleTop: Math.max(box.top, outer.top),
            visibleBottom: Math.min(box.bottom, outer.bottom),
            tabIndex: (node as HTMLElement).tabIndex,
          };
        }, marker);
        assert.equal(geometry.tabIndex, 0, 'error detail cannot receive keyboard focus');
        assert.ok(
          geometry.scrollTop > 0 &&
            geometry.scrollTop >= geometry.scrollHeight - geometry.clientHeight - 1,
          'End did not scroll complete error reason',
        );
        assert.ok(
          geometry.tailTop >= geometry.visibleTop - 1 &&
            geometry.tailBottom <= geometry.visibleBottom + 1,
          'long error tail is outside readable scroll area',
        );
        await stage(phase);
        const endFade = await fadeState(detail);
        assert.ok(endFade.top > 0 && endFade.bottom === 0, `${phase}: end fade state differs`);
        return { ...geometry, pointer, endFade };
      };
      await failed.locator(':scope > .tool-activity-summary').click();
      await stage('long-failed-item-open');
      assert.ok(
        (await failed.textContent())?.includes(detail.error),
        'failed item did not reveal its complete original reason',
      );
      assert.ok(
        !(await steps.textContent())?.includes('APPROVAL_REJECTION_START'),
        'opening failed item revealed another item reason',
      );
      const failureTail = await readReasonTail(
        failed,
        'FAILED_WRITE_DETAIL_END',
        'long-failed-tail',
      );
      await summary.click();
      await stage('long-recollapsed');
      assert.ok(
        !(await aggregate.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'closed group retained visible failure reason',
      );
      await summary.click();
      await stage('long-reopened');
      assert.equal(
        await failed.locator(':scope > .tool-activity-summary').getAttribute('aria-expanded'),
        'true',
        'group reopen lost item disclosure choice',
      );
      assert.ok(
        (await failed.textContent())?.includes(detail.error),
        'group reopen lost complete failure reason',
      );
      await failed.locator(':scope > .tool-activity-summary').click();
      await denied.locator(':scope > .tool-activity-summary').click();
      await stage('long-approval-item-open');
      assert.ok(
        (await denied.textContent())?.includes(detail.approval),
        'approval item did not reveal its complete original reason',
      );
      assert.ok(
        !(await steps.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'closing failed item did not hide its reason',
      );
      const approvalTail = await readReasonTail(
        denied,
        'APPROVAL_REJECTION_END',
        'long-approval-tail',
      );
      assert.ok(
        await aggregate.evaluate((node) => node.getBoundingClientRect().height <= 400.5),
        'long error details exceeded aggregate cap',
      );
      await viewport.focus();
      await page.keyboard.press('End');
      await stage('long-approval-keyboard-end');
      await denied.locator(':scope > .tool-activity-summary').click();
      await page.waitForTimeout(280);
      const colors = await aggregate.evaluate((node) => {
        const resolve = (variable: string) => {
          const probe = document.createElement('span');
          probe.style.cssText = `position:absolute;visibility:hidden;color:var(${variable})`;
          node.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return { muted: resolve('--muted-foreground'), destructive: resolve('--destructive') };
      });
      const approvalMatrix = [];
      for (const entry of detail.matrix) {
        const item = steps
          .locator('.tool-activity')
          .filter({ has: page.getByText(`${entry.definitionId} · 1`, { exact: true }) })
          .first();
        const itemSummary = item.locator(':scope > .tool-activity-summary');
        await itemSummary.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        const inspect = () =>
          itemSummary.evaluate((node) =>
            [...node.querySelectorAll('.tool-approval,.tool-step-status,.tool-activity-state')].map(
              (label) => ({
                text: label.getAttribute('aria-label') ?? label.textContent ?? '',
                approval: label.classList.contains('tool-approval'),
                fontSize: getComputedStyle(label).fontSize,
                color: getComputedStyle(label).color,
              }),
            ),
          );
        const normal = await inspect();
        const approvalLabels = normal.filter((label) => label.approval);
        const executionLabels = normal.filter((label) => !label.approval);
        assert.deepEqual(
          approvalLabels.map((label) => label.text),
          [entry.approval],
          `${entry.definitionId}: approval status differs`,
        );
        assert.deepEqual(
          executionLabels.map((label) => label.text),
          entry.status ? [entry.status] : [],
          `${entry.definitionId}: redundant or missing tool status`,
        );
        for (const label of normal) {
          assert.equal(label.fontSize, '13px', `${entry.definitionId}: status font differs`);
          assert.equal(
            label.color,
            !label.approval && entry.issue ? colors.destructive : colors.muted,
            `${entry.definitionId}: status color differs`,
          );
        }
        if (entry.reason)
          assert.ok(
            !(await item.textContent())?.includes(entry.reason),
            `${entry.definitionId}: reason visible before item disclosure`,
          );
        await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}-closed`);
        await itemSummary.hover();
        assert.deepEqual(
          await inspect(),
          normal,
          `${entry.definitionId}: hovering changed status style`,
        );
        await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}-hover`);
        let expanded: typeof normal | undefined;
        if ((await itemSummary.getAttribute('aria-expanded')) !== null) {
          await itemSummary.click();
          expanded = await inspect();
          assert.deepEqual(expanded, normal, `${entry.definitionId}: expanded status brightened`);
          if (entry.reason)
            assert.ok(
              (await item.textContent())?.includes(entry.reason),
              `${entry.definitionId}: original reason missing after disclosure`,
            );
          await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}`);
          await itemSummary.click();
          await page.waitForTimeout(280);
          if (entry.reason)
            assert.ok(
              !(await item.textContent())?.includes(entry.reason),
              `${entry.definitionId}: closing retained visible reason`,
            );
        } else await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}`);
        approvalMatrix.push({
          definitionId: entry.definitionId,
          normal,
          hovered: await inspect(),
          expanded,
        });
      }
      const final = await aggregate.evaluate((node) => {
        const header = node.querySelector('.tool-activity-summary')!.getBoundingClientRect();
        return {
          header: [header.x, header.y, header.width, header.height],
          viewportTop: node.closest('.conversation-viewport')?.scrollTop,
          footer: [...document.querySelectorAll('.conversation-footer')]
            .find((item) => item.getBoundingClientRect().height > 0)
            ?.getBoundingClientRect()
            .toJSON(),
        };
      });
      assert.deepEqual(
        final,
        { header: initial.header, viewportTop: initial.viewportTop, footer: initial.footer },
        'internal scrolling moved aggregate title, outer reading or input',
      );
      // Wheel chaining must work in both directions after the inner reader reaches
      // its limit. A shorter window makes the actual conversation overflow too.
      await page.setViewportSize({ width, height: 620 });
      const conversation = page.locator('.conversation:visible .conversation-viewport');
      const wheelBoundary = async (direction: 'up' | 'down') => {
        await viewport.evaluate((node, direction) => {
          const outer = node.closest<HTMLElement>('.conversation-viewport')!;
          outer.scrollTop = direction === 'up' ? 50 : 0;
          node.scrollTop = direction === 'up' ? 0 : node.scrollHeight;
        }, direction);
        await page.waitForTimeout(150);
        const point = await viewport.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const outer = node.closest<HTMLElement>('.conversation-viewport')!;
          const clip = outer.getBoundingClientRect();
          return {
            x: box.x + 40,
            y: Math.max(box.top, clip.top) + 25,
            before: outer.scrollTop,
            inner: node.scrollTop,
            max: node.scrollHeight - node.clientHeight,
            overscroll: getComputedStyle(node).overscrollBehaviorY,
          };
        });
        const before = point.before;
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(0, direction === 'up' ? -180 : 180);
        await page.waitForTimeout(200);
        const after = await conversation.evaluate((node) => node.scrollTop);
        assert.ok(
          direction === 'up' ? after < before : after > before,
          `aggregate ${direction} boundary trapped the conversation wheel (${JSON.stringify(point)} -> ${after})`,
        );
        await stage(`long-wheel-chain-${direction}`);
        return { before, after };
      };
      const wheelChaining = { up: await wheelBoundary('up'), down: await wheelBoundary('down') };
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: {
          initial,
          final,
          pageDownTop,
          endTop,
          aggregatePointer,
          wheelChaining,
          aggregateEndFade,
          failureTail,
          approvalTail,
          colors,
          approvalMatrix,
        },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      assert.deepEqual(errors, [], 'long group page errors');
      for (const sample of samples.filter((item) => item.activities.length > 0)) {
        assert.equal(
          sample.summaryExtras,
          0,
          'aggregate header retained summary statistics/status',
        );
        assert.equal(sample.nestedButtons, 0, 'nested tool buttons');
        assert.equal(sample.overflow, false, 'long group caused horizontal overflow');
      }
      console.log(
        JSON.stringify({
          longGroup,
          theme,
          width,
          samples: samples.length,
          screenshotFrames,
          initial,
          pageDownTop,
          endTop,
          errors,
        }),
      );
      await page.close();
      continue;
    }
    if (handoff) {
      await stage('handoff-first-tool', () => window.liveAggregationFixture.add(1));
      await stage('handoff-first-receipt', () => window.liveAggregationFixture.settle(1));
      await stage('handoff-first-metadata', () => window.liveAggregationFixture.flush());
      await page.evaluate(() => {
        const text = document.querySelector('.message.user .typeset-chat');
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(text);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
        }
      });
      await page.evaluate(async (withoutBody) => {
        window.liveAggregationPhase = 'handoff-empty-model';
        await window.liveAggregationFixture.model(
          'second-model',
          withoutBody ? 'empty-no-body' : 'empty',
        );
      }, theme === 'dark');
      await page.waitForTimeout(60);
      await page.screenshot({ path: path.join(artifact, `${label}-handoff-empty-model.png`) });
      await page.evaluate(async () => {
        window.liveAggregationPhase = 'handoff-view-before-history';
        window.liveAggregationFixture.holdHistory();
        await window.liveAggregationFixture.model('second-model', 'tool-only');
        window.liveAggregationFixture.add(2);
      });
      await page.waitForFunction(() => window.liveAggregationFixture.historyPending() > 0);
      await page.waitForTimeout(90);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-view-before-history.png`),
      });
      await page.evaluate(() => {
        window.liveAggregationPhase = 'handoff-tool-only-history';
        window.liveAggregationFixture.releaseHistory();
      });
      await page.waitForTimeout(90);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-tool-only-history.png`),
      });
      await page.evaluate(() => {
        window.liveAggregationPhase = 'handoff-second-receipt';
        window.liveAggregationFixture.settle(2);
      });
      await page.waitForFunction(() => window.liveAggregationFixture.pending() > 0);
      await page.evaluate(() => window.liveAggregationFixture.flush());
      await page.evaluate(async () => {
        window.liveAggregationPhase = 'handoff-body-preview-empty';
        await window.liveAggregationFixture.model('third-model', 'body-preview-empty');
      });
      await page.waitForTimeout(90);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-body-preview-empty.png`),
      });
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.message.assistant .typeset-chat')].some((node) =>
          node.textContent?.includes('接着核对下一组工具。'),
        ),
      );
      await page.evaluate(() => {
        window.liveAggregationPhase = 'handoff-body-readable';
      });
      // Observe the final readable state after the existing <=420ms reveal;
      // this test-only wait does not delay any production update or animation.
      await page.waitForTimeout(450);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-body-readable.png`),
      });
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      report.cases.push({ theme, width, errors, screenshotFrames, samples });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      const affected = samples.filter(
        (sample) =>
          [
            'handoff-empty-model',
            'handoff-view-before-history',
            'handoff-tool-only-history',
          ].includes(sample.phase) && sample.activities.length > 0,
      );
      const original = affected[0]!.activities[0]!.node;
      const failures = affected.filter(
        (sample) => sample.activities.length !== 1 || sample.activities[0]!.node !== original,
      );
      const first = affected[0]!;
      for (const sample of affected) {
        const activity = sample.activities[0]!;
        assert.equal(
          activity.titleNode,
          first.activities[0]!.titleNode,
          'handoff replaced action title node',
        );
        assert.equal(
          activity.chevronNode,
          first.activities[0]!.chevronNode,
          'handoff replaced disclosure arrow node',
        );
        assert.deepEqual(
          [0, 1, 3].map((index) => activity.titleBox?.[index]),
          [0, 1, 3].map((index) => first.activities[0]!.titleBox?.[index]),
          'handoff moved action title',
        );
        assert.equal(
          sample.selection,
          '检查连续混合工具的完整执行过程。',
          'handoff lost reader selection',
        );
        assert.equal(sample.scrollTop, first.scrollTop, 'handoff moved reading position');
        assert.deepEqual(sample.footer, first.footer, 'handoff moved input');
      }
      const bodyFrames = samples.filter((sample) =>
        ['handoff-body-preview-empty', 'handoff-body-readable'].includes(sample.phase),
      );
      assert.ok(
        bodyFrames.some((sample) =>
          sample.messages.some(
            (message) =>
              message.role.includes('assistant') && message.text.includes('接着核对下一组工具。'),
          ),
        ),
        'nonempty original Model body was hidden with its empty preview',
      );
      assert.ok(
        !bodyFrames.some((sample) =>
          sample.messages.some((message) => message.text.includes('完整回复读取失败')),
        ),
        'canonical Model body verification failed',
      );
      console.log(
        JSON.stringify({
          handoff,
          samples: samples.length,
          screenshotFrames,
          failures: failures.slice(0, 6).map((sample) => ({
            phase: sample.phase,
            cause: sample.cause,
            activities: sample.activities.map(({ node, text, box }) => ({ node, text, box })),
          })),
          errors,
        }),
      );
      assert.deepEqual(errors, [], 'model handoff page errors');
      handoffFailures += failures.length;
      await page.close();
      continue;
    }
    await stage('single-read', () => window.liveAggregationFixture.add(1));
    await page.waitForFunction(() => document.querySelectorAll('.tool-activity').length > 0);
    await stage('mixed-write', () => window.liveAggregationFixture.add(2));
    await stage('mixed-shell', () => window.liveAggregationFixture.add(3));
    await stage('mixed-mcp', () => window.liveAggregationFixture.add(4));
    await stage('mixed-agent', () => window.liveAggregationFixture.add(5));
    await stage('mixed-search', () => window.liveAggregationFixture.add(6));
    await stage('mixed-edit', () => window.liveAggregationFixture.add(7));
    await stage('receipt-no-view', () =>
      window.liveAggregationFixture.settle(1, 'succeeded', true),
    );
    await page.waitForFunction(() => window.liveAggregationFixture.pending() > 0);
    await stage('metadata-takeover', () => window.liveAggregationFixture.flush());
    const aggregate = page
      .locator('.conversation .tool-activity')
      .filter({ has: page.locator('.tool-activity-summary') })
      .first();
    await page.evaluate(() => {
      window.liveAggregationPhase = 'reader-expanding';
    });
    await aggregate.locator('.tool-activity-summary').first().click();
    await stage('reader-expanded');
    await stage('failed-receipt', () => window.liveAggregationFixture.settle(2, 'failed', true));
    await stage('failed-metadata', () => window.liveAggregationFixture.flush());
    await stage('cancelled-receipt', () =>
      window.liveAggregationFixture.settle(3, 'cancelled', true),
    );
    await stage('cancelled-metadata', () => window.liveAggregationFixture.flush());
    await stage('unknown-receipt', () =>
      window.liveAggregationFixture.settle(4, 'outcome_unknown', true),
    );
    await stage('unknown-metadata', () => window.liveAggregationFixture.flush());
    await page.evaluate(() => {
      window.liveAggregationPhase = 'reader-collapsing';
    });
    await aggregate.locator('.tool-activity-summary').first().click();
    await stage('reader-collapsed');
    for (const index of [5, 6, 7]) {
      await page.evaluate((index) => {
        window.liveAggregationPhase = `complete-${index}`;
        window.liveAggregationFixture.settle(index, 'succeeded', true);
      }, index);
      await page.waitForTimeout(160);
      await page.evaluate(() => window.liveAggregationFixture.flush());
      await page.waitForTimeout(100);
    }
    await stage('all-settled');
    await stage('run-completed', () => window.liveAggregationFixture.finish());
    const process = page.locator('.agent-turn-summary').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    await stage('completed-open-process');
    const beforeCache = await page.evaluate(
      () => window.liveAggregationSamples.at(-1)!.activities[0]?.node,
    );
    await page.getByRole('button', { name: 'Session B', exact: true }).click();
    await stage('other-session');
    await page.getByRole('button', { name: 'Session A', exact: true }).click();
    await stage('cached-return');
    const samples = await page.evaluate(() => window.liveAggregationSamples);
    await cdp.send('Page.stopScreencast');
    report.cases.push({ theme, width, errors, screenshotFrames, samples });
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(errors, [], `${theme}: page errors`);
    const start = samples.findIndex(
      (sample) => sample.phase === 'single-read' && sample.activities.length > 0,
    );
    assert.ok(start >= 0, `${theme}: first tool never appeared`);
    const initial = samples[start]!;
    const active = samples
      .slice(start)
      .filter(
        (sample) =>
          !['run-completed', 'completed-open-process', 'other-session', 'cached-return'].includes(
            sample.phase,
          ),
      );
    for (const sample of active) {
      assert.equal(
        sample.activities.length,
        1,
        `${theme}/${sample.phase}: a tool escaped the aggregate`,
      );
      assert.equal(
        sample.activities[0]!.node,
        initial.activities[0]!.node,
        `${theme}/${sample.phase}: aggregate DOM replaced`,
      );
      assert.equal(sample.outsideTools, 0, `${theme}/${sample.phase}: standalone tool row`);
      assert.equal(sample.overflow, false, `${theme}/${sample.phase}: horizontal overflow`);
      const [x, , activityWidth] = sample.activities[0]!.box;
      assert.ok(
        activityWidth! > 0 && x! >= 0 && x! + activityWidth! <= sample.width,
        `${theme}/${sample.phase}: aggregate exceeds viewport`,
      );
      assert.ok(
        sample.activities[0]!.titleWidth >= 42,
        `${theme}/${sample.phase}: action caption became unreadable`,
      );
      const chevron = sample.activities[0]!.chevronBox;
      assert.ok(
        chevron &&
          chevron[2]! > 0 &&
          chevron[0]! >= x! &&
          chevron[0]! + chevron[2]! <= x! + activityWidth!,
        `${theme}/${sample.phase}: disclosure arrow was clipped`,
      );
      assert.deepEqual(sample.footer, initial.footer, `${theme}/${sample.phase}: input moved`);
    }
    const collapsedPhases = new Set([
      'mixed-write',
      'mixed-shell',
      'mixed-mcp',
      'mixed-agent',
      'mixed-search',
      'mixed-edit',
      'receipt-no-view',
      'metadata-takeover',
      'reader-collapsed',
      'all-settled',
    ]);
    const collapsedStart = active.find((sample) => sample.phase === 'reader-collapsed')!.time;
    for (const sample of active.filter(
      (sample) =>
        collapsedPhases.has(sample.phase) &&
        (sample.phase !== 'reader-collapsed' || sample.time - collapsedStart > 300),
    )) {
      assert.equal(sample.steps, 0, `${theme}/${sample.phase}: collapsed group displayed items`);
      assert.equal(sample.raw, false, `${theme}/${sample.phase}: collapsed raw record leaked`);
      // New actions may grow the caption; its position and row height stay stable.
      assert.deepEqual(
        [0, 1, 3].map((index) => sample.activities[0]!.box[index]),
        [0, 1, 3].map((index) => initial.activities[0]!.box[index]),
        `${theme}/${sample.phase}: collapsed aggregate moved`,
      );
      assert.equal(
        sample.scrollTop,
        initial.scrollTop,
        `${theme}/${sample.phase}: collapsed scroll moved`,
      );
    }
    const last = samples.at(-1)!;
    assert.equal(last.activities.length, 1, `${theme}: cache return has no aggregate`);
    assert.equal(last.activities[0]!.node, beforeCache, `${theme}: cached aggregate node replaced`);
    assert.ok(
      samples.some((sample) => sample.phase === 'reader-expanded' && sample.steps === 7),
      `${theme}: mixed items not displayed`,
    );
    assert.ok(
      samples.some(
        (sample) => sample.phase === 'unknown-metadata' && sample.activities.length === 1,
      ),
      `${theme}: unknown result not covered`,
    );
    console.log(
      JSON.stringify({
        theme,
        width,
        samples: samples.length,
        activeSamples: active.length,
        screenshotFrames,
        errors,
      }),
    );
    await page.close();
  }
  assert.equal(
    handoffFailures,
    0,
    'empty/tool-only Model split or replaced the original tool aggregate',
  );
} finally {
  console.log(JSON.stringify({ artifact }));
  await browser.close();
  server.stop(true);
}
