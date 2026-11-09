import assert from 'node:assert/strict';
import path from 'node:path';
import type { Browser } from 'playwright';
import type {} from './session-shell-browser.fixture';

/** Hidden preparation must paint no leaf controls, including inherited visibility transitions. */
export async function verifyComposerHandoff(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 850 },
      colorScheme: theme,
      locale: 'zh-CN',
    });
    const errors: string[] = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    try {
      await page.goto(`${url}?model-navigation=1&metrics=both`);
      const row = (id: string) =>
        page.getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true });
      const ready = (id: string) =>
        page.waitForFunction((id) => {
          const model = document.querySelector<HTMLButtonElement>('[data-model-trigger]');
          const permission = document.querySelector<HTMLButtonElement>('[data-permission-trigger]');
          return (
            document.querySelector('.breadcrumb strong')?.textContent ===
              `Session ${id.toUpperCase()}` &&
            model &&
            !model.disabled &&
            permission &&
            !permission.disabled &&
            !document.querySelector('[data-presentation-pending]')
          );
        }, id);
      await row('a').click();
      await ready('a');
      await page.waitForFunction(() =>
        document
          .querySelector('.composer-context-usage')
          ?.getAttribute('aria-label')
          ?.includes('%'),
      );
      await page.evaluate(() => {
        const state = { phase: 'initial', frames: [] as unknown[] };
        Reflect.set(window, 'composerHandoffObservation', state);
        const capture = () => {
          const painted = (element: HTMLElement) => {
            const style = getComputedStyle(element);
            if (
              !element.getBoundingClientRect().height ||
              style.visibility === 'hidden' ||
              style.display === 'none'
            )
              return false;
            for (
              let ancestor: Element | null = element;
              ancestor;
              ancestor = ancestor.parentElement
            )
              if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
            return true;
          };
          const overlays = [
            ...document.querySelectorAll<HTMLElement>(
              '.model-effort-popover,.composer-attach-menu,.permission-menu,.composer-context-tooltip',
            ),
          ]
            .filter(painted)
            .map((element) => ({
              label: element.getAttribute('aria-label') ?? element.className,
              state: element.dataset.state,
              opacity: getComputedStyle(element).opacity,
              animation: getComputedStyle(element).animationName,
              text: element.textContent,
            }));
          state.frames.push({
            phase: state.phase,
            title: document.querySelector('.breadcrumb strong')?.textContent,
            overlays,
            model: document.querySelector('[data-model-trigger]')?.textContent,
            permission: document.querySelector('[data-permission-trigger]')?.textContent,
            pending: !!document.querySelector('[data-presentation-pending]'),
            controls: [
              ...document.querySelectorAll<HTMLElement>(
                '.composer-attach,[data-model-trigger],[data-permission-trigger],.model-effort-summary,.composer-context-usage,.composer-actions button',
              ),
            ]
              .filter(painted)
              .map((element) => element.getAttribute('aria-label') ?? element.textContent),
          });
        };
        new MutationObserver(capture).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const tick = () => {
          capture();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // A cold direct switch keeps the Composer DOM for layout measurement.
      // Its leaf controls can transition inherited visibility after the form hides.
      await page.evaluate(() => {
        Reflect.get(window, 'composerHandoffObservation').phase = 'cold';
        window.sessionShellFixture.hold();
      });
      await row('b').click();
      await page.waitForFunction(() => !!document.querySelector('[data-presentation-pending]'));
      await page.screenshot({ path: path.join(artifact, `handoff-${theme}-cold-pending.png`) });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const tick = () => (++frames === 12 ? resolve() : requestAnimationFrame(tick));
            requestAnimationFrame(tick);
          }),
      );
      await page.evaluate(() => window.sessionShellFixture.resume());
      await ready('b');
      await page.screenshot({ path: path.join(artifact, `handoff-${theme}-cold-ready.png`) });
      for (const overlay of ['model', 'permission', 'attachment', 'context']) {
        await row('a').click();
        await ready('a');
        await page.evaluate((overlay) => {
          Reflect.get(window, 'composerHandoffObservation').phase = overlay;
        }, overlay);
        const popup =
          overlay === 'model'
            ? '.model-effort-popover'
            : overlay === 'permission'
              ? '.permission-menu'
              : overlay === 'attachment'
                ? '.composer-attach-menu'
                : '.composer-context-tooltip';
        if (overlay === 'model') await page.locator('[data-model-trigger]').click();
        else if (overlay === 'permission') await page.locator('[data-permission-trigger]').click();
        else if (overlay === 'attachment') await page.locator('.composer-attach').click();
        else await page.locator('.composer-context-usage').hover();
        await page.locator(popup).waitFor({ state: 'visible' });
        await page.screenshot({
          path: path.join(artifact, `handoff-${theme}-${overlay}-open.png`),
        });
        // Modal dropdowns dismiss before the sidebar becomes a pointer target.
        if (overlay === 'permission' || overlay === 'attachment')
          await page.keyboard.press('Escape');
        await page.evaluate(() => window.sessionShellFixture.hold());
        await row('b').click();
        await page.waitForFunction(
          () => document.querySelector('.breadcrumb strong')?.textContent === 'Session B',
        );
        await page.screenshot({
          path: path.join(artifact, `handoff-${theme}-${overlay}-selected.png`),
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              let frames = 0;
              const tick = () => (++frames === 12 ? resolve() : requestAnimationFrame(tick));
              requestAnimationFrame(tick);
            }),
        );
        await page.evaluate(() => window.sessionShellFixture.resume());
        await ready('b');
        await page.screenshot({
          path: path.join(artifact, `handoff-${theme}-${overlay}-ready.png`),
        });
      }
      const frames = (await page.evaluate(
        () => Reflect.get(window, 'composerHandoffObservation').frames,
      )) as {
        phase: string;
        title?: string;
        overlays: unknown[];
        pending: boolean;
        controls: unknown[];
      }[];
      const violations = frames.filter(
        (frame) =>
          (frame.pending && frame.controls.length) ||
          (frame.title === 'Session B' && frame.overlays.length),
      );
      await Bun.write(
        path.join(artifact, `handoff-${theme}.json`),
        JSON.stringify({ frames, errors, violations }, null, 2),
      );
      assert.deepEqual(
        violations.slice(0, 3),
        [],
        `${theme}: hidden composer descendants still paint`,
      );
      assert.deepEqual(errors, []);
      cases.push({ kind: 'composer-handoff', theme, frames, errors });
    } finally {
      await page.close();
    }
  }
  return cases;
}

