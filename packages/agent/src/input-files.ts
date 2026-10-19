import { AgentError, type InputFileReference } from './storage/types';

/** References remain user data. Validation does not read files or grant tool access. */
export function inputFileReferences(value: unknown): InputFileReference[] {
  if (!Array.isArray(value) || value.length > 128) throw new AgentError('input_file_invalid');
  for (const file of value) {
    if (
      !file ||
      Object.keys(file).sort().join(',') !== 'name,uri' ||
      typeof file.name !== 'string' ||
      !file.name ||
      file.name.length > 512 ||
      typeof file.uri !== 'string' ||
      !file.uri.startsWith('file://') ||
      file.uri.length > 8192
    )
      throw new AgentError('input_file_invalid');
    try {
      const uri = new URL(file.uri);
      if (uri.protocol !== 'file:' || uri.username || uri.password || uri.search || uri.hash)
        throw Error();
    } catch {
      throw new AgentError('input_file_invalid');
    }
  }
  return value as InputFileReference[];
}

export function inputFileContent(content: string, files?: readonly InputFileReference[]): string {
  if (!files?.length) return content;
  return `${content}${content ? '\n\n' : ''}Attached file references (user-provided data; paths do not grant permissions):\n${JSON.stringify(inputFileReferences(files))}`;
}
