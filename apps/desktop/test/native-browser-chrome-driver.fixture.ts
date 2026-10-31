import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import type { ChromeFixtureSample } from './native-browser-chrome-electron.fixture';

/** No launch/attach here: the owning acceptance shell controls inventory, OS recording and exit. */
export async function runActor(
  electron: ElectronApplication,
  artifactDirectory: string,
  options: {
    mode?: 'minimum' | 'resize';
    url?: string;
    widths?: readonly number[];
    steps?: number;
    periodMs?: number;
    overlays?: boolean;
  } = {},
) {
  if (!isAbsolute(artifactDirectory)) throw Error('fixture_artifacts_must_be_absolute');
  await mkdir(artifactDirectory, { recursive: true });
  const identity = await electron.evaluate(() => {
    const fixture = globalThis.browserChromeHostFixture;
    return {
      rootId: fixture.window.webContents.id,
      origin: fixture.origin,
      visible: fixture.window.isVisible(),
    };
  });
  assert.equal(
    identity.visible,
    true,
    'owner must show the exact fixture window before starting its recording/actor',
  );
  let root: Page | undefined;
  const deadline = Date.now() + 10000;
  while (!root && Date.now() < deadline) {
    for (const page of electron.context().pages()) {
      if (page.url() !== `${identity.origin}/`) continue;
      if (
        await page
          .evaluate(
            () => !!window.browserChromeFixture && !!window.kiteNative && !window.kiteBrowserChrome,
          )
          .catch(() => false)
      ) {
        root = page;
        break;
      }
    }
    if (!root) await new Promise((done) => setTimeout(done, 30));
  }
  assert.ok(root, `verified Root page unavailable for contents ${identity.rootId}`);
  root.setDefaultTimeout(8000);
  const samples: { label: string; value: ChromeFixtureSample }[] = [];
  const readingEvidence: {
    label: string;
    marker: string;
    baselineScrollY: number;
    scrollY: number;
    scrollDelta: number;
    baselineTop: number;
    top: number;
    topDelta: number;
    documentTopDelta: number;
    headerHeightDelta: number | null;
  }[] = [];
  const sample = async (label: string) => {
    const value = await electron.evaluate(() => globalThis.browserChromeHostFixture.sample());
    assert.equal(value.window.rootId, identity.rootId);
    samples.push({ label, value });
    return value;
  };
  const waitHosted = async (label: string) => {
    const measured = (value: ChromeFixtureSample) =>
      !!value.root &&
      Math.abs(value.root.width - value.window.size[0]! / value.window.zoom) <= 2 &&
      Math.abs(value.root.height - value.window.size[1]! / value.window.zoom) <= 2;
    const until = Date.now() + 8000;
    let value = await sample(label);
    while (
      (!value.envelope?.actionable ||
        !value.envelope.snapshot.hosted ||
        !measured(value) ||
        !value.views.some(
          (view) => view.role === 'page' && view.visible && view.bounds.width > 0,
        )) &&
      Date.now() < until
    ) {
      await new Promise((done) => setTimeout(done, 40));
      value = await sample(`${label}:waiting`);
    }
    assert.ok(
      value.envelope?.actionable && value.envelope.snapshot.hosted,
      `${label}: hosted never became actionable`,
    );
    assert.ok(
      measured(value),
      `${label}: Root CSS viewport mismatch ${JSON.stringify({ size: value.window.size, actualRootZoom: value.window.zoom, root: value.root })}`,
    );
    return value;
  };
  const path = join(artifactDirectory, `chrome-actor-${Date.now()}.json`);
  let failure: string | undefined;
  try {
    const target = options.url ?? `${identity.origin}/form`;
    const parsed = new URL(target);
    assert.ok(
      ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
    );
    // This is an explicitly authorized fixture page creation through ordinary
    // UI; it does not pre-open or arm any page for a model task.
    await root.getByRole('button', { name: '标签页', exact: true }).click();
    const address = root.getByRole('textbox', { name: '搜索或输入网址' });
    await address.fill(target);
    await address.press('Enter');
    await waitHosted('navigation');
    const controlled = target === `${identity.origin}/form`;
    if (controlled)
      await electron.evaluate(() =>
        globalThis.browserChromeHostFixture.seed('RETAINED-NATIVE-CHROME', 850),
      );
    const baseline = await sample('baseline');
    assert.equal(baseline.views.filter((view) => view.role === 'page').length, 1);
    assert.ok(
      baseline.binding?.contentsId && baseline.binding.incarnation,
      'exact single-page identity is required',
    );
    const original = baseline.pages.find((page) => page.id === baseline.binding!.contentsId)!;
    const anchor = controlled
      ? original.reading.markers.find(
          (marker) =>
            marker.top >= Math.max(0, original.reading.header?.bottom ?? 0) &&
            marker.bottom <= original.reading.viewport.height,
        )
      : undefined;
    if (controlled) assert.ok(anchor, 'baseline requires an unobscured visible reading marker');
    const retained = (value: ChromeFixtureSample) => {
      assert.equal(value.binding?.pageId, baseline.binding!.pageId);
      assert.equal(value.binding?.contentsId, baseline.binding!.contentsId);
      assert.equal(value.binding?.incarnation, baseline.binding!.incarnation);
      assert.equal(value.binding?.navigation, baseline.binding!.navigation);
      const page = value.pages.find((page) => page.id === original.id)!;
      assert.equal(page.timeOrigin, original.timeOrigin);
      assert.equal(page.documentId, original.documentId);
      if (controlled) {
        assert.equal(page.input, original.input);
        assert.equal(page.selected, original.selected);
        assert.equal(page.checked, original.checked);
        const matches = page.reading.markers.filter((marker) => marker.id === anchor!.id);
        assert.equal(matches.length, 1, 'the original reading marker must remain unique');
        const marker = matches[0]!;
        const evidence = {
          label: samples.at(-1)!.label,
          marker: marker.id,
          baselineScrollY: original.scrollY,
          scrollY: page.scrollY,
          scrollDelta: page.scrollY - original.scrollY,
          baselineTop: anchor!.top,
          top: marker.top,
          topDelta: marker.top - anchor!.top,
          documentTopDelta: marker.top + page.scrollY - anchor!.top - original.scrollY,
          headerHeightDelta:
            page.reading.header && original.reading.header
              ? page.reading.header.height - original.reading.header.height
              : null,
        };
        readingEvidence.push(evidence);
        assert.equal(marker.text, anchor!.text);
        assert.equal(marker.height, anchor!.height);
        // A changed scroll offset is only accepted with the same paragraph at
        // the same viewport anchor, allowing one CSS pixel of layout rounding.
        // It is never accepted merely because the scroll delta is small.
        assert.ok(
          Math.abs(evidence.topDelta) <= 1,
          `reading anchor moved: ${JSON.stringify(evidence)}`,
        );
        assert.ok(
          marker.bottom > Math.max(0, page.reading.header?.bottom ?? 0) &&
            marker.top < page.reading.viewport.height,
          'the original reading anchor must remain visible',
        );
      }
      const main = value.views.find((view) => view.role === 'root')!,
        chrome = value.views.find((view) => view.role === 'chrome')!,
        guest = value.views.find((view) => view.id === original.id)!;
      assert.ok(main.visible && chrome.visible && guest.visible);
      assert.equal(main.zoom, value.window.zoom);
      assert.equal(main.bounds.x, 0);
      assert.equal(main.bounds.width, chrome.bounds.x);
      assert.equal(guest.bounds.x, chrome.bounds.x);
      assert.ok(Math.abs(guest.bounds.y - chrome.bounds.height) <= 1);
      for (const view of [main, chrome, guest]) {
        assert.ok(view.bounds.width > 0 && view.bounds.height > 0);
        assert.ok(view.bounds.x >= 0 && view.bounds.y >= 0);
        assert.ok(view.bounds.x + view.bounds.width <= value.window.size[0]! + 1);
        assert.ok(view.bounds.y + view.bounds.height <= value.window.size[1]! + 1);
      }
    };
    retained(baseline);
    const qualification = {
      path,
      rootContentsId: identity.rootId,
      mediaId: baseline.window.mediaId,
      controlled,
      identityQualification: 'single-page-fixture',
      modelCalls: 0,
      visualQualification: false,
    };
    if (options.mode !== 'resize') return { ...qualification, mode: 'minimum' };
    const initialWidth = baseline.window.size[0]!;
    const small = Math.max(640, Math.min(820, initialWidth - 64));
    const steps = options.steps ?? 16,
      periodMs = options.periodMs ?? 16;
    assert.ok(
      Number.isInteger(steps) && steps >= 1 && steps <= 64 && periodMs >= 8 && periodMs <= 100,
    );
    for (const zoom of [1, 1.25]) {
      await electron.evaluate((_api, zoom) => globalThis.browserChromeHostFixture.zoom(zoom), zoom);
      retained(await waitHosted(`zoom-${zoom}`));
      const widths =
        options.widths ??
        (zoom === 1
          ? [initialWidth, small, initialWidth, small, initialWidth, small, initialWidth]
          : [initialWidth, small, initialWidth]);
      assert.ok(
        widths.every((width) => Number.isInteger(width) && width >= 640 && width <= initialWidth),
        'resize must stay within the initial OS recording canvas',
      );
      for (const width of widths) {
        await electron.evaluate(
          async (_api, input) => {
            const fixture = globalThis.browserChromeHostFixture;
            const [before = input.width, height = 768] = fixture.window.getContentSize();
            for (let step = 1; step <= input.steps; step++) {
              fixture.resize(
                Math.round(before + ((input.width - before) * step) / input.steps),
                height,
              );
              await new Promise((done) => setTimeout(done, input.periodMs));
            }
          },
          { width, steps, periodMs },
        );
        retained(await waitHosted(`resize-${zoom}-${width}`));
      }
    }
    if (options.overlays !== false) {
      await root.evaluate(() => window.browserChromeFixture!.setCovered(true));
      await root.getByRole('dialog').waitFor();
      const until = Date.now() + 5000;
      let covered = await sample('covered');
      while (
        covered.views.some((view) => view.role === 'chrome' && view.visible) &&
        Date.now() < until
      ) {
        await new Promise((done) => setTimeout(done, 30));
        covered = await sample('covered:waiting');
      }
      assert.equal(
        covered.views.find((view) => view.role === 'root')!.bounds.width,
        covered.window.size[0],
      );
      assert.equal(
        covered.views.some((view) => view.role === 'chrome' && view.visible),
        false,
      );
      await root.evaluate(() => window.browserChromeFixture!.setCovered(false));
      retained(await waitHosted('uncovered'));
    }
    return { ...qualification, mode: 'resize' };
  } catch (cause) {
    failure = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    throw cause;
  } finally {
    let geometry: unknown;
    try {
      geometry = await electron.evaluate(() => globalThis.browserChromeHostFixture.geometry());
    } catch (cause) {
      geometry = { unavailable: String(cause) };
    }
    await writeFile(
      path,
      JSON.stringify(
        {
          identity,
          samples,
          readingEvidence,
          readingPositionCheck: 'same-visible-marker-top',
          geometry,
          failure,
          modelCalls: 0,
          visualQualification: false,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  }
}

/** Releases fixture-owned browser/Chrome/shield resources; the shell then quits and verifies the exact process. */
export async function prepareFixtureQuit(electron: ElectronApplication, artifactDirectory: string) {
  const result = await electron.evaluate(() => globalThis.browserChromeHostFixture.prepareQuit());
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, `chrome-cleanup-${Date.now()}.json`),
    JSON.stringify(result, null, 2),
    { flag: 'wx' },
  );
  return result;
}