/** Observe every navigation frame; controlled failures remain distinct from departed reads. */
export async function verifyModelCatalogueNavigation(
  browser: Browser,
  url: string,
  artifact: string,
  unselected = false,
  withoutPermissions = false,
) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 850 },
      colorScheme: theme,
      locale: 'zh-CN',
    });
    page.setDefaultTimeout(10000);
    const errors: string[] = [],
      phases: unknown[] = [];
    page.on('pageerror', (cause) => errors.push(cause.message));
    try {
      await page.goto(
        `${url}?model-navigation=1&distinct-efforts=1${unselected ? '&unselected-model=1' : ''}${withoutPermissions ? '&without-permissions=1' : ''}`,
      );
      const row = (id: string) =>
        page.getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true });
      const ready = (id: string) =>
        page.waitForFunction(
          ({ id, withoutPermissions }) => {
            const model = document.querySelector<HTMLButtonElement>('[data-model-trigger]');
            const permission = document.querySelector<HTMLButtonElement>(
              '[data-permission-trigger]',
            );
            return (
              model &&
              !model.disabled &&
              (withoutPermissions ? !permission : permission && !permission.disabled) &&
              !document.querySelector('[data-presentation-pending]') &&
              document.querySelector('.composer')?.getAttribute('data-session-loading') !==
                'true' &&
              document.querySelector('.breadcrumb strong')?.textContent ===
                `Session ${id.toUpperCase()}`
            );
          },
          { id, withoutPermissions },
        );
      await row('a').click();
      await ready('a');
      await page.evaluate(() => {
        Reflect.set(window, 'readModelNavigationDraft', () => {
          const editor = document.querySelector('.composer [role="textbox"]');
          // innerText inserts two newlines between block paragraphs, while
          // the editor's preserved Markdown line boundary is one newline.
          const text = (node: Node): string =>
            node.nodeName === 'BR'
              ? '\n'
              : node.nodeType === 3
                ? (node.textContent ?? '')
                : [...node.childNodes].map(text).join('');
          return editor
            ? [...editor.children]
                .map((child) => (child.textContent ? text(child) : ''))
                .join('\n')
                .replace(/\r\n?/g, '\n')
            : undefined;
        });
      });
      const readDraft = () =>
        page.evaluate(() => Reflect.get(window, 'readModelNavigationDraft')());
      const editor = page.locator('.composer [role="textbox"]');
      await editor.fill('保留会话 A 的未发送草稿');
      await editor.press('End');
      for (const line of ['第二行草稿', '第三行草稿', '第四行草稿', '第五行草稿']) {
        await editor.press('Shift+Enter');
        await page.keyboard.insertText(line);
      }
      const draftA = await readDraft();
      assert.equal(draftA.split('\n').filter(Boolean).length, 5);
      const originalComposerTop = await page
        .locator('.composer')
        .evaluate((element) => element.getBoundingClientRect().top);
      const originalModelLeft = await page
        .locator('[data-model-trigger]')
        .evaluate((element) => element.getBoundingClientRect().left);
      const originalScroll = await page.locator('.conversation-viewport').evaluate((viewport) => {
        viewport.scrollTop = Math.min(140, viewport.scrollHeight - viewport.clientHeight);
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        return viewport.scrollTop;
      });
      assert.ok(originalScroll > 0);
      await page.evaluate(() => {
        const state = {
          phase: 'initial',
          expected: undefined as string | undefined,
          frames: [] as unknown[],
        };
        Reflect.set(window, 'modelNavigationObservation', state);
        const capture = () => {
          const editor = document.querySelector<HTMLElement>('.composer [role="textbox"]');
          const visible = (element: Element | null) => {
            if (
              !element?.getBoundingClientRect().height ||
              getComputedStyle(element).visibility === 'hidden'
            )
              return false;
            for (
              let ancestor: Element | null = element;
              ancestor;
              ancestor = ancestor.parentElement
            )
              if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
            return true;
          };
          const composer = document.querySelector<HTMLElement>('.composer');
          state.frames.push({
            phase: state.phase,
            expected: state.expected,
            title: document.querySelector('.breadcrumb strong')?.textContent,
            model: document.querySelector('[data-model-trigger]')?.textContent,
            effort: document.querySelector('.model-effort-summary')?.textContent,
            modelLeft: document.querySelector('[data-model-trigger]')?.getBoundingClientRect().left,
            attachment: !!document.querySelector('.composer-attach'),
            permission: document.querySelector('[data-permission-trigger]')?.textContent,
            composerVisible: visible(composer),
            composerTop: composer?.getBoundingClientRect().top,
            scrollTop: document.querySelector('.conversation-viewport')?.scrollTop,
            presentationPending: !!document.querySelector('[data-presentation-pending]'),
            paintedControls: [
              ...document.querySelectorAll(
                '.composer-attach,[data-model-trigger],[data-permission-trigger],.model-effort-summary,.composer-context-usage,.composer-actions button',
              ),
            ].filter(visible).length,
            disabled: document.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled,
            readonly: editor?.getAttribute('contenteditable'),
            draft: Reflect.get(window, 'readModelNavigationDraft')(),
            alerts: [...document.querySelectorAll('[role="alert"]')].map(
              (node) => node.textContent,
            ),
            messages: [...document.querySelectorAll<HTMLElement>('article.message')]
              .filter(visible)
              .map((node) => node.dataset.messageId),
            welcome: !!document.querySelector('.new-conversation-welcome'),
          });
        };
        const observer = new MutationObserver(capture);
        observer.observe(document.querySelector('.kite-client')!, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const observe = () => {
          capture();
          requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      });
      const phase = async (name: string) => {
        await page.evaluate((name) => {
          Reflect.get(window, 'modelNavigationObservation').phase = name;
        }, name);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              let count = 0;
              const tick = () => (++count === 6 ? resolve() : requestAnimationFrame(tick));
              requestAnimationFrame(tick);
            }),
        );
        await page.screenshot({
          path: path.join(
            artifact,
            `${withoutPermissions ? 'unlabeled-models' : unselected ? 'unset-models' : 'models'}-${theme}-${name}.png`,
          ),
        });
        phases.push({
          name,
          ...(await page.evaluate(() =>
            Reflect.get(window, 'modelNavigationObservation').frames.at(-1),
          )),
        });
      };
      const inputReads = () =>
        page.evaluate(
          () =>
            window.sessionShellFixture.requests.filter(
              (input) => input.method === 'input.models.read',
            ).length,
        );
      const tasks = async () => {
        await page.getByRole('button', { name: '定时任务', exact: true }).click();
        await page.locator('.scheduled-page').waitFor();
      };
      const expectTarget = (id?: string) =>
        page.evaluate((id) => {
          Reflect.get(window, 'modelNavigationObservation').expected = id;
        }, id);
      for (const [visit, id] of ['a', 'b', 'a'].entries()) {
        const name = visit === 0 ? 'same-a' : id;
        await tasks();
        await expectTarget(id);
        const before = await inputReads();
        await page.evaluate(() => window.sessionShellFixture.hold());
        await row(id).click();
        await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
        await phase(`${name}-selection`);
        assert.equal(await page.locator('.composer').isVisible(), id === 'a');
        if (id === 'a') {
          assert.equal(await page.locator('[data-model-trigger]').isDisabled(), true);
          if (withoutPermissions)
            assert.equal(await page.locator('[data-permission-trigger]').count(), 0);
          else
            assert.equal(await page.locator('[data-permission-trigger]').innerText(), '自动审核');
        }
        assert.equal(await inputReads(), before);
        await page.evaluate(() => window.sessionShellFixture.release('selection'));
        await page.waitForFunction(() => window.sessionShellFixture.pending('models') > 0);
        await phase(`${name}-models`);
        assert.equal(await page.locator('.composer').isVisible(), id === 'a');
        assert.equal(await inputReads(), before + 1);
        await page.evaluate(() => window.sessionShellFixture.release('models'));
        if (id === 'b') {
          await page.waitForFunction(() => window.sessionShellFixture.pending('draft') > 0);
          await phase('b-draft');
          assert.equal(await page.locator('.composer').count(), 0);
          await page.evaluate(() => window.sessionShellFixture.release('draft'));
        }
        await phase(`${name}-history`);
        assert.equal(await page.locator('.composer').isVisible(), id === 'a');
        await page.evaluate(() => window.sessionShellFixture.resume());
        await ready(id);
        await page.getByText(`Reply ${id}`, { exact: true }).waitFor();
        await phase(`${name}-ready`);
        if (id === 'a')
          assert.ok(
            Math.abs(
              (await page
                .locator('.conversation-viewport')
                .evaluate((element) => element.scrollTop)) - originalScroll,
            ) < 2,
          );
      }
      assert.equal(await readDraft(), draftA);
      await tasks();
      await expectTarget('b');
      await page.evaluate(() => window.sessionShellFixture.hold());
      await row('b').click();
      await phase('rapid-b');
      await expectTarget('a');
      await row('a').click();
      await phase('rapid-a');
      await page.evaluate(() => window.sessionShellFixture.resume());
      await ready('a');
      await phase('rapid-ready');
      const selections = await page.evaluate(
        () =>
          window.sessionShellFixture.requests.filter((input) => input.method === 'select').length,
      );
      await tasks();
      await row('a').click();
      await ready('a');
      await phase('same-session');
      assert.equal(
        await page.evaluate(
          () =>
            window.sessionShellFixture.requests.filter((input) => input.method === 'select').length,
        ),
        selections + 1,
      );
      await tasks();
      await expectTarget('b');
      await page.evaluate(() =>
        window.sessionShellFixture.modelFailure('b', 'catalogue_network_failed'),
      );
      await row('b').click();
      await page.getByText('模型目录不可用：catalogue_network_failed', { exact: true }).waitFor();
      await phase('genuine-failure');
      assert.equal(await page.locator('.composer-actions button').isDisabled(), true);
      await page.evaluate(() => window.sessionShellFixture.modelFailure('b'));
      await tasks();
      await row('b').click();
      await ready('b');
      await phase('recovered');
      await expectTarget(undefined);
      await row('a').click();
      await ready('a');
      await phase('final');
      assert.equal(await readDraft(), draftA);
      const frames = (await page.evaluate(
        () => Reflect.get(window, 'modelNavigationObservation').frames,
      )) as {
        phase: string;
        expected?: string;
        title?: string;
        model?: string;
        effort?: string;
        modelLeft?: number;
        attachment: boolean;
        permission?: string;
        draft?: string;
        composerVisible: boolean;
        composerTop?: number;
        presentationPending: boolean;
        paintedControls: number;
        scrollTop?: number;
        alerts: string[];
        messages: string[];
        welcome: boolean;
      }[];
      assert.ok(frames.length > 60);
      for (const frame of frames) {
        assert.equal(
          frame.alerts.some((alert) => alert.includes('native_request_failed')),
          false,
        );
        assert.equal(new Set(frame.messages).size, frame.messages.length);
        assert.equal(frame.welcome, false);
        if (frame.presentationPending)
          assert.equal(frame.paintedControls, 0, `${theme}/${frame.phase}: no hidden leaf paint`);
        if (frame.expected) {
          assert.equal(
            frame.composerVisible,
            frame.messages.length > 0,
            `${theme}/${frame.phase}: message and composer visibility`,
          );
        }
        const displayed =
          frame.title === 'Session A' ? 'a' : frame.title === 'Session B' ? 'b' : undefined;
        if (displayed && frame.composerVisible) {
          assert.equal(frame.attachment, true, `${theme}/${frame.phase}: attachment control`);
          assert.ok(
            Math.abs(frame.modelLeft! - originalModelLeft) < 1,
            `${theme}/${frame.phase}: stable model control position`,
          );
          assert.ok(
            frame.alerts.some((alert) => alert.includes('catalogue_network_failed')) ||
              (unselected
                ? frame.model === '选择模型'
                : frame.model?.includes(`Model ${displayed.toUpperCase()}`)),
            `${theme}/${frame.phase}: ${frame.model}`,
          );
          if (withoutPermissions)
            assert.equal(
              frame.permission,
              undefined,
              `${theme}/${frame.phase}: no synthetic permission label`,
            );
          else
            assert.ok(
              frame.permission?.includes(displayed === 'a' ? '自动审核' : '完全访问'),
              `${theme}/${frame.phase}: ${frame.permission}`,
            );
          assert.equal(frame.draft, displayed === 'a' ? draftA : 'Draft B');
          assert.ok(
            frame.messages.every((id) => id === `u-${displayed}` || id === `m-${displayed}`),
            `${theme}/${frame.phase}: own Session messages`,
          );
          if (!frame.alerts.some((alert) => alert.includes('catalogue_network_failed')))
            assert.equal(
              frame.effort,
              unselected ? undefined : displayed === 'a' ? '高' : '轻度',
              `${theme}/${frame.phase}: own reasoning effort`,
            );
          if (displayed === 'a') {
            assert.ok(
              Math.abs(frame.composerTop! - originalComposerTop) < 1,
              `${theme}/${frame.phase}: stable multiline composer height`,
            );
            assert.ok(
              Math.abs(frame.scrollTop! - originalScroll) < 2,
              `${theme}/${frame.phase}: restored reading position`,
            );
          }
        }
      }
      assert.deepEqual(errors, []);
      assert.equal(
        await page.locator('[role="alert"]').filter({ hasText: '模型目录不可用' }).count(),
        0,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.sessionShellFixture.requests.filter((input) =>
            [
              'caller.prepare',
              'caller.submit',
              'input.prepare',
              'input.submit',
              'submit',
              'conversation.send',
              'scheduled.runNow',
              'scheduled.save',
            ].includes(input.method),
          ),
        ),
        [],
      );
      cases.push({
        kind: 'model-navigation',
        unselected,
        withoutPermissions,
        theme,
        phases,
        frames,
        errors,
        originalScroll,
        originalModelLeft,
        originalComposerTop,
      });
    } finally {
      await page.close();
    }
  }
  return cases;
}

