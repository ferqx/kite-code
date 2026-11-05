import assert from 'node:assert/strict';
import path from 'node:path';
import type { Browser } from 'playwright';
import type {} from './session-shell-browser.fixture';

type SwitchGeometry = {
  state: string | null;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  padding: string;
};
declare global {
  interface Window {
    switchGeometry: {
      active: boolean;
      read: (label?: string) => SwitchGeometry;
      frames: SwitchGeometry[];
    };
  }
}

export async function verifySwitchGeometry(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const motion of ['no-preference', 'reduce'] as const) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        colorScheme: theme,
        reducedMotion: motion,
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const observe = (label: string) =>
        page.evaluate((label) => {
          const read = (name = label) => {
            const node = document.querySelector<HTMLElement>(
              `[role="switch"][aria-label="${name}"]`,
            )!;
            const box = node.getBoundingClientRect();
            const thumb = node.querySelector('[data-slot="switch-thumb"]')!.getBoundingClientRect();
            return {
              state: node.getAttribute('data-state'),
              width: box.width,
              height: box.height,
              thumbWidth: thumb.width,
              thumbHeight: thumb.height,
              left: thumb.left - box.left,
              right: box.right - thumb.right,
              top: thumb.top - box.top,
              bottom: box.bottom - thumb.bottom,
              padding: getComputedStyle(node).padding,
            };
          };
          const state = { active: true, read, frames: [read()] };
          window.switchGeometry = state;
          const sample = () => {
            if (!state.active) return;
            state.frames.push(read());
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          return read();
        }, label);
      const read = (label?: string) =>
        page.evaluate((label) => window.switchGeometry.read(label), label);
      const stop = () =>
        page.evaluate(() => {
          window.switchGeometry.active = false;
          return window.switchGeometry.frames;
        });
      const withinTrack = (box: SwitchGeometry) => {
        assert(Math.abs(box.width - 36) < 0.1);
        assert(Math.abs(box.height - 20) < 0.1);
        assert(Math.abs(box.thumbWidth - 16) < 0.1);
        assert(Math.abs(box.thumbHeight - 16) < 0.1);
        assert(box.left >= 1.5 && box.right >= 1.5, 'thumb stays inside the track');
        assert(Math.abs(box.top - box.bottom) < 0.75, 'thumb stays vertically centered');
      };
      const endpoint = (box: SwitchGeometry, checked: boolean) => {
        withinTrack(box);
        assert.equal(box.state, checked ? 'checked' : 'unchecked');
        assert(Math.abs((checked ? box.right : box.left) - 2) < 0.75, 'consistent end inset');
      };
      try {
        await page.goto(`${url}?form-controls=1&theme=${theme}`);
        await page.getByRole('switch', { name: 'switch-off', exact: true }).waitFor();
        const off = await observe('switch-off');
        const on = await read('switch-on');
        const disabled = await read('switch-disabled');
        endpoint(off, false);
        endpoint(on, true);
        endpoint(disabled, true);
        assert.equal(
          await page.getByRole('switch', { name: 'switch-disabled', exact: true }).isDisabled(),
          true,
        );
        await page.getByRole('switch', { name: 'switch-off', exact: true }).click();
        await page.waitForTimeout(220);
        endpoint(await read(), true);
        await page.getByRole('switch', { name: 'switch-off', exact: true }).press('Space');
        await page.waitForTimeout(220);
        endpoint(await read(), false);
        const frames = await stop();
        frames.forEach(withinTrack);
        if (motion === 'reduce')
          for (const selector of [
            '[aria-label="switch-off"]',
            '[aria-label="switch-off"] [data-slot="switch-thumb"]',
          ])
            assert.equal(
              await page
                .locator(selector)
                .evaluate((node) => getComputedStyle(node).transitionProperty),
              'none',
            );
        await page.screenshot({ path: path.join(artifact, `switch-${theme}-${motion}.png`) });

        await page.goto(`${url}?settings-geometry=1`);
        await page.getByRole('button', { name: '用户菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: '提供商与模型', exact: true }).click();
        await page.getByRole('button', { name: '管理 Demo Service 的模型', exact: true }).click();
        await page.waitForTimeout(220);
        const popupOff = await observe('启用模型 demo-a');
        const popupOn = await read('启用模型 demo-b');
        endpoint(popupOff, false);
        endpoint(popupOn, true);
        await page.screenshot({
          path: path.join(artifact, `switch-popover-${theme}-${motion}.png`),
        });
        const popupFrames = await stop();
        popupFrames.forEach(withinTrack);
        assert.deepEqual(errors, []);
        const result = {
          switchGeometry: true,
          theme,
          motion,
          off,
          on,
          disabled,
          frames,
          popupOff,
          popupOn,
          popupFrames,
          errors,
        };
        await Bun.write(
          path.join(artifact, `switch-${theme}-${motion}.json`),
          JSON.stringify(result, null, 2),
        );
        cases.push(result);
      } finally {
        await page.close();
      }
    }
  }
  return cases;
}

