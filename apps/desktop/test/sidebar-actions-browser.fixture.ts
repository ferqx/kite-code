import assert from 'node:assert/strict';
import path from 'node:path';
import type { Browser } from 'playwright';
import type {} from './session-shell-browser.fixture';

/** Exercise Native pending transitions with actual Sidebar controls and production CSS. */
export async function verifySidebarActions(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 850 },
      colorScheme: theme,
    });
    const errors: string[] = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    try {
      await page.goto(`${url}?worktree-navigation=1`);
      await page.waitForFunction(() => {
        const model = document.querySelector<HTMLButtonElement>('[data-model-trigger]');
        return model && !model.disabled;
      });
      await page.evaluate(() => window.sessionShellFixture.setActive(false));
      await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).waitFor();
      const selector = '.space-add,.space-new-session,.space-more';
      await page.evaluate((selector) => {
        const nodes = [...document.querySelectorAll(selector)];
        Reflect.set(window, 'sidebarActionNodes', nodes);
        Reflect.set(
          window,
          'sidebarActionGroups',
          nodes.map((node) => node.closest('.sidebar-actions')),
        );
      }, selector);
      const read = () =>
        page.locator(selector).evaluateAll((nodes) =>
          nodes.map((node, index) => {
            const group = node.closest('.sidebar-actions')!;
            const buttonOpacity = Number(getComputedStyle(node).opacity);
            const groupOpacity = Number(getComputedStyle(group).opacity);
            return {
              opacity: buttonOpacity * groupOpacity,
              buttonOpacity,
              groupOpacity,
              disabled: (node as HTMLButtonElement).disabled,
              same:
                node === Reflect.get(window, 'sidebarActionNodes')[index] &&
                group === Reflect.get(window, 'sidebarActionGroups')[index],
            };
          }),
        );
      const shown = async (target: string, opacity: number) => {
        await page.waitForFunction(
          ({ target, opacity }) =>
            [...document.querySelectorAll(target)].every(
              (node) =>
                Number(getComputedStyle(node).opacity) *
                  Number(getComputedStyle(node.closest('.sidebar-actions')!).opacity) ===
                opacity,
            ),
          { target, opacity },
        );
      };
      const hidden = () => shown(selector, 0);
      // Keep the real Native handlers, holding only the external picker/submission response.
      await page.evaluate(() => {
        const bridge = window.sessionShellFixture.bridge;
        const original = bridge.request.bind(bridge);
        bridge.request = async (request) => {
          if (request.method === 'workspace.pick' || request.method === 'submit') {
            Reflect.set(window, 'sidebarHeldMethod', request.method);
            await new Promise<void>((resolve) =>
              Reflect.set(window, 'releaseSidebarAction', resolve),
            );
            Reflect.set(window, 'sidebarHeldMethod', null);
            return null; // Cancel picker / unconfirmed submission, then recover normally.
          }
          return original(request);
        };
      });
      await page.mouse.move(1100, 650);
      await hidden();
      const initial = await read();
      assert.equal(initial.length, 5);
      // Even a stronger button opacity must not take ownership of row visibility.
      const override = await page.addStyleTag({ content: `${selector}{opacity:1!important}` });
      await hidden();
      const overridden = await read();
      assert.ok(overridden.every((item) => item.buttonOpacity === 1 && item.groupOpacity === 0));
      await override.evaluate((node) => node.parentNode?.removeChild(node));
      // Clicking Add must not reveal either workspace's actions while the picker is open.
      await page.locator('.nav-label').hover();
      await page.getByRole('button', { name: '添加空间', exact: true }).click();
      await page.waitForFunction(
        () => Reflect.get(window, 'sidebarHeldMethod') === 'workspace.pick',
      );
      await shown('.space-add', 0.45);
      const picking = await read();
      assert.ok(picking.every((item) => item.disabled));
      assert.ok(picking.slice(1).every((item) => item.opacity === 0));
      await page.mouse.move(1100, 650);
      // Add retains focus; only its own title row may remain visible.
      await page.locator('.space-heading').first().hover();
      await shown('.workspace-group:first-child .space-new-session', 0.45);
      assert.ok((await read()).slice(3).every((item) => item.opacity === 0));
      await page.evaluate(() => Reflect.get(window, 'releaseSidebarAction')());
      await page.waitForFunction(
        () => !document.querySelector<HTMLButtonElement>('.space-add')!.disabled,
      );
      await page.locator('.composer textarea').click();
      await hidden();
      // Sample every painted frame through sending, pending and response recovery.
      await page.evaluate((selector) => {
        const state = {
          active: true,
          frames: [] as {
            opacity: number;
            buttonOpacity: number;
            groupOpacity: number;
            disabled: boolean;
            same: boolean;
          }[][],
        };
        Reflect.set(window, 'sidebarActionFrames', state);
        const tick = () => {
          if (!state.active) return;
          state.frames.push(
            [...document.querySelectorAll<HTMLButtonElement>(selector)].map((node, index) => {
              const group = node.closest('.sidebar-actions')!;
              const buttonOpacity = Number(getComputedStyle(node).opacity);
              const groupOpacity = Number(getComputedStyle(group).opacity);
              return {
                opacity: buttonOpacity * groupOpacity,
                buttonOpacity,
                groupOpacity,
                disabled: node.disabled,
                same:
                  node === Reflect.get(window, 'sidebarActionNodes')[index] &&
                  group === Reflect.get(window, 'sidebarActionGroups')[index],
              };
            }),
          );
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, selector);
      await page.locator('.composer textarea').fill('Check sidebar visibility');
      await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
      await page.waitForFunction(() => Reflect.get(window, 'sidebarHeldMethod') === 'submit');
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>('.space-add')!.disabled,
      );
      await page.screenshot({ path: path.join(artifact, `sidebar-${theme}-sending.png`) });
      await page.evaluate(() => Reflect.get(window, 'releaseSidebarAction')());
      await page.waitForFunction(
        () => !document.querySelector<HTMLButtonElement>('.space-add')!.disabled,
      );
      await hidden();
      const frames = await page.evaluate(() => {
        const state = Reflect.get(window, 'sidebarActionFrames');
        state.active = false;
        return state.frames as {
          opacity: number;
          buttonOpacity: number;
          groupOpacity: number;
          disabled: boolean;
          same: boolean;
        }[][];
      });
      assert.ok(frames.some((frame) => frame.every((item) => item.disabled)));
      assert.ok(frames.some((frame) => frame.every((item) => !item.disabled)));
      assert.ok(
        frames.every(
          (frame) =>
            frame.length === initial.length &&
            frame.every(
              (item) =>
                item.opacity === 0 &&
                item.groupOpacity === 0 &&
                item.same &&
                item.buttonOpacity === (item.disabled ? 0.45 : 1),
            ),
        ),
      );
      // Keyboard access still reveals an otherwise hidden row.
      await page.locator('.space-row').first().focus();
      await page.keyboard.press('Tab');
      assert.equal(
        await page
          .locator('.space-new-session')
          .first()
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await shown('.workspace-group:first-child .space-new-session', 1);
      assert.ok((await read()).slice(3).every((item) => item.opacity === 0));
      await page.locator('.space-heading').first().hover();
      await page.locator('.space-more').first().click();
      await page.mouse.move(1100, 650);
      assert.equal(
        await page.locator('.space-heading').first().getAttribute('data-menu-active'),
        'true',
      );
      assert.ok((await read()).slice(1, 3).every((item) => item.opacity === 1));
      await page.keyboard.press('Escape');
      await page.locator('.composer textarea').click();
      await hidden();
      assert.deepEqual(errors, []);
      assert.ok((await read()).every((item) => item.same));
      cases.push({ theme, initial, overridden, picking, frames, errors });
    } finally {
      await page.close();
    }
  }
  const touch = await browser.newPage({ hasTouch: true, isMobile: true });
  try {
    await touch.goto(`${url}?worktree-navigation=1`);
    await touch.waitForFunction(() => document.querySelector('.space-new-session'));
    assert.equal(await touch.evaluate(() => matchMedia('(hover: none)').matches), true);
    assert.ok(
      await touch
        .locator('.space-add,.space-new-session,.space-more')
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              Number(getComputedStyle(node).opacity) *
                Number(getComputedStyle(node.closest('.sidebar-actions')!).opacity) ===
              1,
          ),
        ),
    );
    await touch.evaluate(() => {
      const bridge = window.sessionShellFixture.bridge;
      const original = bridge.request.bind(bridge);
      bridge.request = async (request) => {
        if (request.method !== 'workspace.pick') return original(request);
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseSidebarPicker', resolve));
        return null;
      };
    });
    await touch.getByRole('button', { name: '添加空间', exact: true }).click();
    await touch.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('.space-add')!.disabled,
    );
    assert.ok(
      await touch
        .locator('.space-add,.space-new-session,.space-more')
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              (node as HTMLButtonElement).disabled &&
              Number(getComputedStyle(node).opacity) === 0.45 &&
              Number(getComputedStyle(node.closest('.sidebar-actions')!).opacity) === 1,
          ),
        ),
    );
    await touch.evaluate(() => Reflect.get(window, 'releaseSidebarPicker')());
    await touch.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('.space-add')!.disabled,
    );
  } finally {
    await touch.close();
  }
  return cases;
}
