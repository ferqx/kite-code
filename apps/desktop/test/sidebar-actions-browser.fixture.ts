import assert from 'node:assert/strict';
import path from 'node:path';
import { type Browser, expect, type Locator, type Page } from 'playwright/test';
import type {} from './session-shell-browser.fixture';

export async function verifyPageNavigation(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const platform of ['windows', 'macos'] as const) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 730 },
      colorScheme: platform === 'windows' ? 'dark' : 'light',
    });
    const errors: string[] = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    try {
      await page.goto(`${url}?page-navigation=${platform}`);
      const bar = page.locator('.native-window-titlebar');
      const back = bar.getByRole('button', { name: '后退', exact: true });
      const forward = bar.getByRole('button', { name: '前进', exact: true });
      const toggle = bar.locator('.sidebar-toggle');
      const search = bar.getByRole('button', { name: '搜索会话', exact: true });
      const layout = page.locator('#client-layout');
      const titlebarAlignment = () =>
        bar.locator('.session-header-heading').evaluate((heading) => {
          const divider = getComputedStyle(heading, '::before');
          return {
            title: heading.querySelector('strong')!.getBoundingClientRect().left,
            divider: heading.getBoundingClientRect().left + Number.parseFloat(divider.left),
            width: divider.width,
          };
        });
      const macTitlebarLayout = () =>
        bar.evaluate((toolbar) => {
          const header = document.querySelector('.client-main-panel > .session-header')!;
          const heading = header.querySelector('.breadcrumb strong')!.getBoundingClientRect();
          const search = toolbar.querySelector('.session-search-trigger')!.getBoundingClientRect();
          const divider = getComputedStyle(toolbar, '::after');
          const toolbarLeft = toolbar.getBoundingClientRect().left;
          const dividerLeft = toolbarLeft + Number.parseFloat(divider.left);
          const dividerRight = dividerLeft + Number.parseFloat(divider.width);
          const headerStyle = getComputedStyle(header);
          const actions = [...header.querySelectorAll(':scope > button')].map((button) =>
            button.getBoundingClientRect(),
          );
          return {
            title: heading.left,
            headerHeight: header.getBoundingClientRect().height,
            outline: headerStyle.boxShadow,
            actionGap: [
              actions[1]!.left - actions[0]!.right,
              header.getBoundingClientRect().right - actions.at(-1)!.right,
            ],
            divider:
              divider.content === 'none'
                ? null
                : {
                    dimensions: [divider.width, divider.height, divider.marginBlockStart],
                    gaps: [dividerLeft - search.right, heading.left - dividerRight],
                  },
          };
        });
      const draft = page.locator('.composer .prompt-editor');
      const title = page.locator('.breadcrumb strong');
      const content = (id: string) => page.getByText(`Question ${id}`, { exact: true });
      await expect(content('a')).toBeVisible();
      await expect(draft).toBeEditable();
      await expect(back).toBeDisabled();
      await expect(forward).toBeDisabled();
      await expect(search).toBeVisible();
      if (platform === 'windows') {
        await search.press('Enter');
        await expect(search).toHaveAttribute('aria-expanded', 'true');
        await page.evaluate(() => window.dismissFixtureSearch?.());
        await expect(search).toBeFocused();
      }
      await draft.fill('Draft stays with A');
      await page.locator('.conversation').evaluate((node) => {
        node.scrollTop = 0;
      });
      const before = await bar.evaluate((node) => {
        const buttons = [
          ...node.querySelectorAll(':scope > button, nav button, .native-window-search button'),
        ].map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          const icon = button.querySelector('svg')?.getBoundingClientRect();
          const style = getComputedStyle(button);
          return {
            name: button.getAttribute('aria-label') ?? button.textContent,
            x,
            y,
            size: [width, height],
            right: x + width,
            centerY: y + height / 2,
            iconSize: icon ? [icon.width, icon.height] : undefined,
            iconCenterY: icon ? icon.y + icon.height / 2 : undefined,
            iconInlineInset: icon ? [icon.left - x, x + width - icon.right] : undefined,
            appRegion: style.getPropertyValue('-webkit-app-region'),
          };
        });
        const navigation = node.querySelector('nav')!;
        const add = document.querySelector('.nav-label .space-add')!;
        const addBounds = add.getBoundingClientRect();
        const addIcon = add.querySelector('svg')!.getBoundingClientRect();
        const sidebar = document.querySelector('#navigation')!.getBoundingClientRect();
        return {
          buttons,
          top: node.getBoundingClientRect().top,
          bottom: node.getBoundingClientRect().bottom,
          sidebarInsets: {
            start: buttons[0]!.x - sidebar.left,
            end: sidebar.right - buttons.at(-1)!.right,
          },
          contentTop: document
            .querySelector('.native-window-content > .kite-client.shell')!
            .getBoundingClientRect().top,
          addProjectSize: [addBounds.width, addBounds.height],
          addProjectInlineInset: [addIcon.left - addBounds.left, addBounds.right - addIcon.right],
          drag: getComputedStyle(node).getPropertyValue('-webkit-app-region'),
          navigationRight: navigation.getBoundingClientRect().right,
        };
      });
      assert.deepEqual(
        before.buttons.map(({ name }) => name),
        platform === 'windows'
          ? ['应用菜单', '收起侧栏', '后退', '前进', '搜索会话']
          : ['收起侧栏', '后退', '前进', '搜索会话'],
      );
      const rowY = before.buttons[0]!.centerY;
      assert.ok(
        before.buttons.every(
          ({ centerY, appRegion }) => centerY === rowY && appRegion === 'no-drag',
        ),
      );
      assert.equal(before.drag, 'drag');
      const iconButtons = before.buttons;
      for (const button of iconButtons) {
        assert.deepEqual(button.iconSize, [14, 14]);
        assert.deepEqual(button.size, before.addProjectSize);
        assert.deepEqual(button.iconInlineInset, before.addProjectInlineInset);
        assert.equal(button.iconCenterY, rowY);
        assert.equal(button.y - before.top, before.bottom - button.y - button.size[1]!);
      }
      if (platform === 'macos') {
        assert.deepEqual(
          iconButtons.map(({ x }) => x),
          [104, 138, 172, 206],
        );
      } else {
        for (const button of iconButtons) {
          assert.equal(button.y - before.top, 6);
          assert.equal(before.contentTop - button.y - button.size[1]!, 6);
        }
        for (let index = 1; index < iconButtons.length; index++)
          assert.equal(iconButtons[index]!.x - iconButtons[index - 1]!.right, 11);
        const { start, end } = before.sidebarInsets;
        assert.ok(Math.abs(start - end) < 0.5);
      }
      const expandedAlignment = platform === 'windows' ? await titlebarAlignment() : undefined;
      let collapsedAlignment: Awaited<ReturnType<typeof titlebarAlignment>> | undefined;
      const macExpanded = platform === 'macos' ? await macTitlebarLayout() : undefined;
      if (macExpanded) {
        assert.equal(macExpanded.divider, null);
        assert.equal(macExpanded.headerHeight, 48);
        assert.deepEqual(macExpanded.actionGap, [8, 8]);
        assert.match(macExpanded.outline, /-1px.*inset/);
      }
      await bar.screenshot({ path: path.join(artifact, `page-navigation-${platform}.png`) });

      await page.evaluate(() => {
        const frames: {
          title: string;
          x: number;
          searchCount: number;
          titlebarSearch: boolean;
          sidebarWidth: number;
          navigationSurfaceWidth: number;
          sidebarOpen: boolean;
          searchRight: number;
          titleLeft: number;
          contentLeft: number;
          underlineLeft: number;
          dividerLeft: number;
          dividerWidth: number;
          rows: string[];
        }[] = [];
        const tick = () => {
          const title = document.querySelector('.breadcrumb strong');
          const toggle = document.querySelector('.native-window-titlebar .sidebar-toggle');
          const sidebar = document.querySelector('#navigation');
          const windowFrame = document.querySelector('.native-window-frame');
          const toolbar = document.querySelector('.native-window-titlebar');
          const heading = document.querySelector('.session-header-heading');
          const content = document.querySelector('.client-content-frame');
          const windowContent = document.querySelector('.native-window-content');
          const searches = document.querySelectorAll('button[aria-label="搜索会话"]');
          if (
            title &&
            toggle &&
            sidebar &&
            windowFrame &&
            toolbar &&
            heading &&
            content &&
            windowContent
          ) {
            const divider = getComputedStyle(heading, '::before');
            const underline = getComputedStyle(windowContent, '::after');
            const rows = [...document.querySelectorAll('.conversation')].flatMap(
              (node) => (node.textContent ?? '').match(/Question [ab]/g) ?? [],
            );
            frames.push({
              title: title.textContent ?? '',
              x: toggle.getBoundingClientRect().x,
              searchCount: searches.length,
              titlebarSearch: !!searches[0]?.closest('.native-window-titlebar'),
              sidebarWidth: sidebar.getBoundingClientRect().width,
              navigationSurfaceWidth: Number.parseFloat(
                getComputedStyle(windowFrame, '::after').width,
              ),
              sidebarOpen: toggle.getAttribute('aria-expanded') === 'true',
              searchRight: searches[0]?.getBoundingClientRect().right ?? 0,
              titleLeft: title.getBoundingClientRect().left,
              contentLeft: content.getBoundingClientRect().left,
              underlineLeft: Number.parseFloat(underline.left),
              dividerLeft: heading.getBoundingClientRect().left + Number.parseFloat(divider.left),
              dividerWidth: Number.parseFloat(divider.width),
              rows,
            });
          }
          frame = requestAnimationFrame(afterLayout);
        };
        let timer: number | undefined;
        // Sample the painted position after the titlebar's ResizeObserver has run.
        const afterLayout = () => {
          timer = window.setTimeout(tick, 0);
        };
        let frame = requestAnimationFrame(afterLayout);
        Reflect.set(window, 'navigationFrames', () => {
          cancelAnimationFrame(frame);
          clearTimeout(timer);
          return frames;
        });
      });
      if (platform === 'windows') {
        // Keep the transition long enough to check the search before the sidebar settles.
        await page.locator('.kite-client.shell').evaluate((shell) => {
          (shell as HTMLElement).style.setProperty('--sidebar-motion-duration', '420ms');
        });
      }
      await toggle.click();
      await expect(toggle).toHaveAccessibleName('展开侧栏');
      await expect(search).toBeVisible();
      await expect(toggle).toBeFocused();
      await search.click();
      await expect(search).toHaveAttribute('aria-expanded', 'true');
      await expect(title).toHaveText('Session A');
      await expect(back).toBeDisabled();
      await page.evaluate(() => window.dismissFixtureSearch?.());
      await expect(search).toHaveAttribute('aria-expanded', 'false');
      await expect(search).toBeFocused();
      if (expandedAlignment) {
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        collapsedAlignment = await titlebarAlignment();
        assert.equal(collapsedAlignment.divider, 200);
        assert.ok(Math.abs(collapsedAlignment.title - expandedAlignment.title) < 0.5);
        const separators = await bar.evaluate((toolbar) => {
          const session = toolbar.querySelector('.native-window-session')!;
          const heading = session.querySelector('.session-header-heading')!;
          const left = getComputedStyle(heading, '::before');
          const right = getComputedStyle(session, '::after');
          const style = (divider: CSSStyleDeclaration) => [
            divider.height,
            divider.marginBlockStart,
            divider.borderLeftWidth,
            divider.borderLeftColor,
          ];
          const actions = [...session.querySelectorAll('.session-header > button')];
          const lastAction = actions.at(-1)!.getBoundingClientRect();
          const dividerRight =
            session.getBoundingClientRect().right - Number.parseFloat(right.right);
          const captionStart = toolbar.getBoundingClientRect().right - 144;
          return {
            left: style(left),
            right: style(right),
            gaps: [
              dividerRight - Number.parseFloat(right.width) - lastAction.right,
              captionStart - dividerRight,
            ],
          };
        });
        assert.deepEqual(separators.left, separators.right);
        assert.deepEqual(separators.left.slice(0, 3), ['18px', '11px', '1px']);
        assert.deepEqual(separators.gaps, [8, 8]);
        await bar.screenshot({
          path: path.join(artifact, 'page-navigation-windows-collapsed.png'),
        });
      }
      if (macExpanded) {
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        const macCollapsed = await macTitlebarLayout();
        assert.equal(macCollapsed.title, macExpanded.title);
        assert.deepEqual(macCollapsed.actionGap, [8, 8]);
        assert.deepEqual(macCollapsed.divider, {
          dimensions: ['1px', '18px', '15px'],
          gaps: [8, 8],
        });
        await page.screenshot({
          path: path.join(artifact, 'page-navigation-macos-collapsed.png'),
          clip: { x: 0, y: 0, width: 800, height: 48 },
        });
      }
      await toggle.click();
      await expect(toggle).toHaveAccessibleName('收起侧栏');
      if (platform === 'windows') {
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        await expect(search).toBeVisible();
        await expect(toggle).toBeFocused();
        const openWidth = await page.locator('#navigation').evaluate((sidebar) => {
          return sidebar.getBoundingClientRect().width;
        });
        await toggle.click();
        await page.waitForFunction((width) => {
          const current = document.querySelector('#navigation')?.getBoundingClientRect().width;
          return current !== undefined && current > 0 && current < width - 1;
        }, openWidth);
        await expect(search).toBeVisible();
        await toggle.click();
        await expect(search).toBeVisible();
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
      }
      await page.getByRole('button', { name: 'Session B', exact: true }).click();
      await expect(content('b')).toBeVisible();
      await expect(draft).toBeEditable();
      await page.getByRole('button', { name: '定时任务', exact: true }).click();
      await expect(title).toHaveText('定时任务');

      await page.evaluate(() => window.sessionShellFixture.hold());
      await back.click();
      await expect(title).toHaveText('Session B');
      await page.waitForFunction(() => window.sessionShellFixture.pending('selection') === 1);
      await expect(content('b')).toBeVisible();
      await expect(content('a')).toHaveCount(0);
      await back.click();
      await expect(title).toHaveText('Session A');
      await expect(content('a')).toBeVisible();
      await expect(draft).toHaveText('Draft stays with A');
      await expect(content('b')).toHaveCount(0);
      await page.evaluate(() => window.sessionShellFixture.resume());
      await expect(draft).toBeEditable();
      await expect(page.locator('.conversation')).toHaveJSProperty('scrollTop', 0);
      await expect(back).toBeDisabled();
      await forward.focus();
      await expect(forward).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(content('b')).toBeVisible();
      await expect(forward).toBeFocused();
      await forward.click();
      await expect(title).toHaveText('定时任务');
      await expect(forward).toBeDisabled();
      const frames = (await page.evaluate(() => Reflect.get(window, 'navigationFrames')())) as {
        title: string;
        x: number;
        searchCount: number;
        titlebarSearch: boolean;
        sidebarWidth: number;
        navigationSurfaceWidth: number;
        sidebarOpen: boolean;
        searchRight: number;
        titleLeft: number;
        contentLeft: number;
        underlineLeft: number;
        dividerLeft: number;
        dividerWidth: number;
        rows: string[];
      }[];
      assert.ok(frames.length > 10);
      if (platform === 'windows') {
        assert.ok(frames.some((frame) => !frame.sidebarOpen && frame.sidebarWidth > 0));
        assert.ok(frames.some((frame) => frame.sidebarWidth === 0));
      }
      const sidebarToggleX = before.buttons.find(({ name }) => name === '收起侧栏')!.x;
      const searchRight = before.buttons.find(({ name }) => name === '搜索会话')!.right;
      for (const frame of frames) {
        assert.equal(frame.x, sidebarToggleX);
        assert.equal(frame.searchCount, 1);
        assert.equal(frame.titlebarSearch, true);
        assert.equal(frame.searchRight, searchRight);
        assert.ok(frame.titleLeft >= frame.searchRight);
        if (expandedAlignment) {
          assert.ok(Math.abs(frame.navigationSurfaceWidth - frame.sidebarWidth) < 0.05);
          assert.ok(
            Math.abs(frame.titleLeft - expandedAlignment.title) < 0.5,
            JSON.stringify(frame),
          );
          assert.ok(Math.abs(frame.dividerLeft - expandedAlignment.divider) < 0.5);
          assert.equal(frame.dividerWidth, Number.parseFloat(expandedAlignment.width));
          assert.ok(Math.abs(frame.underlineLeft - frame.contentLeft) < 0.05);
        }
        const expected =
          frame.title === 'Session A'
            ? 'Question a'
            : frame.title === 'Session B'
              ? 'Question b'
              : undefined;
        assert.ok(frame.rows.length <= 1 && frame.rows.every((row) => row === expected));
      }
      await page.reload();
      await expect(content('a')).toBeVisible();
      await expect(back).toBeDisabled();
      await expect(forward).toBeDisabled();
      if (collapsedAlignment) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const grip = (await page.locator('#navigation-resize').boundingBox())!;
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
        await page.mouse.down();
        await page.mouse.move(grip.x + 48, grip.y + 100, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await titlebarAlignment()).title).toBeGreaterThan(250);
        const resizedAlignment = await titlebarAlignment();
        await toggle.click();
        await expect(search).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        await expect.poll(titlebarAlignment).toEqual(collapsedAlignment);
        assert.equal(
          await page.locator('#navigation').evaluate((sidebar) => sidebar.getAnimations().length),
          0,
        );
        await toggle.click();
        await expect(search).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        const reopenedAlignment = await titlebarAlignment();
        assert.ok(Math.abs(reopenedAlignment.title - resizedAlignment.title) < 1);
        assert.ok(Math.abs(reopenedAlignment.divider - resizedAlignment.divider) < 1);
      }
      if (macExpanded) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const grip = (await page.locator('#navigation-resize').boundingBox())!;
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
        await page.mouse.down();
        await page.mouse.move(grip.x + 100, grip.y + 100, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await macTitlebarLayout()).title).toBeGreaterThan(300);
        const resized = await macTitlebarLayout();
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        const collapsed = await macTitlebarLayout();
        assert.equal(collapsed.title, macExpanded.title);
        assert.deepEqual(collapsed.divider?.gaps, [8, 8]);
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(layout).not.toHaveAttribute('data-animate-width', 'true');
        const reopened = await macTitlebarLayout();
        assert.ok(Math.abs(reopened.title - resized.title) < 1);
        assert.equal(reopened.divider, null);
      }
      assert.deepEqual(errors, []);
      cases.push({ platform, before, frames, errors });
    } finally {
      await page.close();
    }
  }
  return cases;
}

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
      assert.equal(await menuOpacity('Session B'), 1);
      await row('Session A').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await row('Session B').evaluate((node) => node === document.activeElement),
        true,
      );
      const focusedHeading = page.locator('.session-heading').filter({ has: row('Session B') });
      await expect(focusedHeading).toHaveCSS('outline-width', '2px');
      await expect(focusedHeading).toHaveCSS('outline-offset', '-2px');
      await expect(row('Session B')).toHaveCSS('outline-style', 'none');
      assert.equal(await menuOpacity('Session B'), 0);
      assert.equal(await rowElement('Session A').getAttribute('aria-current'), 'page');
      await focusedHeading.screenshot({
        path: path.join(artifact, `session-row-focus-${colorScheme}.png`),
      });
      await page.keyboard.press('Tab');
      assert.equal(
        await menu('Session B').evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(await menuOpacity('Session B'), 1);
      await expect(focusedHeading).toHaveCSS('outline-style', 'none');
      await expect(menu('Session B')).toHaveCSS('outline-offset', '-2px');
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
      assert.deepEqual(await page.locator('.native-toast-card').allTextContents(), []);
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
      await expect(rowElement('Renamed B')).toHaveCount(0);
      await expect(page.locator('.native-toast-card')).toHaveCount(0);
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

async function rowActionColors(action: Locator) {
  return action.evaluate((button) => {
    const sample = document.createElement('span');
    button.append(sample);
    try {
      sample.style.color = 'var(--muted-foreground)';
      const muted = getComputedStyle(sample).color;
      sample.style.color = 'var(--foreground)';
      return { muted, highlighted: getComputedStyle(sample).color };
    } finally {
      sample.remove();
    }
  });
}

async function verifySessionRowLoading(page: Page) {
  const row = page.locator('.session-row[aria-label="Session B"]');
  const spinner = row.locator('[data-slot="spinner"][aria-label="会话运行中"]');
  const more = page.locator('.session-more[aria-label="Session B 更多操作"]');
  const moreIcon = more.locator('svg');
  const title = row.locator('.nav-copy');
  await spinner.waitFor();
  assert.ok(
    await row.evaluate((node) => node.clientWidth === node.parentElement!.clientWidth),
    'hidden More does not take a separate layout slot',
  );
  const loadingBox = await spinner.boundingBox();
  await expect(spinner).toHaveCSS('width', '14px');
  await expect(spinner).toHaveCSS('animation-name', 'loading-ring-rotate');
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
  const colors = await rowActionColors(more);
  await row.hover();
  phases.push(await sample('hovered', false, true));
  await expect(moreIcon).toHaveCSS('color', colors.muted);
  await more.hover();
  await expect(moreIcon).toHaveCSS('color', colors.highlighted);
  assert.equal(
    await page.locator('.session-row[aria-label="Session A"] [data-slot="spinner"]').isVisible(),
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
  await expect(moreIcon).toHaveCSS('color', colors.muted);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await expect(more).toBeFocused();
  phases.push(await sample('menu closed and trigger focused', false, true));
  await page.keyboard.press('Shift+Tab');
  await expect(row).toBeFocused();
  phases.push(await sample('session focused', true, false));
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
        const workspace = getComputedStyle(panels[1]!);
        const navigationPanel = panels[2]!.closest('#navigation')!;
        const windowFrame = panels[0]!.parentElement!;
        const navigationSurface = getComputedStyle(windowFrame, '::after');
        const contentSurface = getComputedStyle(windowFrame, '::before');
        return {
          material,
          layout: panels.map((panel) => {
            const { x, y, width, height } = panel.getBoundingClientRect();
            return [x, y, width, height];
          }),
          navigationBlur: navigationSurface.backdropFilter,
          navigationWidth: navigationPanel.getBoundingClientRect().width,
          navigationSurfaceWidth: Number.parseFloat(navigationSurface.width),
          contentSurfaceLeft: Number.parseFloat(contentSurface.left),
          toolbarBackground: getComputedStyle(panels[0]!).backgroundColor,
          sidebarBackground: getComputedStyle(panels[2]!).backgroundColor,
          contentSurfaceBackground: contentSurface.backgroundColor,
          contentBackground: getComputedStyle(panels[3]!).backgroundColor,
          radius: workspace.borderRadius,
          shadow: workspace.boxShadow,
          outline: getComputedStyle(panels[1]!, '::after').content,
        };
      });
      html.dataset.windowMaterial = previousMaterial;
      return modes;
    });
  const verifyLayout = async (width: number) => {
    const modes = await measure();
    const mica = modes[0]!;
    assert.deepEqual(mica.layout[0], [0, 0, width, 40]);
    assert.deepEqual(mica.layout[1], [0, 40, width, 810]);
    const header = page.locator('.native-window-titlebar .session-header');
    await expect(header.locator('.breadcrumb strong')).toBeVisible();
    await expect(page.locator('.client-main-panel .session-header')).toHaveCount(0);
    const headerGeometry = await header.evaluate((node) => {
      const title = node.querySelector('strong')!.getBoundingClientRect();
      const actions = [...node.querySelectorAll<HTMLButtonElement>('button')].map((button) => {
        const { height, right, top } = button.getBoundingClientRect();
        return {
          right,
          center: top + height / 2,
          region: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
        };
      });
      const panel = document.querySelector<HTMLElement>('.client-main-panel')!;
      const host = node.parentElement!;
      const separator = getComputedStyle(host, '::after');
      const toolbar = host.parentElement!;
      const underline = getComputedStyle(toolbar.nextElementSibling!, '::after');
      const heading = node.querySelector('.session-header-heading')!;
      const divider = getComputedStyle(heading, '::before');
      const resizeGrip = getComputedStyle(document.querySelector('#navigation-resize')!);
      const contentLeft = panel.getBoundingClientRect().left;
      const navigationRight = document.querySelector('#navigation')!.getBoundingClientRect().right;
      return {
        y: title.top + title.height / 2,
        actions,
        contentOffset: panel.style.getPropertyValue('--session-header-height'),
        background: getComputedStyle(host).backgroundColor,
        separator: [separator.height, separator.right, separator.borderLeftWidth],
        titleInset: title.left - contentLeft,
        divider: [divider.top, divider.bottom, divider.height, divider.width],
        dividerOffset:
          heading.getBoundingClientRect().left + Number.parseFloat(divider.left) - navigationRight,
        dividerMatchesResizeGrip: divider.backgroundColor === resizeGrip.backgroundColor,
        underline: [
          Number.parseFloat(underline.left) - contentLeft,
          underline.bottom,
          underline.borderBottomWidth,
        ],
      };
    });
    assert.equal(headerGeometry.y, 20);
    assert.equal(headerGeometry.contentOffset, '0px');
    assert.equal(headerGeometry.background, 'rgba(0, 0, 0, 0)');
    assert.deepEqual(headerGeometry.separator, ['18px', '-9px', '1px']);
    assert.deepEqual(headerGeometry.divider, ['0px', '0px', '40px', '1px']);
    assert.ok(Math.abs(headerGeometry.dividerOffset) < 0.05, JSON.stringify(headerGeometry));
    assert.equal(headerGeometry.dividerMatchesResizeGrip, true);
    assert.ok(Math.abs(headerGeometry.titleInset - 16) < 0.05);
    assert.equal(headerGeometry.underline[1], '810px');
    assert.equal(headerGeometry.underline[2], '1px');
    assert.ok(Math.abs(Number(headerGeometry.underline[0])) < 0.05);
    assert.ok(headerGeometry.actions.length > 0);
    assert.ok(
      headerGeometry.actions.every(
        ({ right, center, region }) =>
          right <= width - 144 && center === 20 && region === 'no-drag',
      ),
    );
    for (const mode of modes) {
      assert.deepEqual(mode.layout, mica.layout, `${width}px ${mode.material}`);
      assert.equal(mode.radius, '0px');
      assert.equal(mode.shadow, 'none');
      assert.equal(mode.outline, 'none');
      assert.notEqual(mode.contentBackground, 'rgba(0, 0, 0, 0)');
      assert.equal(mode.toolbarBackground, 'rgba(0, 0, 0, 0)');
      assert.equal(mode.sidebarBackground, 'rgba(0, 0, 0, 0)');
      assert.equal(mode.contentSurfaceBackground, mode.contentBackground);
      assert.ok(Math.abs(mode.navigationSurfaceWidth - mode.navigationWidth) < 0.05);
      assert.ok(Math.abs(mode.contentSurfaceLeft - mode.navigationWidth) < 0.05);
      assert.equal(mode.navigationBlur === 'none', mode.material === 'none');
    }
    return modes;
  };
  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 850 });
    results.push({ width, detailsOpen: false, modes: await verifyLayout(width) });
    if (width === 1280) {
      const tabs = page.getByRole('button', { name: '标签页', exact: true });
      const tabsAppearance = () =>
        tabs.evaluate((button) => ({
          background: getComputedStyle(button).backgroundColor,
          icon: button.querySelector('svg')!.innerHTML,
        }));
      const closedAppearance = await tabsAppearance();
      await tabs.click();
      await expect(tabs).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#session-tabs .right-sidebar-close')).toHaveCount(0);
      const selectedTab = page.getByRole('tab', { selected: true });
      const activeChip = page.locator('#session-tabs .session-tab[data-active="true"]');
      await expect(activeChip).toHaveCSS('border-top-width', '0px');
      await expect(activeChip).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await selectedTab.press('ArrowLeft');
      await expect(selectedTab).toHaveCSS('outline-width', '2px');
      await expect
        .poll(async () => (await page.locator('#details').boundingBox())?.width)
        .toBeGreaterThan(0);
      results.push({ width, detailsOpen: true, modes: await verifyLayout(width) });
      await page.mouse.move(600, 300);
      const openAppearance = await tabsAppearance();
      assert.notEqual(openAppearance.icon, closedAppearance.icon);
      await expect
        .poll(async () => (await tabsAppearance()).background)
        .toBe(closedAppearance.background);
      await tabs.click();
      await expect(tabs).toHaveAttribute('aria-expanded', 'false');
      await expect(tabs).toBeFocused();
      await page.mouse.move(600, 300);
      await expect.poll(tabsAppearance).toEqual(closedAppearance);
    }
  }
  return results;
}

