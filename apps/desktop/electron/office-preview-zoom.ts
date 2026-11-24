import type { Input, WebContents } from 'electron';
import { officePreviewWheelDelta, officePreviewWheelMessage } from '../src/office-preview-zoom';
import { officePreviewScheme } from './office-preview-frame';

type ZoomKey = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

export function officePreviewZoomShortcut(key: ZoomKey): -1 | 0 | 1 | undefined {
  if (key.altKey || key.ctrlKey === key.metaKey) return;
  if (key.key === '+' || key.key === '=') return 1;
  if (key.key === '-') return -1;
  if (key.key === '0') return 0;
  return undefined;
}

export function isNativeOfficeZoomShortcut(input: Input) {
  return (
    officePreviewZoomShortcut({
      key: input.key,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
    }) !== undefined
  );
}

export function ignoreOfficePreviewMenuShortcut(contents: WebContents, input: Input) {
  return (
    isNativeOfficeZoomShortcut(input) &&
    contents.focusedFrame?.url.startsWith(`${officePreviewScheme}://`) === true
  );
}

function installOfficePreviewZoom(
  shortcut: typeof officePreviewZoomShortcut,
  wheelDelta: typeof officePreviewWheelDelta,
  wheelMessage: string,
) {
  const scope = globalThis as typeof globalThis & {
    kiteOfficeInputBlocked?: boolean;
    kiteOfficeInteraction?: {
      zoomScale: () => number | undefined;
      control: (command: { kind: 'zoom'; value: number }) => void;
    };
  };
  const levels = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const descending = [...levels].reverse();
  const min = levels[0]!;
  const max = levels.at(-1)!;
  let delta = 0;
  let frame = 0;
  const applyWheel = () => {
    frame = 0;
    const change = delta;
    delta = 0;
    if (!change || scope.kiteOfficeInputBlocked) return;
    const controller = scope.kiteOfficeInteraction;
    const scale = controller?.zoomScale();
    if (scale === undefined || (change < 0 && scale <= min) || (change > 0 && scale >= max)) return;
    const next = Math.max(min, Math.min(max, scale * Math.exp(change)));
    controller?.control({ kind: 'zoom', value: next });
  };
  const queueWheel = (change: number) => {
    if (scope.kiteOfficeInputBlocked) return;
    delta += change;
    if (!frame) frame = requestAnimationFrame(applyWheel);
  };
  window.addEventListener(
    'wheel',
    (event) => {
      const amount = wheelDelta(event, innerHeight);
      if (!amount) return;
      event.preventDefault();
      queueWheel(-amount / 500);
    },
    { capture: true, passive: false },
  );
  window.addEventListener('message', (event) => {
    if (!event.isTrusted || event.source !== window.parent || event.data?.kind !== wheelMessage)
      return;
    const amount = event.data.delta;
    // Chromium represents each touchpad pinch update as deltaY = -100 * log(scale).
    if (typeof amount === 'number' && Number.isFinite(amount) && Math.abs(amount) <= 300 && amount)
      queueWheel(-amount / 100);
  });
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || event.isComposing) return;
      const direction = shortcut(event);
      if (direction === undefined) return;
      event.preventDefault();
      if (frame) cancelAnimationFrame(frame);
      frame = delta = 0;
      const controller = scope.kiteOfficeInteraction;
      const scale = controller?.zoomScale();
      if (scale === undefined) return;
      const next =
        direction === 0
          ? 1
          : direction > 0
            ? levels.find((level) => level > scale)
            : descending.find((level) => level < scale);
      if (next !== undefined) controller?.control({ kind: 'zoom', value: next });
    },
    { capture: true },
  );
}

export const officePreviewZoomInstallScript = () =>
  `(${installOfficePreviewZoom.toString()})(${officePreviewZoomShortcut.toString()},${officePreviewWheelDelta.toString()},${JSON.stringify(officePreviewWheelMessage)})`;
