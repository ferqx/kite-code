import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  getNearestEditorFromDOMNode,
} from 'lexical';

/** Input ownership tests use the real editor; keyboard behavior has separate coverage. */
export function setEditorText(element: HTMLElement, value: string) {
  getNearestEditorFromDOMNode(element)!.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(value)));
    },
    { discrete: true },
  );
}
