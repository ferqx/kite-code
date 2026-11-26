import assert from 'node:assert/strict';
import path from 'node:path';
import { type Browser, expect, type Locator, type Page } from 'playwright/test';
import type {} from './session-shell-browser.fixture';

function sampleDialogOpening(dialog: Locator) {
  return dialog.evaluate((element) => {
    const snapshot = () => {
      const input = element.querySelector('input');
      return {
        layout: [
          element,
          ...element.querySelectorAll('h2, p[id]:not(.sr-only), input, button'),
        ].map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return [x, y, width, height];
        }),
        title: input?.value,
        text: element.textContent,
      };
    };
    const frames: ReturnType<typeof snapshot>[] = [];
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

async function assertStableDialogOpening(
  dialog: Locator,
  titles?: { initial: string; final: string },
) {
  const frames = await dialog.evaluate(
    (element) =>
      Reflect.get(element, 'finishOpeningSample')() as {
        layout: number[][];
        title?: string;
        text: string;
      }[],
  );
  const first = frames[0]!;
  assert.ok(frames.length > 1);
  if (titles) {
    assert.equal(first.title, titles.initial);
    assert.equal(frames.at(-1)?.title, titles.final);
  } else assert.match(first.text, /Renamed B/);
  for (const frame of frames) {
    assert.deepEqual(frame.layout, first.layout);
    assert.equal(frame.text, first.text);
    assert.doesNotMatch(frame.text, /正在核对/);
  }
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
      const headerTitle = frame.locator('.breadcrumb strong');
      const titleAppearance = () =>
        headerTitle.evaluate((node) => {
          const background = getComputedStyle(node.parentElement!.parentElement!).backgroundColor;
          const { color } = getComputedStyle(node);
          const { x, y, width, height } = node.getBoundingClientRect();
          return { background, color, bounds: [x, y, width, height] };
        });
      const idleTitle = await titleAppearance();
      await headerTitle.hover();
      assert.deepEqual(await titleAppearance(), idleTitle);
      await frame.locator('.breadcrumb').hover();
      assert.deepEqual(await titleAppearance(), idleTitle);
      await page.mouse.move(700, 300);
      assert.deepEqual(await titleAppearance(), idleTitle);
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
      const save = rename.getByRole('button', { name: '保存' });
      assert.equal(await title.evaluate((node) => node === document.activeElement), true);
      await title.fill('Renamed B');
      assert.equal(await save.isDisabled(), true);
      await release('session-observation');
      await expect(save).toBeEnabled();
      await assertStableDialogOpening(rename, { initial: 'Session B', final: 'Renamed B' });
      await title.press('Enter');
      await pending('session-mutation');
      await rename.getByRole('button', { name: '保存中…' }).waitFor();
      assert.equal(await rowElement('Session B').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await rename.isVisible(), true);
      await page.evaluate(() => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.native-toast-card'))
            Reflect.set(window, 'sawRenameToast', true);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        Reflect.set(window, 'finishRenameToastSample', () => {
          observer.disconnect();
          return Reflect.get(window, 'sawRenameToast');
        });
      });
      await release('session-mutation');
      await row('Renamed B').waitFor();
      await rename.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.native-toast-card').count(), 0);
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'finishRenameToastSample')()),
        undefined,
      );

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
      const deleteButton = remove.getByRole('button', { name: '删除', exact: true });
      assert.equal(await deleteButton.isDisabled(), true);
      await release('session-observation');
      await expect(deleteButton).toBeEnabled();
      await assertStableDialogOpening(remove);
      await deleteButton.click();
      await pending('session-mutation');
      assert.equal(await rowElement('Renamed B').count(), 1);
      await release('session-mutation');
      await remove.waitFor({ state: 'hidden' });
      await row('Renamed B').waitFor({ state: 'hidden' });
      await page.locator('.native-toast-card').getByText('会话操作结果待确认。').waitFor();
      const lookup = row('查询会话操作结果');
      await lookup.waitFor();
      await lookup.click();
      await page.getByRole('menuitem', { name: '删除 · Renamed B' }).click();
      await pending('session-lookup');
      await release('session-lookup');
      await lookup.waitFor({ state: 'hidden' });
      await page.locator('.native-toast-card').getByText('已请求删除会话。').waitFor();
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

      await page.evaluate(() => window.sessionShellFixture.loseNextSessionReceipt());
      await open('Session A', '重命名');
      await title.fill('Renamed A');
      await save.click();
      await row('Renamed A').waitFor();
      await rename.waitFor({ state: 'hidden' });
      await page.locator('.native-toast-card').getByText('会话操作结果待确认。').waitFor();
      await lookup.click();
      await page.getByRole('menuitem', { name: '重命名 · Session A' }).click();
      await lookup.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.native-toast-card').count(), 0);
      await open('Renamed A', '删除');
      await remove.getByRole('button', { name: '删除', exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifact, `session-delete-${colorScheme}.png`) });
      await remove.getByRole('button', { name: '删除', exact: true }).click();
      await frame.getByText('新对话', { exact: true }).waitFor();
      await page.locator('.new-conversation-page').waitFor();
      await row('Renamed A').waitFor({ state: 'hidden' });
      assert.equal(await page.getByText('Reply a', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
  return { sessionRowActions: ['light', 'dark'] };
}

async function verifySessionRowLoading(page: Page) {
  const row = page.locator('.session-row[aria-label="Session B"]');
  const spinner = row.locator('svg[aria-label="会话运行中"]');
  const more = page.locator('.session-more[aria-label="Session B 更多操作"]');
  const title = row.locator('.nav-copy');
  await spinner.waitFor();
  assert.ok(
    await row.evaluate((node) => node.clientWidth === node.parentElement!.clientWidth),
    'hidden More does not take a separate layout slot',
  );
  const loadingBox = await spinner.boundingBox();
  const moreBox = await more.boundingBox();
  assert.ok(loadingBox && moreBox);
  assert.ok(
    Math.hypot(
      loadingBox.x + loadingBox.width / 2 - (moreBox.x + moreBox.width / 2),
      loadingBox.y + loadingBox.height / 2 - (moreBox.y + moreBox.height / 2),
    ) < 0.5,
    'the loading icon and More share one position',
  );
  const bounds = await title.boundingBox();
  const sample = async (phase: string, loading: boolean, actions: boolean) => {
    const state = {
      loading: await spinner.isVisible(),
      actions: await more.evaluate((node) => Number(getComputedStyle(node.parentElement!).opacity)),
    };
    assert.deepEqual(state, { loading, actions: Number(actions) }, phase);
    assert.deepEqual(await title.boundingBox(), bounds, phase);
    assert.equal(await row.getAttribute('aria-description'), '正在工作', phase);
    return { phase, ...state };
  };
  const phases = [await sample('idle', true, false)];
  await row.hover();
  phases.push(await sample('hovered', false, true));
  assert.equal(
    await page.locator('.session-row[aria-label="Session A"] svg[role="status"]').isVisible(),
    true,
  );
  await page.mouse.move(1100, 650);
  phases.push(await sample('pointer left', true, false));
  await row.hover();
  await more.click();
  const menu = page.locator('.session-menu[role="menu"]');
  await menu.waitFor();
  await page.mouse.move(1100, 650);
  phases.push(await sample('menu open', false, true));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  phases.push(await sample('menu closed', true, false));
  return phases;
}

async function verifyWindowsBackdropLayout(page: Page, url: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${url}?settings-geometry=1`);
  await expect(page.locator('.native-window-titlebar')).toBeVisible();
  const results = [];
  const measure = () =>
    page.evaluate(() => {
      const html = document.documentElement;
      const previousMaterial = html.dataset.windowMaterial;
      const selectors = [
        '.native-window-titlebar',
        '.client-panels',
        '#navigation .client-sidebar-panel',
        '.client-content-frame',
        '.session-header',
        '.composer',
        '#details',
      ];
      const panels = selectors.map((selector) => {
        const panel = document.querySelector(selector);
        if (!panel) throw Error(`Missing Windows layout element: ${selector}`);
        return panel;
      });
      const modes = (['mica', 'acrylic', 'none'] as const).map((material) => {
        html.dataset.windowMaterial = material;
        return {
          material,
          layout: panels.map((panel) => {
            const { x, y, width, height } = panel.getBoundingClientRect();
            return [x, y, width, height];
          }),
          navigationBlur: getComputedStyle(panels[2]!).backdropFilter,
          outline: getComputedStyle(panels[1]!, '::after').borderTopWidth,
        };
      });
      html.dataset.windowMaterial = previousMaterial;
      return modes;
    });
  const verifyLayout = async (width: number) => {
    const modes = await measure();
    const mica = modes[0]!;
    assert.deepEqual(mica.layout[0], [0, 0, width, 32]);
    assert.deepEqual(mica.layout[1], [6, 38, width - 12, 806]);
    for (const mode of modes) {
      assert.deepEqual(mode.layout, mica.layout, `${width}px ${mode.material}`);
      assert.equal(mode.outline, '1px');
      assert.equal(mode.navigationBlur === 'none', mode.material === 'none');
    }
    return modes;
  };
  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 850 });
    results.push({ width, detailsOpen: false, modes: await verifyLayout(width) });
    if (width === 1280) {
      const tabs = page.getByRole('button', { name: '标签页', exact: true });
      await tabs.click();
      await expect(tabs).toHaveAttribute('aria-expanded', 'true');
      await expect
        .poll(async () => (await page.locator('#details').boundingBox())?.width)
        .toBeGreaterThan(0);
      results.push({ width, detailsOpen: true, modes: await verifyLayout(width) });
      await tabs.click();
      await expect(tabs).toHaveAttribute('aria-expanded', 'false');
    }
  }
  return results;
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
      await page.goto(`${url}?worktree-navigation=1&manage-sessions=1`);
      await page.waitForFunction(() => {
        const model = document.querySelector<HTMLButtonElement>('[data-model-trigger]');
        return model && !model.disabled;
      });
      const sessionLoading = await verifySessionRowLoading(page);
      await page.evaluate(() => window.sessionShellFixture.setActive(false));
      await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).waitFor();
      const rowActions = '.space-new-session,.space-more';
      const selector = `.session-search-trigger,.space-add,${rowActions}`;
      const search = page.getByRole('button', { name: '搜索会话', exact: true });
      const add = page.getByRole('button', { name: '添加项目', exact: true });
      const appearance = (button: Locator) =>
        button.evaluate((node) => {
          const { backgroundColor, borderRadius, boxShadow, color, height, width } =
            getComputedStyle(node);
          const icon = node.querySelector('svg')!;
          return {
            backgroundColor,
            borderRadius,
            boxShadow,
            color,
            height,
            width,
            iconSize: [getComputedStyle(icon).width, getComputedStyle(icon).height],
          };
        });
      await page.evaluate((selector) => {
        const original = [...document.querySelectorAll(selector)].map((node) => ({
          node,
          parent: node.parentElement,
        }));
        Reflect.set(window, 'readSidebarActions', () =>
          [...document.querySelectorAll<HTMLButtonElement>(selector)].map((node, index) => {
            const parent = node.parentElement!;
            const buttonOpacity = Number(getComputedStyle(node).opacity);
            const groupOpacity = Number(getComputedStyle(parent).opacity);
            return {
              opacity: buttonOpacity * groupOpacity,
              buttonOpacity,
              groupOpacity,
              disabled: node.disabled,
              same: node === original[index]?.node && parent === original[index].parent,
            };
          }),
        );
      }, selector);
      type ActionSample = {
        opacity: number;
        buttonOpacity: number;
        groupOpacity: number;
        disabled: boolean;
        same: boolean;
      };
      const read = () =>
        page.evaluate(() => Reflect.get(window, 'readSidebarActions')() as ActionSample[]);
      const shown = async (target: string, opacity: number) => {
        await page.waitForFunction(
          ({ target, opacity }) =>
            [...document.querySelectorAll(target)].every(
              (node) =>
                Number(getComputedStyle(node).opacity) *
                  Number(getComputedStyle(node.parentElement!).opacity) ===
                opacity,
            ),
          { target, opacity },
        );
      };
      const hidden = () => shown(rowActions, 0);
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
      assert.deepEqual(
        initial.map((item) => item.opacity),
        [1, 1, 0, 0, 0, 0],
      );
      const header = page.locator('.nav-label');
      const headerStyle = await appearance(search);
      assert.deepEqual(await appearance(add), headerStyle);
      await header.screenshot({ path: path.join(artifact, `sidebar-${theme}-header-idle.png`) });
      await search.hover();
      await expect
        .poll(async () => (await appearance(search)).backgroundColor)
        .not.toBe(headerStyle.backgroundColor);
      await search.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
      });
      const hoverStyle = await appearance(search);
      await add.hover();
      await expect.poll(() => appearance(add)).toEqual(hoverStyle);
      await header.screenshot({ path: path.join(artifact, `sidebar-${theme}-header-hover.png`) });
      await page.mouse.move(1100, 650);
      await expect.poll(() => appearance(add)).toEqual(headerStyle);
      await search.focus();
      await page.keyboard.press('Tab');
      await expect(add).toBeFocused();
      assert.equal(await add.evaluate((node) => node.matches(':focus-visible')), true);
      await page.keyboard.press('Shift+Tab');
      await expect(search).toBeFocused();
      // Even a stronger button opacity must not take ownership of row visibility.
      const override = await page.addStyleTag({ content: `${rowActions}{opacity:.65!important}` });
      await hidden();
      const overridden = await read();
      assert.ok(
        overridden.slice(2).every((item) => item.buttonOpacity === 0.65 && item.groupOpacity === 0),
      );
      await override.evaluate((node) => node.parentNode?.removeChild(node));
      // Clicking Add must not reveal either workspace's actions while the picker is open.
      await page.locator('.composer textarea').click();
      await add.click();
      await page.waitForFunction(
        () => Reflect.get(window, 'sidebarHeldMethod') === 'workspace.pick',
      );
      await expect(add).toBeDisabled();
      const picking = await read();
      assert.deepEqual(
        picking.slice(0, 2).map((item) => item.opacity),
        [1, 1],
      );
      assert.ok(picking.slice(1).every((item) => item.disabled));
      assert.ok(picking.slice(2).every((item) => item.opacity === 0));
      await page.mouse.move(1100, 650);
      await header.screenshot({ path: path.join(artifact, `sidebar-${theme}-header-picker.png`) });
      await page.locator('.space-heading').first().hover();
      await shown('.workspace-group:first-child .space-new-session', 1);
      assert.ok((await read()).slice(4).every((item) => item.opacity === 0));
      await page.evaluate(() => Reflect.get(window, 'releaseSidebarAction')());
      await expect(add).toBeEnabled();
      await page.locator('.composer textarea').click();
      await hidden();
      // Sample every painted frame through sending, pending and response recovery.
      await page.evaluate(() => {
        const read = Reflect.get(window, 'readSidebarActions') as () => ActionSample[];
        const state = { active: true, frames: [] as ActionSample[][] };
        Reflect.set(window, 'sidebarActionFrames', state);
        const tick = () => {
          if (!state.active) return;
          state.frames.push(read());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // Send the fixture's saved draft so this case can focus on the pending submission.
      const draft = page.locator('.composer textarea');
      await expect(draft).toHaveValue('Draft A');
      await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
      await page.waitForFunction(() => Reflect.get(window, 'sidebarHeldMethod') === 'submit');
      await expect(add).toBeDisabled();
      await page.screenshot({ path: path.join(artifact, `sidebar-${theme}-sending.png`) });
      await page.evaluate(() => Reflect.get(window, 'releaseSidebarAction')());
      await expect(add).toBeEnabled();
      await expect(draft).toHaveValue('Draft A');
      await hidden();
      const frames = await page.evaluate(() => {
        const state = Reflect.get(window, 'sidebarActionFrames');
        state.active = false;
        return state.frames as ActionSample[][];
      });
      assert.ok(frames.some((frame) => frame.slice(1).every((item) => item.disabled)));
      assert.ok(frames.some((frame) => frame.slice(1).every((item) => !item.disabled)));
      assert.ok(
        frames.every(
          ([search, add, ...rows]) =>
            rows.length === initial.length - 2 &&
            search?.same &&
            search.opacity === 1 &&
            add?.same &&
            add.groupOpacity === 1 &&
            add.opacity === 1 &&
            rows.every(
              (item) =>
                item.opacity === 0 &&
                item.groupOpacity === 0 &&
                item.same &&
                item.buttonOpacity === 1,
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
      assert.ok((await read()).slice(4).every((item) => item.opacity === 0));
      await page.locator('.space-heading').first().hover();
      await page.locator('.space-more').first().click();
      await page.mouse.move(1100, 650);
      assert.equal(
        await page.locator('.space-heading').first().getAttribute('data-menu-active'),
        'true',
      );
      assert.ok((await read()).slice(2, 4).every((item) => item.opacity === 1));
      await page.keyboard.press('Escape');
      await page.locator('.composer textarea').click();
      await hidden();
      assert.deepEqual(errors, []);
      assert.ok((await read()).every((item) => item.same));

      const tasks = page.getByRole('button', { name: '定时任务', exact: true });
      const newSession = page.getByRole('button', { name: '新对话', exact: true });
      const session = page.getByRole('button', { name: 'Session A', exact: true });
      const current = page.locator('#navigation [aria-current="page"]');
      const transparent = 'rgba(0, 0, 0, 0)';
      const selectedBackground =
        theme === 'light' ? 'rgba(0, 0, 0, 0.09)' : 'rgba(255, 255, 255, 0.11)';
      const hoverBackground =
        theme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.07)';
      const sidebarBackground = theme === 'light' ? 'rgb(245, 245, 245)' : 'rgb(36, 36, 36)';
      const tintLayer = (color: string) => `linear-gradient(${color}, ${color})`;
      const expectNavigationBackground = async (target: Locator, color: string) => {
        await expect(target).toHaveCSS(
          'background-color',
          color === transparent ? transparent : sidebarBackground,
        );
        await expect(target).toHaveCSS(
          'background-image',
          color === transparent ? 'none' : tintLayer(color),
        );
      };
      const expectPressBackground = async (
        action: Locator,
        background: string,
        idle: string,
        target = action,
      ) => {
        await action.hover();
        await expectNavigationBackground(target, background);
        await page.mouse.down();
        try {
          assert.equal(await action.evaluate((node) => node.matches(':active')), true);
          await expectNavigationBackground(target, background);
        } finally {
          await page.mouse.move(1100, 650);
          await page.mouse.up();
        }
        await expectNavigationBackground(target, idle);
      };
      const spaceHeadingRow = page.locator('.space-heading').first();
      const space = spaceHeadingRow.locator('.space-row');
      await expectPressBackground(space, hoverBackground, transparent, spaceHeadingRow);
      const sessionHeading = page.locator('.session-heading').filter({ has: session });
      await expectPressBackground(session, selectedBackground, selectedBackground, sessionHeading);
      for (const action of [newSession, tasks]) {
        await expectNavigationBackground(action, transparent);
        await expectPressBackground(action, hoverBackground, transparent);
      }
      const navigationFrames = await tasks.evaluateHandle((button) => {
        const navigation = button.closest('#navigation')!;
        const samples: {
          current: boolean;
          background: string;
          tint: string;
          currentCount: number;
        }[] = [];
        const state = { recording: true, samples };
        const sample = () => {
          if (!state.recording) return;
          const style = getComputedStyle(button);
          samples.push({
            current: button.getAttribute('aria-current') === 'page',
            background: style.backgroundColor,
            tint: style.backgroundImage,
            currentCount: navigation.querySelectorAll('[aria-current="page"]').length,
          });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      });
      await tasks.click();
      await expect(page.locator('.scheduled-page')).toBeVisible();
      await page.mouse.move(1100, 650);
      await expect(current).toHaveText('定时任务');
      await expectNavigationBackground(tasks, selectedBackground);
      await expectPressBackground(tasks, selectedBackground, selectedBackground);

      await page.getByRole('button', { name: '新建', exact: true }).click();
      const name = page.getByRole('textbox', { name: '名称', exact: true });
      await name.click();
      await name.fill('定时任务草稿');
      await expect(name).toBeFocused();
      await expect(current).toHaveText('定时任务');
      await expectNavigationBackground(tasks, selectedBackground);
      await page.screenshot({ path: path.join(artifact, `sidebar-${theme}-scheduled-editor.png`) });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(name).toBeHidden();
      await expectNavigationBackground(tasks, selectedBackground);

      await session.click();
      await expect(current).toHaveText('Session A');
      await expectNavigationBackground(tasks, transparent);
      await expect(draft).toHaveValue('Draft A');
      await expect(page.getByText('Reply a', { exact: true })).toHaveCount(1);
      const scheduledNavigation = await navigationFrames.evaluate((state) => {
        state.recording = false;
        return state.samples;
      });
      await navigationFrames.dispose();
      assert.ok(scheduledNavigation.some((frame) => frame.current));
      for (const frame of scheduledNavigation) {
        assert.ok(frame.currentCount <= 1);
        if (frame.current) {
          assert.equal(frame.background, sidebarBackground);
          assert.equal(frame.tint, tintLayer(selectedBackground));
        }
      }

      await page.evaluate(() => {
        const fixture = window.sessionShellFixture;
        for (const id of ['c', 'd', 'e', 'f', 'g']) fixture.registerSession(id);
        const request = fixture.bridge.request.bind(fixture.bridge);
        fixture.bridge.request = async (input) => {
          const result = await request(input);
          if (!result || !('directory' in result) || !result.directory) return result;
          return {
            ...result,
            directory: {
              ...result.directory,
              workspaces: [
                ...result.directory.workspaces,
                { id: 'empty', name: 'Empty workspace', rootUri: 'file:///empty' },
              ],
            },
          };
        };
        fixture.publish();
      });
      const navigationColor = await tasks.evaluate((node) => getComputedStyle(node).color);
      const headingColor = theme === 'light' ? 'rgb(102, 102, 102)' : 'rgb(181, 181, 181)';
      const moreSessions = page.getByRole('button', { name: '展开更多', exact: true });
      const emptySpace = page.getByText('暂无聊天', { exact: true });
      const expectNavigationColor = async (labels: Locator, color = navigationColor) => {
        const colors = await labels.evaluateAll((nodes) =>
          nodes.map((node) => getComputedStyle(node).color),
        );
        assert.ok(colors.length > 0);
        assert.deepEqual([...new Set(colors)], [color]);
      };
      await expect(moreSessions).toBeVisible();
      await expect(emptySpace).toBeVisible();
      const directoryLabels = page.locator('.workspace-directory .nav-copy strong');
      const projectHeading = page
        .getByRole('complementary', { name: '项目与会话' })
        .locator('.nav-label');
      await expect(projectHeading.locator('> span')).toHaveText('项目');
      await expect(projectHeading.locator('> span')).toHaveCSS('color', headingColor);
      await expectNavigationColor(directoryLabels);
      await expect(moreSessions).toHaveCSS('color', navigationColor);
      await expect(emptySpace).toHaveCSS('color', navigationColor);
      await page.locator('#navigation').screenshot({
        path: path.join(artifact, `sidebar-${theme}-navigation-color.png`),
      });
      await moreSessions.click();
      await expect(moreSessions).toBeHidden();
      await expectNavigationColor(directoryLabels);

      const rowStyle = (row: Locator) =>
        row.evaluate((node) => {
          const { height, paddingInlineStart, columnGap, borderRadius, fontSize, fontWeight } =
            getComputedStyle(node);
          return { height, paddingInlineStart, columnGap, borderRadius, fontSize, fontWeight };
        });
      const headingStyle = (heading: Locator) =>
        heading.evaluate((node) => {
          const { height, paddingInlineStart, fontSize, fontWeight } = getComputedStyle(node);
          return { height, paddingInlineStart, fontSize, fontWeight };
        });
      const expectCenteredNavigation = async (actions: Locator) => {
        const rows = await actions.evaluateAll((buttons) => {
          const center = (node: Element) => {
            const { top, height } = node.getBoundingClientRect();
            return top + height / 2;
          };
          return buttons.map((button) => {
            const icon = button.querySelector('svg')!;
            const label = button.querySelector('span')!;
            return {
              label: label.textContent,
              iconWidth: icon.getBoundingClientRect().width,
              iconOffset: center(icon) - center(button),
              labelOffset: center(label) - center(button),
            };
          });
        });
        assert.ok(rows.length > 0);
        for (const { label, iconWidth, iconOffset, labelOffset } of rows) {
          assert.equal(iconWidth, 14, `${label} icon size`);
          assert.ok(Math.abs(iconOffset) < 0.1, `${label} icon offset: ${iconOffset}px`);
          assert.ok(Math.abs(labelOffset) < 0.1, `${label} label offset: ${labelOffset}px`);
        }
      };
      const primaryRow = await rowStyle(tasks);
      const primaryHeading = await headingStyle(projectHeading);
      assert.deepEqual(await rowStyle(page.locator('.space-row').first()), primaryRow);
      await expectCenteredNavigation(
        page.locator('.primary-navigation .sidebar-navigation-action'),
      );
      await page.getByRole('button', { name: '用户菜单', exact: true }).click();
      await page.getByRole('menuitem', { name: '设置', exact: true }).click();
      const settingsLabels = page.locator(
        '.native-settings-rail-heading, .native-settings-rail nav button > span',
      );
      const settingsHeadings = page.locator(
        '.native-settings-rail .sidebar-navigation-heading > span',
      );
      const appearanceCategory = page.getByRole('button', { name: '外观', exact: true });
      const generalCategory = page.getByRole('button', { name: '常规', exact: true });
      await expect(appearanceCategory).toBeVisible();
      await expectNavigationColor(settingsLabels);
      await expectNavigationColor(settingsHeadings, headingColor);
      const settingsActions = page.locator('.native-settings-rail .sidebar-navigation-action');
      await expectCenteredNavigation(settingsActions);
      await page.locator('html').evaluate((node) => {
        node.dataset.platform = 'windows';
      });
      await page.setViewportSize({ width: 1280, height: 851 });
      const dialogPixelTop = await page
        .getByRole('dialog', { name: '设置', exact: true })
        .evaluate((node) => node.getBoundingClientRect().top * window.devicePixelRatio);
      assert.ok(Math.abs(dialogPixelTop - Math.round(dialogPixelTop)) < 0.01);
      await expectCenteredNavigation(settingsActions);
      assert.deepEqual(await rowStyle(appearanceCategory), primaryRow);
      assert.deepEqual(
        await headingStyle(
          page.locator('.native-settings-rail .sidebar-navigation-heading').first(),
        ),
        primaryHeading,
      );
      const settingsGroup = page
        .locator('.native-settings-rail section.sidebar-navigation-list')
        .first();
      await expect(settingsGroup).toHaveCSS('row-gap', '2px');
      await expectNavigationBackground(generalCategory, selectedBackground);
      await expectPressBackground(generalCategory, selectedBackground, selectedBackground);
      await expectPressBackground(appearanceCategory, hoverBackground, transparent);
      await expectNavigationBackground(generalCategory, selectedBackground);
      await appearanceCategory.click();
      await expect(appearanceCategory).toHaveAttribute('aria-pressed', 'true');
      await expectNavigationBackground(appearanceCategory, selectedBackground);
      await expectNavigationBackground(generalCategory, transparent);
      await page.mouse.move(1100, 650);
      await expectNavigationBackground(appearanceCategory, selectedBackground);
      await expectNavigationColor(settingsLabels);
      await expectNavigationColor(settingsHeadings, headingColor);
      await page.locator('.native-settings-rail').screenshot({
        path: path.join(artifact, `sidebar-${theme}-settings-color.png`),
      });
      await page.setViewportSize({ width: 800, height: 850 });
      const settingsBack = page.locator('.native-settings-back');
      await expect(settingsBack).toBeVisible();
      await expect(settingsBack).toHaveCSS('color', navigationColor);
      await settingsBack.click();
      await expect(appearanceCategory).toBeFocused();
      await expectNavigationBackground(appearanceCategory, selectedBackground);
      await expectNavigationColor(settingsLabels);
      await expectNavigationColor(settingsHeadings, headingColor);
      await expectCenteredNavigation(settingsActions);
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await expect(draft).toHaveValue('Draft A');
      const windowsBackdrops = await verifyWindowsBackdropLayout(page, url);
      assert.deepEqual(errors, []);
      cases.push({
        theme,
        sessionLoading,
        initial,
        overridden,
        picking,
        frames,
        scheduledNavigation,
        windowsBackdrops,
        errors,
      });
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
                Number(getComputedStyle(node.parentElement!).opacity) ===
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
    await touch.getByRole('button', { name: '添加项目', exact: true }).click();
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
              Number(getComputedStyle(node).opacity) === 1 &&
              Number(getComputedStyle(node.parentElement!).opacity) === 1,
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
