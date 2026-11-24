export const officePreviewWheelMessage = 'kite-office-preview-wheel';

export function officePreviewWheelDelta(event: WheelEvent, pageHeight: number) {
  if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return 0;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return Math.max(-300, Math.min(300, event.deltaY * unit));
}
