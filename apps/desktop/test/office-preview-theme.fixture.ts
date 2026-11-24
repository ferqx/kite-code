import assert from 'node:assert/strict';
import { nativeTheme, type WebFrameMain, webContents } from 'electron';

/** Use Main's production theme mechanism on an already opened, visible iframe. */
export async function verifyOfficePreviewTheme(
  frame: WebFrameMain,
  scrollers: readonly { selector: string; axis?: 'horizontal' | 'vertical' }[],
  chrome: string,
  page: string,
  captureDark?: () => Promise<void>,
) {
  type Sample = {
    dark: boolean;
    chrome: string;
    page: [string, string | null];
    scrollbars: {
      thumb: number[];
      track: string;
      corner: string;
      width: string;
      height: string;
      horizontal: number;
      vertical: number;
      top: number;
      left: number;
    }[];
  };
  const selectors = scrollers.map(({ selector }) => selector);
  const sample = () =>
    frame.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const color = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const page = getComputedStyle(document.querySelector(${JSON.stringify(page)}));
    return {
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      chrome: getComputedStyle(document.querySelector(${JSON.stringify(chrome)})).backgroundColor,
      page: [page.backgroundColor, page.colorScheme === 'light' ? page.color : null],
      scrollbars: ${JSON.stringify(selectors)}.map(selector => {
        const element = document.querySelector(selector);
        const bar = getComputedStyle(element, '::-webkit-scrollbar');
        return {
          thumb: color(getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor),
          track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
          corner: getComputedStyle(element, '::-webkit-scrollbar-corner').backgroundColor,
          width: bar.width, height: bar.height,
          horizontal: element.scrollWidth - element.clientWidth,
          vertical: element.scrollHeight - element.clientHeight,
          top: element.scrollTop, left: element.scrollLeft,
        };
      }),
    };
  })()`) as Promise<Sample>;
  const host = frame.parent!;
  await webContents.fromFrame(host)?.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 0,
    y: 0,
  });
  const previousHost = await host.executeJavaScript(`(() => {
    const root = document.documentElement;
    return [root.getAttribute('data-theme'), root.style.colorScheme];
  })()`);
  const setTheme = async (theme: 'light' | 'dark') => {
    await host.executeJavaScript(`(() => {
      const root = document.documentElement;
      root.dataset.theme = root.style.colorScheme = ${JSON.stringify(theme)};
    })()`);
    nativeTheme.themeSource = theme;
    for (let attempt = 0; attempt < 50; attempt++) {
      const observed = await sample();
      if (observed.dark === (theme === 'dark')) return observed;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw Error('iframe_theme_not_applied');
  };
  const previousTheme = nativeTheme.themeSource;
  const original = await sample();
  try {
    const initial = await setTheme('light');
    assert.equal(initial.chrome, 'rgb(250, 250, 250)');
    for (const [index, { axis }] of scrollers.entries()) {
      if (!axis) continue;
      assert.ok(initial.scrollbars[index]![axis] > 0, scrollers[index]!.selector);
      const edge = axis === 'horizontal' ? 'scrollLeft' : 'scrollTop';
      await frame.executeJavaScript(
        `document.querySelector(${JSON.stringify(selectors[index])}).${edge} = 24`,
      );
    }
    const light = await sample();
    const dark = await setTheme('dark');
    assert.equal(dark.chrome, 'rgb(24, 24, 24)');
    assert.deepEqual(dark.page, light.page);
    for (const [index, bar] of dark.scrollbars.entries()) {
      const { thumb, ...track } = light.scrollbars[index]!;
      const { thumb: darkThumb, ...darkTrack } = bar;
      assert.deepEqual(darkTrack, track);
      assert.equal(track.track, 'rgba(0, 0, 0, 0)');
      assert.equal(track.corner, 'rgba(0, 0, 0, 0)');
      assert.equal(track.width, '10px');
      assert.equal(track.height, '10px');
      assert.ok(thumb[0]! < 80 && darkThumb[0]! > 180);
      assert.ok(
        [thumb[3]!, darkThumb[3]!].every(
          (alpha) => (alpha >= 24 && alpha <= 27) || (alpha >= 44 && alpha <= 48),
        ),
        `${scrollers[index]!.selector} light ${thumb.join(',')} dark ${darkThumb.join(',')}`,
      );
      if (scrollers[index]!.axis === 'vertical') assert.ok(track.top > 0);
      if (scrollers[index]!.axis === 'horizontal') assert.ok(track.left > 0);
    }
    await captureDark?.();
    assert.deepEqual(await setTheme('light'), light);
  } finally {
    nativeTheme.themeSource = previousTheme;
    await host.executeJavaScript(`(() => {
      const root = document.documentElement;
      const [theme, scheme] = ${JSON.stringify(previousHost)};
      if (theme === null) root.removeAttribute('data-theme');
      else root.dataset.theme = theme;
      root.style.colorScheme = scheme;
    })()`);
    await frame.executeJavaScript(`(() => {
      ${JSON.stringify(selectors)}.forEach((selector, index) => {
        const { left, top } = ${JSON.stringify(original.scrollbars)}[index];
        document.querySelector(selector).scrollTo(left, top);
      });
    })()`);
  }
}