async function verifyWorkspaceName(page: Page, url: string, artifact: string, theme: string) {
  await page.goto(`${url}?worktree-navigation=1&rename-workspaces=1`);
  const project = page.locator('.workspace-group').first();
  const row = project.locator('.space-row');
  const more = project.locator('.space-more');
  const edit = page.getByRole('menuitem', { name: '编辑名称', exact: true });
  const dialog = page.getByRole('dialog', { name: '编辑项目名称' });
  const input = dialog.getByRole('textbox', { name: '项目名称' });
  const draft = page.locator('.composer textarea');
  await expect(draft).toHaveValue('Draft A');
  await expect(row).toHaveText('Workspace');
  const expanded = await row.getAttribute('aria-expanded');

  await row.hover();
  const actions = project.locator('.sidebar-actions button');
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toHaveAccessibleName('Workspace 更多操作');
  await expect(actions.nth(1)).toHaveAccessibleName('在 Workspace 中新建对话');
  await more.click();
  const menu = page.getByRole('menu', { name: 'Workspace 更多操作', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveText(['编辑名称', '移除项目']);
  await menu.screenshot({ path: path.join(artifact, `sidebar-${theme}-rename-menu.png`) });
  await edit.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Workspace');
  assert.deepEqual(
    await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd]),
    [0, 9],
  );
  await input.fill('取消的名称');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(row).toHaveText('Workspace');

  await page.keyboard.press('Enter');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await input.fill('   ');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('请输入项目名称。');
  await expect(input).toBeFocused();
  await page.evaluate(() => {
    const bridge = window.sessionShellFixture.bridge;
    const original = bridge.request.bind(bridge);
    bridge.request = async (request) => {
      if (request.method !== 'workspace.rename') return original(request);
      bridge.request = original;
      await new Promise<void>((resolve) => Reflect.set(window, 'settleRename', resolve));
      throw Error('workspace_name_unavailable');
    };
  });
  const name = '项目显示名';
  await input.fill(name);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
  await expect(row).toHaveText('Workspace');
  await page.evaluate(() => Reflect.get(window, 'settleRename')());
  await expect(dialog.getByRole('alert')).toHaveText('项目名称保存失败，请重试。');
  await expect(input).toHaveValue(name);
  await expect(row).toHaveText('Workspace');
  await page.screenshot({ path: path.join(artifact, `sidebar-${theme}-rename-retry.png`) });

  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(row).toHaveText(name);
  await expect(row).toHaveAttribute('aria-expanded', expanded!);
  await expect(project.getByRole('button', { name: 'Session A', exact: true })).toBeVisible();
  await expect(draft).toHaveValue('Draft A');
  await expect(page.locator('.workspace-group').nth(1).locator('.space-row')).toHaveText(
    'Worktree project',
  );
  await page.screenshot({ path: path.join(artifact, `sidebar-${theme}-rename-saved.png`) });

  await page.reload();
  await expect(row).toHaveText(name);
  await expect(draft).toHaveValue('Draft A');
  await row.hover();
  await project.getByRole('button', { name: `在 ${name} 中新建对话`, exact: true }).click();
  await expect(page.getByRole('button', { name: '项目', exact: true })).toHaveText(name);
  await expect(draft).toBeEditable();
  await expect(draft).toBeFocused();
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
      const projectMore = page.locator('.space-more').first();
      const projectNew = page.locator('.space-new-session').first();
      const projectActionInset = () =>
        projectNew.evaluate((button) => {
          const row = button.closest('.space-heading')!.getBoundingClientRect();
          return row.right - button.getBoundingClientRect().right;
        });
      assert.equal(await projectActionInset(), 4);
      const moreIcon = projectMore.locator('svg');
      const newIcon = projectNew.locator('svg');
      const colors = await rowActionColors(projectMore);
      await page.locator('.space-row').first().hover();
      await expect(moreIcon).toHaveCSS('color', colors.muted);
      await expect(newIcon).toHaveCSS('color', colors.muted);
      await projectMore.hover();
      await expect(moreIcon).toHaveCSS('color', colors.highlighted);
      await expect(newIcon).toHaveCSS('color', colors.muted);
      await projectNew.hover();
      await expect(moreIcon).toHaveCSS('color', colors.muted);
      await expect(newIcon).toHaveCSS('color', colors.highlighted);
      assert.equal(await projectActionInset(), 4);
      await page
        .locator('.space-heading')
        .first()
        .screenshot({
          path: path.join(artifact, `sidebar-${theme}-project-action-hover.png`),
        });
      await page.mouse.move(1100, 650);

      // Keyboard access still reveals an otherwise hidden row.
      await page.locator('.space-row').first().focus();
      await page.keyboard.press('Tab');
      await expect(projectMore).toBeFocused();
      await expect(moreIcon).toHaveCSS('color', colors.muted);
      await page.keyboard.press('Tab');
      await expect(projectNew).toBeFocused();
      assert.equal(await projectActionInset(), 4);
      await expect(newIcon).toHaveCSS('color', colors.muted);
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
      const highlightBackground =
        theme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.07)';
      const expectNavigationBackground = async (target: Locator, color: string) => {
        await expect(target).toHaveCSS('background-color', color);
        await expect(target).toHaveCSS('background-image', 'none');
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
      await expectPressBackground(space, highlightBackground, transparent, spaceHeadingRow);
      const sessionHeading = page.locator('.session-heading').filter({ has: session });
      await expectPressBackground(
        session,
        highlightBackground,
        highlightBackground,
        sessionHeading,
      );
      for (const action of [newSession, tasks]) {
        await expectNavigationBackground(action, transparent);
        await expectPressBackground(action, highlightBackground, transparent);
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
      await expectNavigationBackground(tasks, highlightBackground);
      await expectPressBackground(tasks, highlightBackground, highlightBackground);

      await page.getByRole('button', { name: '新建', exact: true }).click();
      const name = page.getByRole('textbox', { name: '名称', exact: true });
      await name.click();
      await name.fill('定时任务草稿');
      await expect(name).toBeFocused();
      await expect(current).toHaveText('定时任务');
      await expectNavigationBackground(tasks, highlightBackground);
      await page.screenshot({ path: path.join(artifact, `sidebar-${theme}-scheduled-editor.png`) });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(name).toBeHidden();
      await expectNavigationBackground(tasks, highlightBackground);

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
          assert.equal(frame.background, highlightBackground);
          assert.equal(frame.tint, 'none');
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
      await expectPressBackground(moreSessions, highlightBackground, transparent);
      await moreSessions.hover();
      await expectNavigationBackground(moreSessions, highlightBackground);
      await page.locator('#navigation').screenshot({
        path: path.join(artifact, `sidebar-${theme}-navigation-color.png`),
      });
      await moreSessions.click();
      await expect(moreSessions).toBeHidden();
      await expectNavigationBackground(sessionHeading, highlightBackground);
      await expectNavigationColor(directoryLabels);
      const unselectedSession = page.locator('.session-heading:not(.selected)').first();
      await expectPressBackground(
        unselectedSession.locator('.session-row'),
        highlightBackground,
        transparent,
        unselectedSession,
      );

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
      await expectNavigationBackground(generalCategory, highlightBackground);
      await expectPressBackground(generalCategory, highlightBackground, highlightBackground);
      await expectPressBackground(appearanceCategory, highlightBackground, transparent);
      await expectNavigationBackground(generalCategory, highlightBackground);
      await appearanceCategory.click();
      await expect(appearanceCategory).toHaveAttribute('aria-pressed', 'true');
      await expectNavigationBackground(appearanceCategory, highlightBackground);
      await expectNavigationBackground(generalCategory, transparent);
      await page.mouse.move(1100, 650);
      await expectNavigationBackground(appearanceCategory, highlightBackground);
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
      await expectNavigationBackground(appearanceCategory, highlightBackground);
      await expectNavigationColor(settingsLabels);
      await expectNavigationColor(settingsHeadings, headingColor);
      await expectCenteredNavigation(settingsActions);
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      await expect(draft).toHaveValue('Draft A');
      const windowsBackdrops = await verifyWindowsBackdropLayout(page, url);
      await verifyWorkspaceName(page, url, artifact, theme);
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
    await touch.goto(`${url}?worktree-navigation=1&rename-workspaces=1`);
    await touch.waitForFunction(() => document.querySelector('.space-more'));
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