/** Public fields must own their appearance even outside any settings page. */
export async function verifyFormControlStyles(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 600 },
      colorScheme: theme,
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${url}?form-controls=1&theme=${theme}`);
      await page.getByRole('region', { name: '公共表单组件' }).waitFor();
      const states = await page.locator('[data-control-state]').evaluateAll((rows) =>
        rows.map((row) => ({
          state: row.getAttribute('data-control-state'),
          controls: [...row.querySelectorAll('input, textarea, [data-slot="select-trigger"]')]
            .filter((node) => node.getAttribute('aria-label'))
            .map((node) => {
              const style = getComputedStyle(node);
              return {
                label: node.getAttribute('aria-label'),
                background: style.backgroundColor,
                border: style.borderTopColor,
                radius: style.borderRadius,
                opacity: style.opacity,
              };
            }),
        })),
      );
      assert.equal(await page.locator('.settings, .right-sidebar-editor').count(), 0);
      for (const row of states) {
        assert.equal(row.controls.length, 3);
        for (const property of ['background', 'border', 'radius', 'opacity'] as const)
          assert.equal(
            new Set(row.controls.map((control) => control[property])).size,
            1,
            `${theme}/${row.state}: shared ${property}`,
          );
        assert.equal(row.controls[0]!.radius, '8px');
      }
      assert.notEqual(states[0]!.controls[0]!.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(states[0]!.controls[0]!.border, states[1]!.controls[0]!.border);
      assert.equal(states[2]!.controls[0]!.opacity, '0.5');
      for (const type of ['input', 'select', 'textarea'])
        assert.equal(await page.getByLabel(`disabled-${type}`).isDisabled(), true);
      await page.keyboard.press('Tab');
      const focused = [];
      for (const type of ['input', 'select', 'textarea']) {
        const control = page.getByLabel(`normal-${type}`);
        await control.focus();
        focused.push(
          await control.evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              border: style.borderTopColor,
              shadow: style.boxShadow,
              visible: node.matches(':focus-visible'),
            };
          }),
        );
      }
      assert(focused.every((state) => state.visible && state.shadow !== 'none'));
      assert.equal(new Set(focused.map((state) => state.shadow)).size, 1);
      assert.equal(new Set(focused.map((state) => state.border)).size, 1);
      await page.getByLabel('normal-select').click();
      await page.getByRole('option', { name: '选项 B' }).click();
      assert.equal(await page.getByLabel('normal-select').innerText(), '选项 B');
      await page.getByLabel('normal-input').fill('更新后的内容');
      assert.equal(await page.getByLabel('normal-input').inputValue(), '更新后的内容');
      await page.screenshot({ path: path.join(artifact, `form-components-${theme}.png`) });
      assert.deepEqual(errors, []);
      const result = { formControls: true, theme, states, focused, errors };
      await Bun.write(
        path.join(artifact, `form-components-${theme}.json`),
        JSON.stringify(result, null, 2),
      );
      cases.push(result);
    } finally {
      await page.close();
    }
  }
  return cases;
}

type Geometry = {
  phase: string;
  x: number;
  y: number;
  width: number;
  height: number;
  inputs: number;
  reading?: { x: number; width: number; top: number };
};
declare global {
  interface Window {
    shellGeometry: {
      active: boolean;
      phase: string;
      frames: Geometry[];
      read: () => Geometry;
    };
  }
}

/** Actual Native page, CSS and browser layout; no Service or user data. */
export async function verifySessionShellGeometry(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [500, 800, 1440, 1920]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${url}?long=1`);
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.locator('.new-conversation-page [contenteditable="true"]').fill('新对话草稿');
        await page.evaluate(() => {
          const state = {
            active: true,
            phase: 'new',
            frames: [] as Geometry[],
            read: (): Geometry => {
              const inputs = [...document.querySelectorAll<HTMLElement>('.composer')].filter(
                (node) => node.getBoundingClientRect().width > 0,
              );
              const input = inputs[0]!.getBoundingClientRect();
              const column = [...document.querySelectorAll<HTMLElement>('.reading-column')].find(
                (node) => node.getBoundingClientRect().width > 0,
              );
              const reading = column?.getBoundingClientRect();
              return {
                phase: state.phase,
                x: input.x,
                y: input.y,
                width: input.width,
                height: input.height,
                inputs: inputs.length,
                ...(reading
                  ? {
                      reading: {
                        x: reading.x,
                        width: reading.width,
                        top: column!.closest('.conversation-viewport')!.scrollTop,
                      },
                    }
                  : {}),
              };
            },
          };
          window.shellGeometry = state;
          const sample = () => {
            state.frames.push(state.read());
            if (state.active) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        const fresh = await page.evaluate(() => window.shellGeometry.read());
        const phase = async (name: string) => {
          await page.evaluate((name) => {
            window.shellGeometry.phase = name;
          }, name);
          await page.waitForTimeout(80);
          await page.screenshot({
            path: path.join(artifact, `geometry-${theme}-${width}-${name}.png`),
          });
        };
        await phase('new');
        await page.evaluate(() => window.sessionShellFixture.hold());
        await page.getByRole('button', { name: 'Session A', exact: true }).click();
        await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
        await phase('selection');
        await page.evaluate(() => window.sessionShellFixture.release('selection'));
        await page.waitForFunction(() => window.sessionShellFixture.pending('models') > 0);
        await phase('models');
        await page.evaluate(() => window.sessionShellFixture.release('models'));
        await page.waitForFunction(() => window.sessionShellFixture.pending('history') > 0);
        await phase('history');
        await page.evaluate(() => window.sessionShellFixture.resume());
        await page.waitForFunction(() =>
          document.querySelector('.reading-column')?.textContent?.includes('第40段'),
        );
        await phase('loaded');
        const loaded = await page.evaluate(() => window.shellGeometry.read());
        assert.equal(await page.locator('[data-model-trigger]').isEnabled(), true);
        assert.equal(await page.locator('.composer [role="alert"]').count(), 0);
        await page.locator('.composer [contenteditable="true"]').fill('已有会话草稿');
        await page.evaluate(() => {
          const viewport = document.querySelector('.conversation-viewport')!;
          viewport.scrollTop = 80;
          viewport.dispatchEvent(new Event('scroll'));
        });
        await page.locator('.jump-latest').waitFor();
        await phase('reading');
        const reading = await page.evaluate(() => window.shellGeometry.read());
        const jump = await page.locator('.jump-latest').boundingBox();
        assert(jump);
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.locator('.new-conversation-page .composer').waitFor();
        await phase('return-new');
        assert.equal(await page.locator('.composer [contenteditable]').innerText(), '新对话草稿');
        await page.getByRole('button', { name: 'Session A', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.new-conversation-page'));
        await phase('return-cached');
        const returned = await page.evaluate(() => window.shellGeometry.read());
        assert.equal(await page.locator('.composer [contenteditable]').innerText(), '已有会话草稿');
        assert.equal(returned.reading?.top, reading.reading?.top);
        const frames = await page.evaluate(() => {
          window.shellGeometry.active = false;
          return window.shellGeometry.frames;
        });
        const result = { theme, width, fresh, loaded, reading, returned, jump, frames, errors };
        await Bun.write(
          path.join(artifact, `geometry-${theme}-${width}.json`),
          JSON.stringify(result, null, 2),
        );
        for (const frame of frames) {
          const label = `${theme}/${width}/${frame.phase}`;
          assert.equal(frame.inputs, 1, `${label}: one input`);
          assert.equal(frame.x, fresh.x, `${label}: input position`);
          assert.equal(frame.y, fresh.y, `${label}: input vertical position`);
          assert.equal(frame.width, fresh.width, `${label}: input width`);
          assert.equal(frame.height, fresh.height, `${label}: input height`);
          if (frame.reading) {
            assert.equal(frame.reading.x, fresh.x, `${label}: reading alignment`);
            assert.equal(frame.reading.width, fresh.width, `${label}: reading width`);
          }
        }
        assert(Math.abs(jump.x + jump.width / 2 - (fresh.x + fresh.width / 2)) < 1);
        assert.deepEqual(errors, []);
        cases.push(result);
      } finally {
        await page.close();
      }
    }
  }
  return cases;
}

type ToolbarGeometry = {
  phase: string;
  model: string | null;
  composer: number[];
  metrics: number[];
  action: number[];
  rate: number[] | null;
  ring: number[] | null;
  textLeft: number | null;
  textRight: number | null;
  text: string | null;
  same: boolean;
};
declare global {
  interface Window {
    toolbarGeometry: {
      active: boolean;
      phase: string;
      read: () => ToolbarGeometry;
      frames: ToolbarGeometry[];
    };
  }
}

/** Metric availability and changing digits must not move or wrap the toolbar. */
export async function verifyColdSessionToolbarWidth(
  browser: Browser,
  url: string,
  artifact: string,
) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const mode of ['cache', 'both', 'context', 'none']) {
      for (const width of mode === 'cache' ? [500, 810, 820, 830, 1440] : [500, 820, 1440]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await page.goto(`${url}?metrics=${mode}`);
          await page.getByRole('button', { name: 'Session A', exact: true }).click();
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled &&
              !document.querySelector('.composer-metrics[aria-busy="true"]'),
          );
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => {
            const metrics = document.querySelector('.composer-metrics');
            const action = document.querySelector('.composer-actions');
            const ring = document.querySelector('.composer-context-usage');
            const cacheRate = document.querySelector('.composer-cache-rate');
            const state = {
              active: true,
              phase: 'original',
              frames: [] as ToolbarGeometry[],
              read: (): ToolbarGeometry => {
                const rect = (selector: string) => {
                  const value = document.querySelector(selector)?.getBoundingClientRect();
                  return value ? [value.x, value.y, value.width, value.height] : null;
                };
                const rate = document.querySelector('.composer-cache-rate');
                const range = document.createRange();
                if (rate) range.selectNodeContents(rate);
                return {
                  phase: state.phase,
                  model: document.querySelector('[data-model-trigger]')?.textContent ?? null,
                  composer: rect('.composer')!,
                  metrics: rect('.composer-metrics')!,
                  action: rect('.composer-actions')!,
                  rate: rect('.composer-cache-rate'),
                  ring: rect('.composer-context-usage'),
                  textLeft: rate ? range.getBoundingClientRect().left : null,
                  textRight: rate ? range.getBoundingClientRect().right : null,
                  text: rate?.textContent ?? null,
                  same:
                    document.querySelector('.composer-metrics') === metrics &&
                    document.querySelector('.composer-actions') === action &&
                    document.querySelector('.composer-context-usage') === ring &&
                    document.querySelector('.composer-cache-rate') === cacheRate,
                };
              },
            };
            window.toolbarGeometry = state;
            const sample = () => {
              state.frames.push(state.read());
              if (state.active) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          const read = () => page.evaluate(() => window.toolbarGeometry.read());
          const original = await read();
          const phase = async (name: string) => {
            await page.evaluate((name) => {
              window.toolbarGeometry.phase = name;
            }, name);
            await page.waitForTimeout(80);
            await page.screenshot({
              path: path.join(artifact, `toolbar-${theme}-${width}-${mode}-${name}.png`),
            });
          };
          await phase('original');
          await page.evaluate(() => window.sessionShellFixture.hold());
          await page.getByRole('button', { name: 'Session B', exact: true }).click();
          await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
          await phase('selection');
          await page.evaluate(() => window.sessionShellFixture.release('selection'));
          await page.waitForFunction(() => window.sessionShellFixture.pending('models') > 0);
          await phase('models');
          await page.evaluate(() => window.sessionShellFixture.release('models'));
          await page.waitForFunction(() => window.sessionShellFixture.pending('history') > 0);
          assert.equal(await page.locator('.composer-cache-rate').textContent(), '缓存 0%');
          await phase('history');
          const loading = await read();
          if (mode === 'both' || mode === 'context') {
            await page.evaluate(() => window.sessionShellFixture.release('history'));
            await page.waitForFunction(
              () =>
                window.sessionShellFixture.pending('usage') > 0 &&
                window.sessionShellFixture.pending('context') > 0,
            );
            await phase('metrics-pending');
            await page.evaluate(() => window.sessionShellFixture.release('usage'));
            await phase('usage-ready');
            assert.equal(await page.locator('.composer-cache-rate').textContent(), '缓存 0%');
          }
          await page.evaluate(() => window.sessionShellFixture.resume());
          await page.waitForFunction(
            () =>
              document.querySelector('[data-model-trigger]')?.textContent?.includes('Model B') &&
              !document.querySelector('.composer-metrics[aria-busy="true"]'),
          );
          await phase('settled');
          const settled = await read();
          assert.equal(settled.text, mode === 'cache' || mode === 'both' ? '缓存 30%' : '缓存 0%');
          assert.equal(!!settled.ring, true);
          assert.equal(
            await page.locator('.composer-context-usage').getAttribute('aria-label'),
            mode === 'both' || mode === 'context' ? '上下文占用约 4%' : '上下文占用未知',
          );
          await page.getByRole('button', { name: 'Session A', exact: true }).click();
          await page.waitForFunction(
            () => !document.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled,
          );
          await phase('return-cached');
          const frames = await page.evaluate(() => {
            window.toolbarGeometry.active = false;
            return window.toolbarGeometry.frames;
          });
          for (const frame of frames) {
            const label = `${theme}/${width}/${mode}/${frame.phase}`;
            assert.equal(frame.same, true, `${label}: stable toolbar nodes`);
            const expected = frame.model?.includes('Model B') ? loading : original;
            for (const key of ['composer', 'metrics', 'action'] as const)
              assert.deepEqual(frame[key], expected[key], `${label}: ${key} stays put`);
            if (frame.ring && frame.rate && frame.textLeft !== null && frame.textRight !== null) {
              assert(
                Math.abs(frame.ring[0]! - (frame.rate[0]! + frame.rate[2]!) - 4) < 0.25,
                `${label}: compact cache-to-ring gap`,
              );
              assert(
                Math.abs(frame.textLeft + frame.textRight - (2 * frame.rate[0]! + frame.rate[2]!)) <
                  0.5,
                `${label}: centered cache text`,
              );
            }
          }
          const rateWidths = await page.evaluate(() => {
            const rail = document.querySelector('.composer-metrics')!;
            return [0, 1, 10, 99, 100].map((value) => {
              const sample = rail.cloneNode() as HTMLElement;
              sample.style.cssText = 'position:fixed; visibility:hidden';
              const rate = document.createElement('span');
              rate.className = 'composer-cache-rate';
              rate.textContent = `缓存 ${value}%`;
              sample.append(rate);
              rail.parentElement!.append(sample);
              const range = document.createRange();
              range.selectNodeContents(rate);
              if (range.getBoundingClientRect().width > rate.getBoundingClientRect().width)
                throw Error('percentage digits overflow their slot');
              const width = rate.getBoundingClientRect().width;
              sample.remove();
              return width;
            });
          });
          assert.equal(
            new Set(rateWidths).size,
            1,
            `${theme}/${width}/${mode}: 0–100% occupies one width`,
          );
          assert.deepEqual(errors, []);
          await page.locator('.composer-context-usage').focus();
          const tooltip = page.getByRole('tooltip');
          await tooltip.waitFor();
          const detail = await tooltip.textContent();
          assert(detail?.includes('上下文窗口'));
          assert(!detail?.includes('NaN') && !detail?.includes('undefined'));
          if (mode === 'cache' || mode === 'none') assert(detail?.includes('已用未知，总量未知'));
          await page.screenshot({
            path: path.join(artifact, `toolbar-${theme}-${width}-${mode}-tooltip.png`),
          });
          await page.keyboard.press('Escape');
          await tooltip.waitFor({ state: 'hidden' });
          assert.deepEqual((await read()).metrics, original.metrics);
          const result = {
            theme,
            width,
            mode,
            original,
            loading,
            settled,
            frames,
            rateWidths,
            detail,
            errors,
          };
          await Bun.write(
            path.join(artifact, `toolbar-${theme}-${width}-${mode}.json`),
            JSON.stringify(result, null, 2),
          );
          cases.push(result);
        } finally {
          await page.close();
        }
      }
    }
  }
  return cases;
}