/** Exercises the real Native navigation branch, including its delayed reads, without a Service. */
export async function verifyWorktreeNavigation(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      colorScheme: theme,
      locale: 'zh-CN',
    });
    page.setDefaultTimeout(10000);
    const errors: string[] = [],
      phases: unknown[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${url}?worktree-navigation=1`);
      const row = (id: string) =>
        page.getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true });
      const ready = (id: string) =>
        page.waitForFunction(
          (id) =>
            document.querySelector('.breadcrumb strong')?.textContent ===
              `Session ${id.toUpperCase()}` &&
            !document.querySelector('.composer')?.hasAttribute('data-session-loading'),
          id,
        );
      const phase = async (name: string) => {
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const snapshot = await page.evaluate(() => {
          const editor = document.querySelector<HTMLElement>('.composer [role="textbox"]');
          const messages = [...document.querySelectorAll<HTMLElement>('article.message')]
            .filter((node) => node.getBoundingClientRect().height > 0)
            .map((node) => ({ id: node.dataset.messageId, text: node.textContent }));
          const exit = document.querySelector<HTMLButtonElement>(
            '.session-header [aria-label="退出工作树"]',
          );
          const model = document.querySelector<HTMLButtonElement>('[data-model-trigger]');
          return {
            title: document.querySelector('.breadcrumb strong')?.textContent,
            editor: editor?.innerText,
            editorState: editor
              ? {
                  editable: editor.isContentEditable,
                  color: getComputedStyle(editor).color,
                  opacity: getComputedStyle(editor).opacity,
                }
              : null,
            modelState: model
              ? {
                  disabled: model.disabled,
                  color: getComputedStyle(model).color,
                  opacity: getComputedStyle(model).opacity,
                }
              : null,
            editorRect: editor
              ? {
                  x: editor.getBoundingClientRect().x,
                  y: editor.getBoundingClientRect().y,
                  width: editor.getBoundingClientRect().width,
                  height: editor.getBoundingClientRect().height,
                }
              : null,
            messages,
            notice: document.querySelector('[aria-label="工作树导航"]')?.textContent ?? null,
            missing: !!document.querySelector('[aria-label="工作区目录不可用"]'),
            exit: exit ? { disabled: exit.disabled, title: exit.title } : null,
            scrollTop:
              [...document.querySelectorAll<HTMLElement>('.conversation-viewport')].find(
                (node) => node.getBoundingClientRect().height > 0,
              )?.scrollTop ?? null,
          };
        });
        assert.equal(
          new Set(snapshot.messages.map((message) => message.id)).size,
          snapshot.messages.length,
        );
        const screenshot = path.join(artifact, `worktree-navigation-${theme}-${name}.png`);
        await page.screenshot({ path: screenshot });
        phases.push({ name, screenshot, ...snapshot });
        return snapshot;
      };
      await row('a').click();
      await ready('a');
      const source = await phase('01-source');
      assert.equal(source.title, 'Session A');
      assert.equal(source.editor, 'Draft A');
      await page.evaluate(() => {
        const observation = {
          active: true,
          frames: [] as {
            title: string | null;
            messages: string[];
            welcome: boolean;
          }[],
        };
        Object.assign(window, { worktreeNavigationObservation: observation });
        const tick = () => {
          if (!observation.active) return;
          observation.frames.push({
            title: document.querySelector('.breadcrumb strong')?.textContent ?? null,
            messages: [...document.querySelectorAll<HTMLElement>('article.message')]
              .filter((node) => node.getBoundingClientRect().height > 0)
              .map((node) => node.dataset.messageId ?? ''),
            welcome: !!document.querySelector('.new-conversation-welcome'),
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await row('b').click();
      await ready('b');
      const editor = page.locator('.composer [role="textbox"]');
      await editor.fill('工作树草稿：保留阅读与输入位置');
      const target = await phase('02-worktree-draft');
      assert.equal(target.editor, '工作树草稿：保留阅读与输入位置');
      await page.evaluate(() => window.sessionShellFixture.holdNavigationDirectory());
      await page.getByRole('button', { name: '退出工作树', exact: true }).click();
      await page.waitForFunction(() => window.sessionShellFixture.navigationDirectoryHeld());
      const latestDraft = '目录读取期间继续编辑的最新工作树草稿';
      await editor.fill(latestDraft);
      const pending = await phase('03-directory-pending');
      assert.equal(pending.title, target.title);
      assert.equal(pending.editor, latestDraft);
      assert.equal(pending.editorState?.editable, true);
      assert.deepEqual(pending.editorState, target.editorState);
      assert.deepEqual(pending.modelState, target.modelState);
      assert.deepEqual(pending.editorRect, target.editorRect);
      assert.deepEqual(pending.messages, target.messages);
      assert.equal(pending.scrollTop, target.scrollTop);
      await page.evaluate(() => {
        window.sessionShellFixture.hold();
        window.sessionShellFixture.releaseNavigationDirectory();
      });
      await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
      await phase('04-selection-pending');
      await page.evaluate(() => window.sessionShellFixture.release('selection'));
      await page.waitForFunction(() => window.sessionShellFixture.pending('history') > 0);
      const loading = await phase('05-source-history-pending');
      assert.ok(loading.messages.every((message) => !['u-b', 'm-b'].includes(message.id ?? '')));
      await page.evaluate(() => window.sessionShellFixture.resume());
      await ready('a');
      await page.getByRole('status', { name: '工作树导航' }).waitFor();
      const returned = await phase('06-returned-source');
      assert.equal(returned.editor, 'Draft A');
      assert.match(returned.notice ?? '', /已返回来源会话/);
      assert.deepEqual(returned.messages, source.messages);
      await row('b').click();
      await ready('b');
      const restored = await phase('07-restored-worktree-draft');
      assert.equal(restored.editor, latestDraft);
      await page.evaluate(() => {
        window.sessionShellFixture.unavailableWorkspace('b', true);
        window.sessionShellFixture.unavailableWorkspace('a', true);
      });
      await page.getByRole('status', { name: '工作区目录不可用' }).waitFor();
      await phase('08-missing-worktree');
      await editor.fill('退出工作树');
      await page.locator('.composer [aria-label="退出工作树"]').click();
      await ready('a');
      const missing = await phase('09-returned-missing-source');
      assert.equal(missing.missing, true);
      assert.equal(missing.editor, 'Draft A');
      assert.match(missing.notice ?? '', /已返回来源会话/);
      await page.evaluate(() => {
        window.sessionShellFixture.unavailableWorkspace('a', false);
        window.sessionShellFixture.unavailableWorkspace('b', false);
      });
      await row('b').click();
      await ready('b');
      await page.evaluate(() => window.sessionShellFixture.navigationSource(false));
      await page.locator('.session-header [aria-label="退出工作树"]').click();
      await page.waitForFunction(() =>
        document.querySelector('[aria-label="工作树导航"]')?.textContent?.includes('无法核实'),
      );
      const unknown = await phase('10-source-unavailable');
      assert.equal(unknown.title, 'Session B');
      assert.equal(unknown.editor, '退出工作树');
      await page.evaluate(() => {
        window.sessionShellFixture.navigationSource(true);
        window.sessionShellFixture.publish();
      });
      await page.locator('.session-header [aria-label="退出工作树"]').waitFor();
      await page.evaluate(() => window.sessionShellFixture.holdNavigationDirectory());
      await page.locator('.session-header [aria-label="退出工作树"]').click();
      await page.waitForFunction(() => window.sessionShellFixture.navigationDirectoryHeld());
      await row('a').click();
      await ready('a');
      const beforeRelease = await phase('11-explicit-selection-during-read');
      await page.evaluate(() => window.sessionShellFixture.releaseNavigationDirectory());
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const final = await phase('12-stale-response-ignored');
      assert.equal(final.title, beforeRelease.title);
      assert.equal(final.editor, beforeRelease.editor);
      assert.deepEqual(final.messages, beforeRelease.messages);
      assert.equal(final.notice, null);
      const frames = await page.evaluate(() => {
        const observation = (
          window as unknown as {
            worktreeNavigationObservation: {
              active: boolean;
              frames: { title: string | null; messages: string[]; welcome: boolean }[];
            };
          }
        ).worktreeNavigationObservation;
        observation.active = false;
        return observation.frames;
      });
      assert.ok(frames.length > 10);
      for (const frame of frames) {
        assert.equal(frame.welcome, false);
        assert.equal(new Set(frame.messages).size, frame.messages.length);
        if (frame.title === 'Session A')
          assert.ok(frame.messages.every((id) => !['u-b', 'm-b'].includes(id)));
        if (frame.title === 'Session B')
          assert.ok(frame.messages.every((id) => !['u-a', 'm-a'].includes(id)));
      }
      const requests = await page.evaluate(() =>
        window.sessionShellFixture.requests.map((request) => request.method),
      );
      assert.deepEqual(
        requests.filter((method) =>
          /^(caller\.|submit$|conversation\.send$|extensions\.invoke$|workspace\.remove$|permission\.|fileRecovery\.)/.test(
            method,
          ),
        ),
        [],
      );
      assert.deepEqual(errors, []);
      cases.push({ theme, phases, frames, requests, errors });
    } finally {
      await page.close();
    }
  }
  return cases;
}

/** Full Native projection and production CSS, fed only by the isolated fixture's directory. */
export async function verifyWorktreeIndicator(browser: Browser, url: string, artifact: string) {
  const cases = [];
  for (const theme of ['light', 'dark'] as const) {
    for (const navigationWidth of [200, 300]) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        colorScheme: theme,
        locale: 'zh-CN',
      });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      const phases: unknown[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.addInitScript((width) => {
          localStorage.setItem('kite.client.navigationWidth', String(width));
        }, navigationWidth);
        await page.goto(`${url}?worktree-indicator=1`);
        const row = (id: string) =>
          page.getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true });
        const ready = (id: string) =>
          page.waitForFunction(
            (id) =>
              document.querySelector('.breadcrumb strong')?.textContent ===
                `Session ${id.toUpperCase()}` &&
              !document.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled &&
              !document.querySelector('.composer')?.hasAttribute('data-session-loading'),
            id,
          );
        const phase = async (name: string) => {
          await page.evaluate(() => new Promise(requestAnimationFrame));
          const snapshot = await page.evaluate(() => {
            const rect = (element: Element | null) => {
              if (!element) return null;
              const box = element.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            };
            return {
              selected: document.querySelector('.breadcrumb strong')?.textContent,
              input: rect(document.querySelector('.composer [role="textbox"]')),
              rows: ['a', 'b'].map((id) => {
                const node = document.querySelector(`[aria-label="Session ${id.toUpperCase()}"]`);
                const icon = node?.querySelector('.session-worktree-icon') ?? null;
                return {
                  id,
                  text: node?.textContent,
                  description: node?.getAttribute('aria-description'),
                  row: rect(node),
                  title: rect(node?.querySelector('.nav-copy') ?? null),
                  icon: rect(icon),
                  spinner: !!node?.querySelector('[aria-label="会话运行中"]'),
                  awaiting: node?.textContent?.includes('待用户输入') ?? false,
                  unread: !!node?.querySelector('.session-unread-dot'),
                };
              }),
              messages: [...document.querySelectorAll<HTMLElement>('article.message')]
                .filter((node) => node.getBoundingClientRect().height > 0)
                .map((node) => ({ id: node.dataset.messageId, text: node.textContent })),
              scrollTop:
                [...document.querySelectorAll<HTMLElement>('.conversation-viewport')].find(
                  (node) => node.getBoundingClientRect().height > 0,
                )?.scrollTop ?? null,
            };
          });
          for (const entry of snapshot.rows) {
            if (!entry.icon) continue;
            assert.equal(entry.icon.width, 14);
            assert.equal(entry.icon.height, 14);
            assert.ok(entry.row && entry.title);
            assert.ok(entry.icon.x >= entry.title.x + entry.title.width - 0.1);
            assert.ok(entry.icon.x + entry.icon.width <= entry.row.x + entry.row.width);
          }
          const screenshot = path.join(
            artifact,
            `worktree-${theme}-${navigationWidth}-${name}.png`,
          );
          await page.screenshot({ path: screenshot });
          phases.push({ name, screenshot, ...snapshot });
          return snapshot;
        };
        await row('a').click();
        await ready('a');
        const before = await phase('01-before-create');
        assert.ok(before.rows.every((entry) => !entry.icon));
        assert.notEqual(before.scrollTop, null);
        assert.equal(before.messages.filter((message) => message.id === 'u-a').length, 1);
        await page.evaluate(() => window.sessionShellFixture.createdWorktree('a'));
        await row('a').locator('.session-worktree-icon').waitFor();
        const running = await phase('02-created-running');
        assert.equal(running.rows[0]!.spinner, true);
        assert.equal(running.rows[1]!.icon, null);
        assert.deepEqual(running.input, before.input);
        assert.deepEqual(running.messages, before.messages);
        assert.equal(running.scrollTop, before.scrollTop);
        await page.evaluate(() => {
          const a = document.querySelector('[aria-label="Session A"]')!;
          const icon = a.querySelector('.session-worktree-icon')!;
          Object.assign(window, {
            worktreeIconObservation: { node: icon, changed: 0, frames: 0, active: true },
          });
          const tick = () => {
            const state = (
              window as unknown as {
                worktreeIconObservation: {
                  node: Element;
                  changed: number;
                  frames: number;
                  active: boolean;
                };
              }
            ).worktreeIconObservation;
            if (!state.active) return;
            state.frames++;
            if (
              document.querySelector('[aria-label="Session A"] .session-worktree-icon') !==
              state.node
            )
              state.changed++;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.evaluate(() => window.sessionShellFixture.setPendingInteractions('a', 1));
        await row('a').getByText('待用户输入').waitFor();
        const awaiting = await phase('03-awaiting-input');
        assert.equal(awaiting.rows[0]!.awaiting, true);
        assert.ok(awaiting.rows[0]!.icon);
        assert.deepEqual(awaiting.messages, before.messages);
        assert.equal(awaiting.scrollTop, before.scrollTop);
        await page.evaluate(() => window.sessionShellFixture.setPendingInteractions('a', 0));
        await row('b').click();
        await ready('b');
        await phase('04-switched-b');
        await page.evaluate(() => window.sessionShellFixture.setTurn('a', 'completed'));
        await row('a').locator('.session-unread-dot').waitFor();
        const completed = await phase('05-completed-unread');
        assert.equal(completed.rows[0]!.spinner, false);
        assert.equal(completed.rows[0]!.unread, true);
        assert.ok(completed.rows[0]!.icon);
        await page.evaluate(() => window.sessionShellFixture.refresh(true));
        await phase('06-refreshing');
        await page.evaluate(() => window.sessionShellFixture.refresh(false));
        await ready('b');
        await phase('07-refreshed');
        await row('a').click();
        await ready('a');
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Session A"] .session-unread-dot'),
        );
        await phase('08-returned-read');
        await page.mouse.move(1000, 600);
        await row('a').hover();
        await page.getByRole('tooltip').filter({ hasText: '已创建 Git 工作树' }).waitFor();
        await phase('09-tooltip');
        const observation = await page.evaluate(() => {
          const state = (
            window as unknown as {
              worktreeIconObservation: { changed: number; frames: number; active: boolean };
            }
          ).worktreeIconObservation;
          state.active = false;
          return { changed: state.changed, frames: state.frames };
        });
        assert.equal(observation.changed, 0);
        assert.ok(observation.frames > 0);
        await page.evaluate(() => window.remountSessionShellFixture());
        await ready('a');
        await row('a').locator('.session-worktree-icon').waitFor();
        const remounted = await phase('10-remounted');
        assert.equal(remounted.rows[1]!.icon, null);
        const requests = await page.evaluate(() =>
          window.sessionShellFixture.requests.map((request) => request.method),
        );
        assert.deepEqual(
          requests.filter((method) => /^(caller\.|submit$|input\.submit$)/.test(method)),
          [],
        );
        assert.deepEqual(errors, []);
        cases.push({ theme, navigationWidth, phases, observation, errors });
      } finally {
        await page.close();
      }
    }
  }
  return cases;
}

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
      assert.equal(states[2]!.controls[0]!.opacity, states[0]!.controls[0]!.opacity);
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
  ring: number[] | null;
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
            const state = {
              active: true,
              phase: 'original',
              frames: [] as ToolbarGeometry[],
              read: (): ToolbarGeometry => {
                const rect = (selector: string) => {
                  const value = document.querySelector(selector)?.getBoundingClientRect();
                  return value ? [value.x, value.y, value.width, value.height] : null;
                };
                return {
                  phase: state.phase,
                  model: document.querySelector('[data-model-trigger]')?.textContent ?? null,
                  composer: rect('.composer')!,
                  metrics: rect('.composer-metrics')!,
                  action: rect('.composer-actions')!,
                  ring: rect('.composer-context-usage'),
                  same:
                    document.querySelector('.composer-metrics') === metrics &&
                    document.querySelector('.composer-actions') === action &&
                    document.querySelector('.composer-context-usage') === ring,
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
          assert.equal(await page.locator('.composer-cache-rate').count(), 0);
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
            assert.equal(await page.locator('.composer-cache-rate').count(), 0);
          }
          await page.evaluate(() => window.sessionShellFixture.resume());
          await page.waitForFunction(
            () =>
              document.querySelector('[data-model-trigger]')?.textContent?.includes('Model B') &&
              !document.querySelector('.composer-metrics[aria-busy="true"]'),
          );
          await phase('settled');
          const settled = await read();
          assert.equal(await page.locator('.composer-cache-rate').count(), 0);
          if (mode === 'cache' || mode === 'both')
            assert(
              (
                await page.locator('.composer-context-usage').getAttribute('aria-description')
              )?.includes('缓存命中率 30%'),
            );
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
          }
          assert.deepEqual(errors, []);
          const layout = await page.evaluate(() => {
            const permission = document.querySelector('[data-permission-trigger]')!;
            const model = document.querySelector('[data-model-trigger]')!;
            const ring = document.querySelector('.composer-context-usage')!;
            const input = document.querySelector<HTMLTextAreaElement>('.prompt-editor')!;
            const bounds = (node: Element) => {
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
            };
            return {
              permission: bounds(permission),
              model: bounds(model),
              ring: bounds(ring),
              permissionIcons: permission.querySelectorAll('svg').length,
              placeholder: input.placeholder,
              sizes: [
                ...document.querySelectorAll('.typeset-chat, .tool-activity, .response-status'),
              ].map((node) => getComputedStyle(node).fontSize),
              padding: {
                composer: getComputedStyle(document.querySelector('.composer')!).paddingTop,
                editor: getComputedStyle(input).paddingTop,
                shell: getComputedStyle(input.parentElement!).marginLeft,
              },
            };
          });
          assert(layout.model.x > layout.permission.x, 'permission stays on the left');
          assert(layout.model.right <= layout.ring.x, 'model precedes context');
          assert(Math.abs(layout.model.y - layout.ring.y) < 12, 'model and context share a row');
          assert.equal(layout.permissionIcons, 1);
          assert.equal(layout.placeholder, '输入新的想法');
          assert(layout.sizes.length > 0 && layout.sizes.every((size) => size === '14px'));
          assert.deepEqual(layout.padding, { composer: '8px', editor: '0px', shell: '0px' });
          await page.locator('.composer-context-usage').focus();
          const tooltip = page.getByRole('tooltip');
          await tooltip.waitFor();
          const detail = await tooltip.textContent();
          assert(detail?.includes('上下文占用'));
          assert(!detail?.includes('NaN') && !detail?.includes('undefined'));
          if (mode === 'cache' || mode === 'none')
            assert(detail?.includes('估算 未知 / 总量 未知'));
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
            layout,
            frames,
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
