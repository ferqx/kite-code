import assert from 'node:assert/strict';
import path from 'node:path';
import type { Browser, Locator } from 'playwright';
import type {} from './session-shell-browser.fixture';

function sampleDialogOpening(dialog: Locator) {
  return dialog.evaluate((element) => {
    const frames: { layout: number[][]; title?: string; description?: string }[] = [];
    const snapshot = () => {
      const input = element.querySelector('input');
      const description = element.querySelector('p[id]');
      return {
        layout: [
          element,
          ...element.querySelectorAll('h2, p[id]:not(.sr-only), input, button'),
        ].map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return [x, y, width, height];
        }),
        title: input?.value,
        description: input ? undefined : (description?.textContent ?? undefined),
      };
    };
    let nextFrame = 0;
    const sample = () => {
      if (!element.isConnected) return;
      frames.push(snapshot());
      nextFrame = requestAnimationFrame(sample);
    };
    Reflect.set(element, 'finishOpeningSample', () => {
      cancelAnimationFrame(nextFrame);
      return [...frames, snapshot()];
    });
    sample();
  });
}

async function assertStableDialogOpening(dialog: Locator, originalTitle?: string) {
  const frames = await dialog.evaluate(
    (element) =>
      Reflect.get(element, 'finishOpeningSample')() as {
        layout: number[][];
        title?: string;
        description?: string;
      }[],
  );
  const first = frames[0]!;
  assert.ok(frames.length > 1);
  if (originalTitle !== undefined) assert.equal(first.title, originalTitle);
  else assert.match(first.description ?? '', /Renamed B/);
  for (const frame of frames) assert.deepEqual(frame, first);
}

