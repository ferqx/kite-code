/** Keep restored focus and text-input heuristics from painting rings after pointer use. */
export function installNativeInputModality(document: Document): () => void {
  const root = document.documentElement;
  const previous = root.getAttribute('data-input-modality');
  const pointer = () => {
    root.dataset.inputModality = 'pointer';
  };
  const keyboard = (event: KeyboardEvent) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)
    )
      return;
    root.dataset.inputModality = 'keyboard';
  };
  pointer();
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('keydown', keyboard, true);
  return () => {
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('keydown', keyboard, true);
    if (previous === null) root.removeAttribute('data-input-modality');
    else root.setAttribute('data-input-modality', previous);
  };
}
