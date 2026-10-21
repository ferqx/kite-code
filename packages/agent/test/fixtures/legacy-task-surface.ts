import type { Extension } from '../../src/extensions';
import { createTaskExtension as createActualTaskExtension } from '../../src/extensions/task';

/** Explicit historical/typed protocol fixture. Production has exactly the six new public tools. */
export function createLegacyTaskFixture(
  options: Parameters<typeof createActualTaskExtension>[0],
): Extension {
  const extension = createActualTaskExtension(options);
  return {
    ...extension,
    tools: extension
      .tools!.filter((tool) => !tool.id.startsWith('task.') || tool.id === 'task.execute')
      .map((tool) => ({ ...tool, model: { ...tool.model!, hidden: tool.id === 'task_wait' } })),
  };
}
