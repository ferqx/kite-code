/** Decode the model-visible Files read contract independently of its formatter. */
export function presentedFileRead(content: string) {
  const lines = content.split('\n');
  const header =
    /^Read (".*"); from_line=(\d+); lines=(none|\d+-\d+)\/(\d+); next_line=(null|\d+); (complete file|selected window only)\.$/.exec(
      lines[0] ?? '',
    );
  const reference = lines[1]?.startsWith('evidence_ref=') ? 1 : 0;
  const size = /^Content \((\d+) UTF-8 bytes; starts on next line\):$/.exec(
    lines[2 + reference] ?? '',
  );
  if (!header || !size || !lines[1 + reference]?.startsWith('baseline=')) return;
  try {
    const text = lines.slice(3 + reference).join('\n');
    if (Buffer.byteLength(text) !== Number(size[1])) return;
    return {
      path: JSON.parse(header[1]!) as string,
      baseline: JSON.parse(lines[1 + reference]!.slice('baseline='.length)),
      content: text,
    };
  } catch {
    return;
  }
}
