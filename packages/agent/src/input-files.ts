import { AgentError, type InputFileReference } from './storage/types';

/** References remain user data. Validation does not read files or grant tool access. */
export function inputFileReferences(value: unknown): InputFileReference[] {
  if (!Array.isArray(value) || value.length > 128) throw new AgentError('input_file_invalid');
  for (const file of value) {
    if (
      !file ||
      !['name,uri', 'name,reference,uri'].includes(Object.keys(file).sort().join(',')) ||
      typeof file.name !== 'string' ||
      !file.name ||
      file.name.length > 512 ||
      typeof file.uri !== 'string' ||
      !file.uri.startsWith('file://') ||
      file.uri.length > 8192
    )
      throw new AgentError('input_file_invalid');
    if ('reference' in file) {
      const ref = file.reference;
      if (
        !ref ||
        Object.keys(ref).sort().join(',') !==
          'hash,id,mediaType,scope,sessionId,size,storeId,subjectId' ||
        typeof ref.id !== 'string' ||
        !/^input-file-[A-Za-z0-9_-]{1,100}$/.test(ref.id) ||
        typeof ref.storeId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(ref.storeId) ||
        typeof ref.sessionId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(ref.sessionId) ||
        typeof ref.subjectId !== 'string' ||
        !ref.subjectId ||
        ref.subjectId.length > 256 ||
        !ref.scope ||
        Object.keys(ref.scope).sort().join(',') !== 'id,kind' ||
        ref.scope.kind !== 'session' ||
        ref.scope.id !== ref.sessionId ||
        typeof ref.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(ref.hash) ||
        typeof ref.size !== 'string' ||
        !/^(0|[1-9][0-9]{0,15})$/.test(ref.size) ||
        !Number.isSafeInteger(Number(ref.size)) ||
        typeof ref.mediaType !== 'string' ||
        !ref.mediaType ||
        ref.mediaType.length > 256
      )
        throw new AgentError('input_file_invalid');
    }
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
