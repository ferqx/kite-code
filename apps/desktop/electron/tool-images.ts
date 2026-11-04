import { ClientError, type Execution } from '@kite-ai/client';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Display metadata from exact successful image/PDF reads, never model-authored paths. */
export function nativeToolImages(execution: Execution) {
  const result = object(execution.result);
  if (
    !(
      (execution.definitionId === 'files.read' && execution.definitionVersion === '5') ||
      (execution.definitionId === 'files.view_images' && execution.definitionVersion === '1')
    ) ||
    execution.status !== 'succeeded' ||
    result?.outcome !== 'succeeded' ||
    result.modelImages === undefined
  )
    return [];
  const local = execution.definitionId === 'files.view_images';
  if (
    !Array.isArray(result.modelImages) ||
    result.modelImages.length > (local ? 10 : 4) ||
    !Array.isArray(result.artifactRefs)
  )
    throw new ClientError('tool_images_invalid');
  let pages: unknown[] = [];
  let imageNames: (string | undefined)[] = [];
  try {
    const body = JSON.parse(String(result.content));
    if (Array.isArray(body.pages)) pages = body.pages;
    if (local) {
      const images = Array.isArray(body.images) ? body.images : [body];
      imageNames = images.map((image: unknown) => {
        const path = object(image)?.path;
        return typeof path === 'string' ? path.split(/[\\/]/).at(-1)?.slice(0, 512) : undefined;
      });
    }
  } catch {}
  let total = 0n;
  if (
    local &&
    (!result.modelImages.length ||
      imageNames.length !== result.modelImages.length ||
      imageNames.some((name) => !name))
  )
    throw new ClientError('tool_images_invalid');
  return result.modelImages.map((value, index) => {
    const ref = object(value),
      scope = object(ref?.scope);
    if (
      !ref ||
      typeof ref.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(ref.id) ||
      ref.mediaType !== 'image/png' ||
      typeof ref.size !== 'string' ||
      !/^[1-9][0-9]{0,8}$/.test(ref.size) ||
      (local && BigInt(ref.size) > 8n * 1024n * 1024n) ||
      scope?.kind !== 'execution' ||
      scope.id !== execution.id ||
      !(result.artifactRefs as unknown[]).some((candidate) => {
        const other = object(candidate),
          otherScope = object(other?.scope);
        return (
          other?.id === ref.id &&
          other?.mediaType === ref.mediaType &&
          other?.size === ref.size &&
          otherScope?.kind === 'execution' &&
          otherScope.id === execution.id
        );
      })
    )
      throw new ClientError('tool_images_invalid');
    total += BigInt(ref.size);
    if (total > 16n * 1024n * 1024n) throw new ClientError('tool_images_invalid');
    const page = object(pages[index])?.number ?? pages[index];
    return {
      name:
        imageNames[index] ??
        (Number.isSafeInteger(page) && Number(page) > 0
          ? `PDF 第 ${page} 页`
          : `PDF 页图 ${index + 1}`),
      reference: {
        id: ref.id,
        mediaType: 'image/png',
        size: ref.size,
        scope: { kind: 'execution' as const, id: execution.id },
        sessionId: execution.sessionId,
        storeId: execution.originStoreId,
      },
    };
  });
}