export async function verifySettingsGeometry(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [500, 800, 1000, 1020, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 560 }, colorScheme: theme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${url}?settings-geometry=1`);
        await page.getByRole('button', { name: '用户菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: '提供商与模型', exact: true }).click();
        await page.evaluate(() => {
          const read = () => {
            const rect = (selector: string) => {
              const node = document.querySelector<HTMLElement>(selector);
              if (!node) return null;
              const box = node.getBoundingClientRect();
              return {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                scrollTop: node.scrollTop,
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
              };
            };
            return {
              frame: rect('.settings-content-frame')!,
              rail: rect('.settings-editor-panel')!,
              heading: rect('.settings-editor-panel .right-sidebar-heading'),
              body: rect('.right-sidebar-editor-body'),
              footer: rect('.right-sidebar-editor-footer'),
            };
          };
          const state = { active: true, read, frames: [read()] };
          Object.assign(window, { settingsGeometry: state });
          const sample = () => {
            state.frames.push(read());
            if (state.active) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        const read = () => page.evaluate(() => window.settingsGeometry.read());
        await page.getByRole('button', { name: '新增提供商', exact: true }).click();
        await page.waitForTimeout(220);
        const opened = await read();
        const expectedWidth = Math.min(420, opened.frame.width);
        assert(Math.abs(opened.rail.width - expectedWidth) < 1, 'provider uses the shared default');
        assert.equal(opened.body!.scrollTop, 0, 'first focus keeps the top of the form');
        await page.getByRole('textbox', { name: '提供商名称', exact: true }).dblclick();
        const focused = await read();
        assert.equal(focused.rail.scrollTop, 0, 'focus cannot scroll the outer rail');
        await page.getByRole('textbox', { name: '模型名称', exact: true }).click();
        const scrolled = await read();
        assert(scrolled.body!.scrollTop > 0, 'long forms scroll inside the body');
        assert.equal(scrolled.footer!.y, opened.footer!.y, 'footer stays visible while reading');
        const providerName = page.getByRole('textbox', { name: '提供商名称', exact: true });
        await providerName.fill('保留提供商草稿');
        const providerNode = await providerName.elementHandle();
        if (width >= 1020)
          await page.getByRole('button', { name: '新增提供商', exact: true }).click();
        else
          await page
            .getByRole('button', { name: '新增提供商', exact: true })
            .dispatchEvent('click');
        assert.equal(await providerName.inputValue(), '保留提供商草稿');
        assert(await providerName.evaluate((node, original) => node === original, providerNode));
        await page.screenshot({ path: path.join(artifact, `settings-${theme}-${width}.png`) });
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.waitForTimeout(220);
        await page.getByRole('button', { name: '新增提供商', exact: true }).click();
        await page.waitForTimeout(220);
        assert.equal((await read()).body!.scrollTop, 0, 'reopening starts at the top');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.waitForTimeout(220);
        const frames = await page.evaluate(() => {
          window.settingsGeometry.active = false;
          return window.settingsGeometry.frames;
        });
        for (const frame of frames) {
          assert(Math.abs(frame.frame.x - opened.frame.x) < 1, 'navigation stays fixed');
          assert(Math.abs(frame.frame.width - opened.frame.width) < 1, 'outer gutter stays fixed');
          assert.equal(frame.frame.scrollTop, 0, 'content frame never scrolls');
          assert.equal(frame.rail.scrollTop, 0, 'rail never scrolls');
          if (!frame.heading || !frame.body || !frame.footer) continue;
          assert(Math.abs(frame.heading.y - frame.frame.y) < 1, 'header aligns with the frame');
          assert(Math.abs(frame.rail.height - frame.frame.height) < 1, 'rail fits the frame');
          assert(frame.rail.scrollHeight <= frame.rail.clientHeight + 1, 'no outer overflow');
          assert(
            Math.abs(frame.footer.y + frame.footer.height - frame.frame.y - frame.frame.height) < 1,
            'footer aligns with the bottom of the frame',
          );
          assert(frame.body.y + frame.body.height <= frame.footer.y + 1, 'body stays above footer');
        }
        const railWidth = () =>
          page.locator('.settings-editor-panel .right-sidebar').evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.width;
          });
        await page.getByRole('button', { name: 'MCP', exact: true }).click();
        await page.getByRole('button', { name: '新增 MCP', exact: true }).click();
        await page.waitForTimeout(220);
        const mcpWidth = await railWidth();
        assert(Math.abs(mcpWidth - expectedWidth) < 1, 'MCP uses the same default');
        const mcpName = page.getByRole('textbox', { name: 'Name', exact: true });
        await mcpName.fill('保留MCP草稿');
        const mcpNode = await mcpName.elementHandle();
        if (width >= 1020)
          await page.getByRole('button', { name: '新增 MCP', exact: true }).click();
        else
          await page.getByRole('button', { name: '新增 MCP', exact: true }).dispatchEvent('click');
        assert.equal(await mcpName.inputValue(), '保留MCP草稿');
        assert(await mcpName.evaluate((node, original) => node === original, mcpNode));
        await page.getByRole('button', { name: 'Skills', exact: true }).click();
        await page.getByRole('button', { name: '查看 示例 Skill 详情', exact: true }).click();
        await page.waitForTimeout(220);
        const skillsWidth = await railWidth();
        assert(Math.abs(skillsWidth - expectedWidth) < 1, 'Skills uses the same default');
        await page.getByRole('button', { name: '返回应用', exact: true }).click();
        await page.getByRole('button', { name: '定时任务', exact: true }).click();
        await page.getByRole('button', { name: '新建', exact: true }).click();
        await page.waitForTimeout(260);
        const scheduledWidth = () =>
          page.locator('.right-sidebar:has(.scheduled-editor)').evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.width;
          });
        const taskWidth = await scheduledWidth();
        const taskFrameWidth = await page
          .locator('.client-content-frame[data-scheduled-editor="true"]')
          .evaluate((node) => node.getBoundingClientRect().width);
        assert(
          Math.abs(taskWidth - Math.min(420, taskFrameWidth)) < 1,
          'scheduled form uses the same default, bounded by its available frame',
        );
        const scheduledBody = page.locator('.scheduled-editor-body');
        assert(
          await scheduledBody.evaluate((node) => node.scrollWidth <= node.clientWidth),
          'narrow scheduled form does not clip its controls',
        );
        await page.getByRole('textbox', { name: '名称', exact: true }).fill('保留表单草稿');
        await page.setViewportSize({ width: 800, height: 560 });
        await page.waitForTimeout(240);
        assert(Math.abs((await scheduledWidth()) - 420) < 1, 'overlay keeps the shared width');
        await page.setViewportSize({ width: 1280, height: 560 });
        await page.waitForTimeout(300);
        assert(
          Math.abs((await scheduledWidth()) - 420) < 1,
          'returning to docked restores default',
        );
        assert.equal(
          await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(),
          '保留表单草稿',
        );
        await page.setViewportSize({ width: 1440, height: 560 });
        await page.waitForTimeout(260);
        assert(Math.abs((await scheduledWidth()) - 420) < 1, 'wider windows keep the pixel width');
        const handle = await page.locator('#details-resize').boundingBox();
        assert(handle);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + 100, { steps: 6 });
        await page.mouse.up();
        assert(
          Math.abs((await scheduledWidth()) - 420) < 1,
          'form dragging cannot change its width',
        );
        const draft = page.getByRole('textbox', { name: '名称', exact: true });
        const originalDraft = await draft.elementHandle();
        await page.getByRole('button', { name: '新建', exact: true }).click();
        assert.equal(await draft.inputValue(), '保留表单草稿');
        assert(
          await draft.evaluate((node, original) => node === original, originalDraft),
          'reopening keeps the mounted editor',
        );
        await draft.focus();
        await page.locator('#details-resize').dispatchEvent('keydown', { key: 'ArrowLeft' });
        assert(Math.abs((await scheduledWidth()) - 420) < 1, 'keyboard cannot resize a form');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.waitForTimeout(240);
        await page.getByRole('button', { name: '新建', exact: true }).click();
        await page.waitForTimeout(260);
        assert(
          Math.abs((await scheduledWidth()) - 420) < 1,
          'a new form starts at the shared default',
        );
        await page.screenshot({
          path: path.join(artifact, `scheduled-width-${theme}-${width}.png`),
        });
        assert.deepEqual(errors, []);
        const result = {
          settings: true,
          theme,
          width,
          opened,
          focused,
          scrolled,
          mcpWidth,
          skillsWidth,
          taskWidth,
          frames,
          errors,
        };
        await Bun.write(
          path.join(artifact, `settings-${theme}-${width}.json`),
          JSON.stringify(result, null, 2),
        );
        cases.push(result);
      } finally {
        await page.close();
      }
    }
  }
  return cases;
}

export async function verifyMcpSettingsProduct(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [500, 800, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 650 }, colorScheme: theme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${url}?settings-geometry=1`);
        await page.getByRole('button', { name: '用户菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: 'MCP', exact: true }).click();
        const readListRow = (selector: string) =>
          page
            .locator(selector)
            .first()
            .evaluate((row) => {
              const trigger = row.querySelector<HTMLElement>('.settings-list-row-trigger')!;
              const info = trigger.querySelector('.provider-instance-info')!;
              const style = getComputedStyle(row),
                control = getComputedStyle(trigger),
                marker = getComputedStyle(row, '::before');
              return {
                background: style.backgroundColor,
                triggerBackground: control.backgroundColor,
                separator: style.borderBottomWidth,
                triggerBorder: control.borderBottomWidth,
                padding: control.padding,
                titleSize: getComputedStyle(info.querySelector('strong')!).fontSize,
                descriptionSize: getComputedStyle(info.querySelector('span')!).fontSize,
                overflow: row.scrollWidth > row.clientWidth,
                markerWidth: marker.width,
                markerHeight: marker.height,
              };
            });
        await page.getByRole('button', { name: '管理 Knowledge', exact: true }).click();
        const mcpRow = await readListRow('.mcp-settings .settings-list-row');
        assert.equal(
          mcpRow.triggerBackground,
          'rgba(0, 0, 0, 0)',
          'row owns one background across trigger and actions',
        );
        assert.equal(mcpRow.separator, '1px');
        assert.equal(mcpRow.triggerBorder, '0px', 'no second separator under the trigger');
        assert.equal(mcpRow.overflow, false);
        assert.equal(mcpRow.background, 'rgba(0, 0, 0, 0)', 'selection keeps the page background');
        assert.equal(mcpRow.markerWidth, '2px');
        assert.equal(mcpRow.markerHeight, '16px');
        const panel = page.locator('.settings-editor-panel');
        await panel.getByText('搜索知识库中的文档与参考资料。', { exact: true }).waitFor();
        assert.equal(await panel.getByRole('button', { name: '查看工具', exact: true }).count(), 0);
        assert.equal(await panel.getByRole('button', { name: '检查状态', exact: true }).count(), 0);
        assert.equal(await panel.getByRole('button', { name: '建立连接', exact: true }).count(), 0);
        await panel.getByRole('button', { name: 'search_knowledge', exact: true }).dblclick();
        assert.equal(
          await page.locator('.desktop-settings').count(),
          1,
          'double-click stays in settings',
        );
        await panel.getByRole('button', { name: '更多操作', exact: true }).click();
        await panel.getByRole('menuitem', { name: '删除 MCP', exact: true }).waitFor();
        const menu = await panel.getByRole('menu').boundingBox();
        assert(menu && menu.x >= 0 && menu.x + menu.width <= width + 1, 'menu stays in viewport');
        await page.screenshot({ path: path.join(artifact, `mcp-${theme}-${width}-menu.png`) });
        await page.keyboard.press('Escape');
        assert.equal(await panel.getByRole('menu').count(), 0, 'first Escape closes only menu');
        assert.equal(
          await panel.getByRole('complementary', { name: 'Knowledge', exact: true }).count(),
          1,
          'menu Escape keeps detail open',
        );
        await panel.getByRole('button', { name: '更多操作', exact: true }).click();
        await panel.getByRole('menuitem', { name: '删除 MCP', exact: true }).click();
        await panel.getByText('删除 MCP？', { exact: true }).waitFor();
        await panel.getByRole('button', { name: '取消', exact: true }).click();
        await panel.getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: '管理 Research', exact: true }).click();
        await panel.getByRole('button', { name: '登录', exact: true }).click();
        await panel.getByRole('button', { name: '取消登录', exact: true }).waitFor();
        assert.equal(
          await panel.locator('[aria-label="MCP 操作结果"]').count(),
          0,
          'login uses its original action, without a progress card',
        );
        assert.equal(await panel.getByRole('button', { name: '查看结果', exact: true }).count(), 0);
        await panel.getByRole('button', { name: '取消登录', exact: true }).click();
        await panel.getByRole('button', { name: '登录', exact: true }).click();
        await panel.getByText('已登录', { exact: true }).waitFor();
        assert.equal(
          await panel.getByRole('button', { name: '建立连接', exact: true }).isEnabled(),
          true,
          'login does not connect automatically',
        );
        await panel.getByRole('button', { name: '建立连接', exact: true }).click();
        await panel.getByText('搜索知识库中的文档与参考资料。', { exact: true }).waitFor();
        const geometry = await panel.evaluate((node) => ({
          width: node.getBoundingClientRect().width,
          overflow: node.scrollWidth > node.clientWidth,
          bodyOverflow: [
            ...node.querySelectorAll<HTMLElement>('.right-sidebar-editor-body,.mcp-tool-list'),
          ].some((el) => el.scrollWidth > el.clientWidth),
        }));
        const controls = await panel.evaluate((node) => ({
          enableDirection: getComputedStyle(node.querySelector('.mcp-enable')!).flexDirection,
          toolAlignment: getComputedStyle(node.querySelector('.mcp-tool-trigger')!).justifyContent,
          toolBorder: getComputedStyle(node.querySelector('.mcp-tool-trigger')!).borderBottomWidth,
        }));
        assert.equal(controls.enableDirection, 'row');
        assert.equal(controls.toolAlignment, 'space-between');
        assert.equal(
          controls.toolBorder,
          '0px',
          'tool items own a single separator below their description',
        );
        assert.equal(geometry.overflow, false);
        assert.equal(geometry.bodyOverflow, false);
        const frameWidth = await page
          .locator('.settings-content-frame')
          .evaluate((node) => node.clientWidth);
        assert(Math.abs(geometry.width - Math.min(420, frameWidth)) < 1);
        await page.screenshot({ path: path.join(artifact, `mcp-${theme}-${width}-connected.png`) });
        if (width === 1280) {
          await panel.getByRole('button', { name: '关闭', exact: true }).click();
          await page.getByRole('button', { name: '新增 MCP', exact: true }).click();
          await panel.getByRole('textbox', { name: 'Name', exact: true }).fill('fixture-server');
          await panel
            .getByRole('textbox', { name: 'URL or command', exact: true })
            .fill('https://tools.example.com/mcp');
          await panel.getByRole('button', { name: '添加', exact: true }).click();
          await panel.getByRole('button', { name: '取消添加', exact: true }).waitFor();
          assert.equal(await panel.locator('[aria-label="MCP 操作结果"]').count(), 0);
          assert.equal(
            await panel.getByRole('textbox', { name: 'Name', exact: true }).isEnabled(),
            false,
          );
          await page.getByRole('button', { name: '管理 fixture-server', exact: true }).waitFor();
          assert.equal(
            await panel.getByRole('textbox', { name: 'Name', exact: true }).count(),
            0,
            'completed add closes its form',
          );
          await page.getByRole('button', { name: '管理 fixture-server', exact: true }).click();
          await panel.getByRole('button', { name: '更多操作', exact: true }).click();
          await panel.getByRole('menuitem', { name: '删除 MCP', exact: true }).click();
          await panel
            .getByRole('button', { name: 'Confirm exact MCP operation', exact: true })
            .click();
          assert.equal(
            await panel
              .getByRole('switch', { name: '启用 fixture-server', exact: true })
              .isEnabled(),
            false,
          );
          assert.equal(await panel.locator('[aria-label="MCP 操作结果"]').count(), 0);
          await page
            .getByRole('button', { name: '管理 fixture-server', exact: true })
            .waitFor({ state: 'detached' });
          assert.equal(
            await panel.getByRole('complementary').count(),
            0,
            'completed delete closes its detail',
          );
        }
        await page.getByRole('button', { name: 'Skills', exact: true }).click();
        await page.getByRole('button', { name: '查看 示例 Skill 详情', exact: true }).click();
        const skillRow = await readListRow('.skills-settings .settings-list-row');
        assert.deepEqual(skillRow, mcpRow, 'MCP and Skills share the same list appearance');
        await page.screenshot({ path: path.join(artifact, `skills-${theme}-${width}-list.png`) });
        assert.deepEqual(errors, []);
        cases.push({ theme, width, geometry, menu, mcpRow, skillRow, errors });
      } finally {
        await page.close();
      }
    }
  }
  return cases;
}

