import { browserToolIds } from '@kite-ai/agent/browser';
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
export function ordinaryHostConfigurationDefaults(
  shellAvailable: boolean,
  taskAvailable: boolean,
  browserAllowed = true,
  unifiedBrowser = false,
  gitWorktreeAvailable = true,
) {
  return {
    ...defaultConfiguration,
    tools: [
      ...defaultConfiguration.tools,
      ...[
        'execution_evidence.read',
        'files.read',
        'files.view_images',
        'files.write',
        'files.edit',
        ...(shellAvailable
          ? shellToolIds.filter((id) => id !== 'git.worktree' || gitWorktreeAvailable)
          : []),
        'web_fetch',
        ...(browserAllowed ? (unifiedBrowser ? ['browser.execute'] : browserToolIds) : []),
        ...(shellAvailable || (browserAllowed && unifiedBrowser)
          ? ['skills.load', 'skills.resource']
          : []),
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
