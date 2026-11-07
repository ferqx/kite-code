/** Ignore editing coordinates and per-message anchor identities, retaining actual markup and text. */
export function markdownMarkup(element: Element) {
  const clone = element.cloneNode(true) as Element;
  for (const caret of clone.querySelectorAll('[data-md-caret]')) caret.remove();
  for (const node of [clone, ...clone.querySelectorAll('*')])
    for (const attribute of [...node.attributes])
      if (
        (attribute.name === 'style' && !attribute.value) ||
        attribute.name.startsWith('data-md-') ||
        [
          'id',
          'href',
          'aria-describedby',
          'aria-disabled',
          'disabled',
          'data-disabled',
          'contenteditable',
          'tabindex',
          'title',
        ].includes(attribute.name)
      )
        node.removeAttribute(attribute.name);
  return clone.innerHTML;
}
