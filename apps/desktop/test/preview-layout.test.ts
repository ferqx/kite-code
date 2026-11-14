import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { NativeOutputPreview } from '../electron/output-preview';
import { assertPanelMeasurement } from '../src/native-content-geometry';
import {
  parseNativePreviewLayout,
  readNativePreviewLayoutReply,
} from '../src/native-preview-layout-bridge';

const bounds = { x: 500, y: 40, width: 500, height: 660, radius: 8 };
const panel = (size: number) => ({
  size,
  min: 0,
  minUnit: 'px' as const,
  max: 100,
  maxUnit: '%' as const,
  preserve: 'relative' as const,
  collapsible: false,
});
const layout = {
  windowWidth: 1000,
  windowHeight: 700,
  groups: [{ left: 0, right: 0, gap: 0, panels: [panel(500), panel(500)] as const }],
  insetLeft: 0,
  insetRight: 0,
};
const request = { previewId: 'view', generation: 2, presentationRevision: 1, bounds, layout };
test('preview layout IPC is geometry-only and preserves browser standalone support', () => {
  expect(parseNativePreviewLayout(request)).toEqual(request);
  expect(parseNativePreviewLayout({ ...request, layout: undefined })).toMatchObject({ bounds });
  expect(
    parseNativePreviewLayout({ ...request, bounds: null, layout: undefined }).bounds,
  ).toBeNull();
  for (const value of [
    { ...request, path: '/private' },
    { ...request, target: {} },
    { ...request, presentationRevision: 0 },
    { ...request, bounds: { ...bounds, width: NaN } },
    { ...request, bounds: null },
    { ...request, layout: { ...layout, groups: [] } },
    { ...request, previewId: '../view' },
  ])
    expect(() => parseNativePreviewLayout(value)).toThrow();
});
test('Main presentation ordering cannot revive a withdrawn view or another generation', () => {
  const source = readFileSync(
    new URL('../electron/output-preview.ts', import.meta.url),
    'utf8',
  ).replace(/^import[\s\S]*?;\r?\n/gm, '');
  const compiled = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^export /gm, '');
  const Class = new Function('assertPanelMeasurement', `${compiled}; return NativeOutputPreview;`)(
    assertPanelMeasurement,
  );
  const preview = new Class() as Pick<NativeOutputPreview, 'present'>;
  let syncs = 0,
    allowed = true,
    shown = true;
  const active = {
    id: 'view',
    generation: 2,
    abort: new AbortController(),
    presentationRevision: 0,
    presentation: undefined as unknown,
    projection: undefined as unknown,
    check: () => {
      if (!allowed) throw Error('scope_revoked');
    },
    layout: {
      sync: () => {
        syncs++;
      },
    },
    window: {
      isVisible: () => shown,
      isMinimized: () => false,
      getContentSize: () => [1000, 700],
      webContents: { getZoomFactor: () => 1 },
    },
  };
  Object.assign(preview, { active });
  preview.present(request);
  expect(active.presentation).toEqual({ bounds, layout });
  preview.present({ ...request, presentationRevision: 3, bounds: null, layout: undefined });
  expect(active.presentation).toBeUndefined();
  expect(() => preview.present({ ...request, presentationRevision: 2 })).toThrow(
    'preview_layout_stale',
  );
  expect(active.presentation).toBeUndefined();
  expect(() => preview.present({ ...request, presentationRevision: 4, generation: 3 })).toThrow(
    'preview_replaced',
  );
  shown = false;
  preview.present({ ...request, presentationRevision: 4 });
  expect(active.presentation).toBeUndefined();
  shown = true;
  preview.present({ ...request, presentationRevision: 5 });
  expect(active.presentation).toBeDefined();
  expect(() =>
    preview.present({
      ...request,
      presentationRevision: 6,
      layout: { ...layout, windowWidth: 9999 },
    }),
  ).toThrow('preview_layout_stale');
  expect(active.presentation).toEqual({ bounds, layout });
  expect(active.presentationRevision).toBe(5);
  allowed = false;
  expect(() => preview.present({ ...request, presentationRevision: 7 })).toThrow('scope_revoked');
  expect(syncs).toBe(4);
  allowed = true;
  Object.assign(active, { presentationError: 'preview_paint_failed' });
  expect(() => preview.present({ ...request, presentationRevision: 8 })).toThrow(
    'preview_paint_failed',
  );
  preview.present({ ...request, presentationRevision: 8, bounds: null, layout: undefined });
  expect(active.presentation).toBeUndefined();
  expect(() => preview.present({ ...request, presentationRevision: 9 })).toThrow(
    'preview_paint_failed',
  );
});

test('preload rejects malformed and wrong-owner presentation acknowledgements', () => {
  const identity = { previewId: 'view', generation: 2 };
  expect(readNativePreviewLayoutReply({ ok: true, value: identity }, identity)).toEqual(identity);
  for (const raw of [
    null,
    {},
    { ok: true },
    { ok: true, value: { ...identity, previewId: 'old' } },
    { ok: true, value: { ...identity, generation: 3 } },
    { ok: true, value: { ...identity, path: '/private' } },
    { ok: false, code: 'invalid code' },
  ])
    expect(() => readNativePreviewLayoutReply(raw, identity)).toThrow(
      'invalid_preview_layout_reply',
    );
  expect(() =>
    readNativePreviewLayoutReply({ ok: false, code: 'preview_paint_failed' }, identity),
  ).toThrow('preview_paint_failed');
});
