import type { ArtifactRef } from './extensions';
import { AgentError } from './storage/types';

/** Closed result metadata; the store must still validate each original reference. */
export function toolImages(value: unknown, executionId: string): ArtifactRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new AgentError('tool_images_invalid');
  let size = 0;
  for (const ref of value) {
    if (
      !ref ||
      Object.keys(ref).sort().join(',') !== 'id,mediaType,scope,size' ||
      typeof ref.id !== 'string' ||
      !ref.id ||
      ref.mediaType !== 'image/png' ||
      typeof ref.size !== 'string' ||
      !/^[1-9][0-9]{0,7}$/.test(ref.size) ||
      !ref.scope ||
      Object.keys(ref.scope).sort().join(',') !== 'id,kind' ||
      ref.scope.kind !== 'execution' ||
      ref.scope.id !== executionId
    )
      throw new AgentError('tool_images_invalid');
    size += Number(ref.size);
  }
  if (size > 16 * 1024 * 1024) throw new AgentError('tool_images_too_large');
  return value;
}
