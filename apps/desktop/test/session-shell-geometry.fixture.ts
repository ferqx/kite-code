import assert from 'node:assert/strict';
import path from 'node:path';
import type { Browser } from 'playwright';
import type {} from './session-shell-browser.fixture';

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
