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
 * Selection never grants execution permission, and absent Shell assets stay unavailable.
 */
export function ordinaryHostConfigurationDefaults(shellAvailable: boolean) {
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
      ].map((id) => ({ id })),
    ],
  };
}
