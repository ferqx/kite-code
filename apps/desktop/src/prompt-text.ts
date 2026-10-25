/** Remove only final line endings; draft bytes and Markdown whitespace stay intact. */
export function promptTextForSend(content: string): string {
  return content.replace(/[\r\n]+$/u, '');
}
