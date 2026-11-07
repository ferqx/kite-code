/** Seed a native textarea through the same value/input path as browser editing. */
export function setEditorText(element: HTMLElement, value: string) {
  const textarea = element as HTMLTextAreaElement;
  const window = textarea.ownerDocument.defaultView!;
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
    textarea,
    value,
  );
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
}
export const setEditorMarkdown = setEditorText;
export const editorSource = (element: Element) => (element as HTMLTextAreaElement).value;