export async function verifyMcpFailureFeedback(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const)
    for (const width of [500, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 650 }, colorScheme: theme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${url}?settings-geometry=1&mcp-errors=1`);
        await page.getByRole('button', { name: '用户菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: 'MCP', exact: true }).click();
        const panel = page.locator('.settings-editor-panel');
        for (const [name, message] of [
          ['Knowledge', 'HTTP 404'],
          ['Research', 'HTTP 404'],
        ]) {
          await page.getByRole('button', { name: `管理 ${name}`, exact: true }).click();
          const detailHeading = panel.locator('.mcp-detail-heading');
          await panel.evaluate(async (node) => {
            await Promise.all(
              node
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => {})),
            );
          });
          const headingBefore = await detailHeading.boundingBox();
          const retryBefore = await panel
            .getByRole('button', { name: '重试连接', exact: true })
            .boundingBox();
          await panel.getByRole('button', { name: '重试连接', exact: true }).click();
          await panel.getByText(new RegExp(message!)).waitFor();
          assert.equal(await panel.getByText(/示例域名/).count(), 0);
          const hint = await panel.locator('[aria-label="MCP 操作结果"]').boundingBox();
          const content = await panel.locator('.catalogue-empty-note').boundingBox();
          assert.ok(
            hint && content && hint.y >= content.y + content.height,
            'failure follows the detail content',
          );
          assert.deepEqual(
            await detailHeading.boundingBox(),
            headingBefore,
            'failure does not move the service heading',
          );
          assert.deepEqual(
            await panel.getByRole('button', { name: '重试连接', exact: true }).boundingBox(),
            retryBefore,
            'failure does not move the retry button',
          );
          await panel.getByRole('button', { name: '重试连接', exact: true }).click();
          assert.equal(
            await panel.locator('[aria-label="MCP 操作结果"]').count(),
            1,
            'repeated failures have one current notice',
          );
          assert.equal(
            await panel.getByRole('button', { name: '关闭提示', exact: true }).count(),
            1,
          );
          await panel.getByRole('button', { name: '关闭', exact: true }).click();
          assert.equal(
            await page.locator('[aria-label="MCP 操作结果"]').count(),
            0,
            'closed editor failures do not move into the list',
          );
          assert.equal(await page.getByText(/HTTP 404/).count(), 0);
          await page.screenshot({
            path: path.join(artifact, `mcp-failure-closed-${theme}-${width}-${name}.png`),
          });
          const otherName = name === 'Knowledge' ? 'Research' : 'Knowledge';
          await page.getByRole('button', { name: `管理 ${otherName}`, exact: true }).click();
          assert.equal(
            await page.getByText(/HTTP 404/).count(),
            0,
            'another source does not inherit the error',
          );
          await panel.getByRole('button', { name: '关闭', exact: true }).click();
          await page.getByRole('button', { name: `管理 ${name}`, exact: true }).click();
          await panel.getByText(new RegExp(message!)).waitFor();
          await panel.getByRole('button', { name: '更多操作', exact: true }).click();
          assert.deepEqual(
            await panel.getByRole('menuitem').allTextContents(),
            ['删除 MCP'],
            'a stopped failed connection is not disconnectable',
          );
          await page.keyboard.press('Escape');
          await page.screenshot({
            path: path.join(artifact, `mcp-failure-${theme}-${width}-${name}.png`),
          });
          await panel.getByRole('button', { name: '关闭提示', exact: true }).click();
          assert.equal(
            await panel.locator('[aria-label="MCP 操作结果"]').count(),
            0,
            'closing a grouped hint does not expose older failures',
          );
          assert.deepEqual(
            await detailHeading.boundingBox(),
            headingBefore,
            'dismissing failure keeps the service heading in place',
          );
          assert.equal(await panel.evaluate((node) => node.scrollWidth > node.clientWidth), false);
          await panel.getByRole('button', { name: '关闭', exact: true }).click();
        }
        assert.deepEqual(errors, []);
        cases.push({ theme, width, errors });
      } finally {
        await page.close();
      }
    }
  return cases;
}

export async function verifyMcpCustomForms(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const)
    for (const width of [500, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: theme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${url}?settings-geometry=1`);
        await page.getByRole('button', { name: '用户菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: 'MCP', exact: true }).click();
        await page.getByRole('button', { name: '新增 MCP', exact: true }).click();
        const panel = page.locator('.settings-editor-panel');
        await panel.getByRole('combobox', { name: 'Transport', exact: true }).click();
        await page.getByRole('option', { name: 'STDIO 本地命令', exact: true }).click();
        await panel.getByLabel('Name', { exact: true }).fill('server-memory');
        await panel.getByLabel('URL or command', { exact: true }).fill('npx');
        for (const [index, value] of [
          '-y',
          'obsolete',
          '@modelcontextprotocol/server-memory',
        ].entries()) {
          await panel.getByRole('button', { name: '＋ 添加参数', exact: true }).click();
          await panel.getByLabel(`参数 ${index + 1}`, { exact: true }).fill(value);
        }
        await panel.getByRole('button', { name: '删除参数 2', exact: true }).click();
        assert.equal(
          await panel.getByLabel('参数 2', { exact: true }).inputValue(),
          '@modelcontextprotocol/server-memory',
        );
        await panel.getByRole('button', { name: '＋ 添加环境变量', exact: true }).click();
        await panel.getByLabel('环境变量名称 1', { exact: true }).fill('MEMORY_FILE_PATH');
        await panel.getByLabel('环境变量值 1', { exact: true }).fill('C:\\Data\\memory.jsonl');
        await panel.getByRole('button', { name: '＋ 添加变量', exact: true }).click();
        await panel.getByLabel('环境变量传递 1', { exact: true }).fill('SERVICE_TOKEN');
        await panel.getByLabel('Working directory', { exact: true }).fill('~/code');
        const controls = await panel.locator('input:not([type="hidden"])').evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            return {
              background: style.backgroundColor,
              radius: style.borderRadius,
              height: node.getBoundingClientRect().height,
            };
          }),
        );
        assert.ok(controls.length >= 8);
        assert.ok(
          controls.every((control) => JSON.stringify(control) === JSON.stringify(controls[0])),
          'repeated inputs share the common control appearance',
        );
        await panel.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(artifact, `mcp-custom-stdio-${theme}-${width}.png`),
        });
        await panel.getByRole('combobox', { name: 'Transport', exact: true }).click();
        await page.getByRole('option', { name: '流式 HTTP', exact: true }).click();
        assert.equal(await panel.getByLabel('URL or command', { exact: true }).inputValue(), '');
        await panel
          .getByLabel('URL or command', { exact: true })
          .fill('https://tools.example.test/mcp');
        await panel
          .getByLabel('Bearer token environment variable', { exact: true })
          .fill('MCP_BEARER_TOKEN');
        await panel.getByRole('button', { name: '＋ 添加标头', exact: true }).click();
        await panel.getByLabel('标头名称 1', { exact: true }).fill('X-Client');
        await panel.getByLabel('标头值 1', { exact: true }).fill('kite');
        await panel.getByRole('button', { name: '＋ 添加变量', exact: true }).click();
        await panel.getByLabel('来自环境变量的标头名称 1', { exact: true }).fill('X-Api-Key');
        await panel.getByLabel('来自环境变量的标头值 1', { exact: true }).fill('MCP_API_KEY');
        await panel.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(artifact, `mcp-custom-http-${theme}-${width}.png`),
        });
        assert.equal(await panel.evaluate((node) => node.scrollWidth > node.clientWidth), false);
        await panel.getByRole('combobox', { name: 'Transport', exact: true }).click();
        await page.getByRole('option', { name: 'STDIO 本地命令', exact: true }).click();
        assert.equal(await panel.getByLabel('URL or command', { exact: true }).inputValue(), 'npx');
        assert.equal(
          await panel.getByLabel('参数 2', { exact: true }).inputValue(),
          '@modelcontextprotocol/server-memory',
        );
        if (theme === 'dark' && width === 1280) {
          await panel.getByRole('button', { name: '添加', exact: true }).click();
          await panel
            .getByLabel('Name', { exact: true })
            .isDisabled()
            .then((value) => assert.equal(value, true));
          await page.getByRole('button', { name: '管理 server-memory', exact: true }).waitFor();
          await panel.waitFor({ state: 'hidden' });
        }
        assert.deepEqual(errors, []);
        cases.push({ theme, width, controls, errors });
      } finally {
        await page.close();
      }
    }
  return cases;
}

type SettingsGeometryState = {
  frame: { x: number; y: number; width: number; height: number; scrollTop: number };
  rail: {
    width: number;
    height: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  };
  heading: { y: number } | null;
  body: { y: number; height: number; scrollTop: number } | null;
  footer: { y: number; height: number } | null;
};
declare global {
  interface Window {
    settingsGeometry: {
      active: boolean;
      read: () => SettingsGeometryState;
      frames: SettingsGeometryState[];
    };
  }
}
