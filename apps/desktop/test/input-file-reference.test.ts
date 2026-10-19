import { expect, test } from 'bun:test';
import { inputFileReference } from '../src/input-file-reference';

test('selected disk paths preserve Windows, UNC and POSIX names without interpreting percent, query or fragment characters', () => {
  for (const [path, hostname, pathname] of [
    ['C:\\图 片\\100%?#[]报告.ini', '', '/C:/图 片/100%?#[]报告.ini'],
    ['\\\\server\\shared folder\\报告.ini', 'server', '/shared folder/报告.ini'],
    ['/tmp/a\\b%#?.ini', '', '/tmp/a\\b%#?.ini'],
  ]) {
    const result = inputFileReference('chosen.ini', path!);
    const uri = new URL(result.uri);
    expect(result.name).toBe('chosen.ini');
    expect(uri.protocol).toBe('file:');
    expect(uri.hostname).toBe(hostname!);
    expect(decodeURIComponent(uri.pathname)).toBe(pathname!);
    expect(uri.search).toBe('');
    expect(uri.hash).toBe('');
  }
  for (const path of ['', 'relative.ini', 'https://example.invalid/a', '\\\\?\\C:\\file.ini'])
    expect(() => inputFileReference('chosen.ini', path)).toThrow('file_reference_unavailable');
});