export async function verifySessionRowActions(browser: Browser, url: string, artifact: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 740 }, colorScheme });
    const errors: string[] = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    try {
      await page.goto(`${url}?manage-sessions=1`);
      const editor = page.locator('.composer textarea');
      const row = (name: string) => page.getByRole('button', { name, exact: true });
      const rowElement = (name: string) => page.locator(`.session-row[aria-label="${name}"]`);
      const menu = (name: string) => row(`${name} 更多操作`);
      const menuOpacity = (name: string) =>
        page
          .locator(`.session-more[aria-label="${name} 更多操作"]`)
          .evaluate((node) => Number(getComputedStyle(node.parentElement!).opacity));
      const open = async (name: string, action: string) => {
        await row(name).hover();
        await menu(name).click();
        await page.getByRole('menuitem', { name: action, exact: true }).click();
      };
      const pending = (phase: string) =>
        page.waitForFunction((phase) => window.sessionShellFixture.pending(phase) === 1, phase);
      const release = (phase: string) =>
        page.evaluate((phase) => window.sessionShellFixture.release(phase), phase);
      const frame = page.locator('.session-header');
      await page.getByText('Reply a', { exact: true }).waitFor();
      await editor.fill('Keep this draft');
      await page.mouse.move(700, 300);
      assert.equal(await menuOpacity('Session A'), 0);
      assert.equal(await menuOpacity('Session B'), 0);
      await row('Session B').hover();
      assert.equal(await menuOpacity('Session A'), 0);
      assert.equal(await menuOpacity('Session B'), 1);
      await menu('Session B').click();
      const panel = page.locator('.session-menu[role="menu"]');
      await panel.waitFor();
      await page.mouse.move(700, 300);
      assert.equal(await menuOpacity('Session B'), 1);
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'Session B 更多操作',
      );
      assert.equal(await menuOpacity('Session B'), 0);
      await row('Session A').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await row('Session B').evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press('Tab');
      assert.equal(
        await menu('Session B').evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press('Enter');
      await panel.waitFor();
      assert.deepEqual(await panel.getByRole('menuitem').allTextContents(), ['重命名', '删除']);
      assert.equal(await rowElement('Session A').getAttribute('aria-current'), 'page');
      assert.equal(await panel.evaluate((node) => getComputedStyle(node).borderRadius), '16px');
      await page.screenshot({ path: path.join(artifact, `session-menu-${colorScheme}.png`) });

      await page.evaluate(() => {
        window.sessionShellFixture.hold();
        const current = document.querySelector('.composer textarea');
        const mutations = {
          frames: [] as { a: boolean; draft: string; same: boolean }[],
          done: false,
        };
        Reflect.set(window, 'sessionFrames', mutations);
        const sample = () => {
          if (mutations.done) return;
          const editor = document.querySelector<HTMLTextAreaElement>('.composer textarea');
          mutations.frames.push({
            a: !!document.querySelector('[aria-label="Session A"][aria-current="page"]'),
            draft: editor?.value ?? '',
            same: current === editor,
          });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await panel.getByRole('menuitem', { name: '重命名' }).press('Enter');
      const rename = page.getByRole('dialog', { name: '重命名会话' });
      const title = rename.getByRole('textbox', { name: '会话名称' });
      await pending('session-observation');
      await sampleDialogOpening(rename);
      assert.equal(await rename.getByRole('button', { name: '保存' }).isDisabled(), true);
      assert.equal(await title.evaluate((node) => node === document.activeElement), true);
      await release('session-observation');
      await page.waitForFunction(
        () => !document.querySelector('.session-management-dialog [role="status"]'),
      );
      await assertStableDialogOpening(rename, 'Session B');
      await title.fill('Renamed B');
      await title.press('Enter');
      await pending('session-mutation');
      await rename.getByRole('button', { name: '保存中…' }).waitFor();
      assert.equal(await rowElement('Session B').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await rename.isVisible(), true);
      await release('session-mutation');
      await row('Renamed B').waitFor();
      await rename.waitFor({ state: 'hidden' });

      await page.evaluate(() => window.sessionShellFixture.resume());
      await open('Renamed B', '删除');
      const remove = page.getByRole('dialog', { name: '删除会话？' });
      await remove.getByText(/Renamed B/).waitFor();
      assert.equal(
        await remove
          .getByRole('button', { name: '取消' })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await remove.getByRole('button', { name: '取消' }).click();
      await remove.waitFor({ state: 'hidden' });
      assert.equal(await rowElement('Renamed B').count(), 1);

      await page.evaluate(() => {
        window.sessionShellFixture.hold();
        window.sessionShellFixture.loseNextSessionReceipt();
      });
      await open('Renamed B', '删除');
      await pending('session-observation');
      await sampleDialogOpening(remove);
      await release('session-observation');
      await page.waitForFunction(() => {
        const submit = document.querySelector<HTMLButtonElement>(
          '.session-management-dialog button[type="submit"]',
        );
        return submit && !submit.disabled;
      });
      await assertStableDialogOpening(remove);
      await remove.getByRole('button', { name: '删除', exact: true }).click();
      await pending('session-mutation');
      assert.equal(await rowElement('Renamed B').count(), 1);
      await release('session-mutation');
      await remove.waitFor({ state: 'hidden' });
      await row('Renamed B').waitFor({ state: 'hidden' });
      const lookup = row('查询会话操作结果');
      await lookup.waitFor();
      await lookup.click();
      await page.getByRole('menuitem', { name: '删除 · Renamed B' }).click();
      await pending('session-lookup');
      await release('session-lookup');
      await lookup.waitFor({ state: 'hidden' });
      const observed = await page.evaluate(() => {
        const sample = Reflect.get(window, 'sessionFrames');
        sample.done = true;
        return {
          frames: sample.frames as { a: boolean; draft: string; same: boolean }[],
          requests: window.sessionShellFixture.requests,
        };
      });
      assert.ok(observed.frames.length > 10);
      assert.ok(
        observed.frames.every(({ a, draft, same }) => a && draft === 'Keep this draft' && same),
      );
      assert.equal(observed.requests.filter(({ method }) => method === 'select').length, 0);
      assert.equal(
        observed.requests.filter(({ method }) => method === 'session.directory.submit').length,
        2,
      );
      const lookupRequest = observed.requests.find(
        ({ method }) => method === 'lookupSessionMutation',
      );
      const deleteRequest = observed.requests.find(
        (request) =>
          request.method === 'session.directory.submit' && request.mutation.kind === 'delete',
      );
      assert.equal(
        lookupRequest?.method === 'lookupSessionMutation' ? lookupRequest.commandId : undefined,
        deleteRequest && 'observationId' in deleteRequest
          ? `session-command-${deleteRequest.observationId}`
          : undefined,
      );

      await page.evaluate(() => window.sessionShellFixture.resume());
      await open('Session A', '重命名');
      await page.evaluate(() => window.sessionShellFixture.withdraw());
      await rename.getByText('会话暂不可用，等待连接恢复。').waitFor();
      await title.fill('Discard while disconnected');
      assert.equal(await rename.getByRole('button', { name: '重新核对' }).isDisabled(), true);
      await page.evaluate(() => window.sessionShellFixture.restoreConnection());
      await rename.getByText('会话暂不可用，等待连接恢复。').waitFor({ state: 'hidden' });
      await rename.getByRole('button', { name: '重新核对' }).click();
      await rename.getByRole('button', { name: '保存' }).waitFor();
      assert.equal(await title.inputValue(), 'Discard while disconnected');
      await page.keyboard.press('Escape');
      assert.equal(await editor.inputValue(), 'Keep this draft');
      await open('Session A', '删除');
      await remove.getByRole('button', { name: '删除', exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifact, `session-delete-${colorScheme}.png`) });
      await remove.getByRole('button', { name: '删除', exact: true }).click();
      await frame.getByText('新对话', { exact: true }).waitFor();
      await page.locator('.new-conversation-page').waitFor();
      await row('Session A').waitFor({ state: 'hidden' });
      assert.equal(await page.getByText('Reply a', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
  return { sessionRowActions: ['light', 'dark'] };
}

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
