import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Retain the final cluster until the next bounded span establishes its boundary. */
function* clusters(text: string): Generator<string> {
  let carry = '';
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(text.length, offset + 1024);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    const parts = Array.from(
      segmenter.segment(carry + text.slice(offset, end)),
      (part) => part.segment,
    );
    carry = parts.pop() ?? '';
    yield* parts;
    offset = end;
  }
  if (carry) yield carry;
}

/** Plain-text equivalent of Ink's trim:false, hard:true word wrapping.
 * Keep each line bounded before Ink measures it; never segment the whole body.
 * This is display text only. The original body and export remain untouched.
 */
export function wrapPlainText(text: string, columns: number): string {
  columns = Math.max(1, Math.floor(columns));
  const widths = new Map<string, number>();
  const width = (cluster: string) => {
    let value = widths.get(cluster);
    if (value === undefined) {
      value = stringWidth(cluster);
      widths.set(cluster, value);
    }
    return value;
  };
  const length = (word: string) => {
    let total = 0;
    for (const cluster of clusters(word)) total += width(cluster);
    return total;
  };
  // Ink normalizes wrapped text and expands tabs before measuring words.
  return text
    .normalize()
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((source) => {
      let expanded = '',
        visible = 0;
      for (const [index, part] of source.split('\t').entries()) {
        if (index) {
          const spaces = 8 - (visible % 8);
          expanded += ' '.repeat(spaces);
          visible += spaces;
        }
        expanded += part;
        visible += length(part);
      }
      const rows = [''];
      let rowWidth = 0;
      for (const [index, word] of expanded.split(' ').entries()) {
        if (index) {
          if (rowWidth >= columns) {
            rows.push('');
            rowWidth = 0;
          }
          rows[rows.length - 1] += ' ';
          rowWidth++;
        }
        const wordWidth = length(word);
        if (wordWidth > columns) {
          const onThisRow = 1 + Math.floor((wordWidth - (columns - rowWidth) - 1) / columns);
          const onNextRow = Math.floor((wordWidth - 1) / columns);
          if (onNextRow < onThisRow) {
            rows.push('');
            rowWidth = 0;
          }
          const parts = clusters(word);
          for (const cluster of parts) {
            const clusterWidth = width(cluster);
            if (rowWidth + clusterWidth > columns) {
              rows.push('');
              rowWidth = 0;
            }
            rows[rows.length - 1] += cluster;
            rowWidth += clusterWidth;
          }
        } else {
          if (rowWidth + wordWidth > columns && rowWidth > 0 && wordWidth > 0) {
            rows.push('');
            rowWidth = 0;
          }
          rows[rows.length - 1] += word;
          rowWidth += wordWidth;
        }
      }
      return rows.join('\n');
    })
    .join('\n');
}
