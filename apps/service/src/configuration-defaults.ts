import { shellToolIds } from '@kite-ai/agent/permissions/shell';

/** Minimal embedded-host defaults; registrations do not imply capability selection. */
export const defaultConfiguration = {
  modelId: null,
  models: [],
  tools: [{ id: 'ask_user' }],
  skills: [],
  mcp: [],
};

/** Ordinary packaged clients have a useful tool surface before any tool settings exist.
 * Selection never grants execution permission, and absent host capabilities stay unavailable.
 */
export function ordinaryHostConfigurationDefaults(shellAvailable: boolean, taskAvailable: boolean) {
  return {
    ...defaultConfiguration,
    tools: [
      ...defaultConfiguration.tools,
      ...[
        'files.read',
        'files.read_path',
        'files.write',
        'files.edit',
        'files.list',
        'files.glob',
        'files.search',
        ...(shellAvailable ? shellToolIds : []),
        'web_fetch',
        ...(taskAvailable
          ? [
              'task.spawn',
              'task.message',
              'task.follow_up',
              'task.events',
              'task.list',
              'task.interrupt',
            ]
          : []),
      ].map((id) => ({ id })),
    ],
  };
}
