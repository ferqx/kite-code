import { AgentError } from '../../storage/types';
import { imageBatchCount } from './format';

/** Shared by admission and execution; reject the whole request before any source IO. */
export function imagePaths(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentError('image_input_invalid');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== 'path' && key !== 'paths') ||
    Object.hasOwn(value, 'path') === Object.hasOwn(value, 'paths')
  )
    throw new AgentError('image_input_invalid');
  const paths = Object.hasOwn(value, 'path') ? [value.path] : value.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > imageBatchCount)
    throw new AgentError('image_count_exceeded');
  if (new Set(paths).size !== paths.length) throw new AgentError('image_input_invalid');
  for (const path of paths)
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 4096 ||
      path.includes('\0') ||
      Buffer.from(path).toString('utf8') !== path ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    )
      throw new AgentError('file_path_invalid');
  return [...paths] as string[];
}
