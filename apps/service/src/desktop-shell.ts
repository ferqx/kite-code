import { AgentError } from '@kite-ai/agent';
import type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
import type { DesktopShellBackend, DesktopShellPreference, Store } from '@kite-ai/agent/storage';
import { z } from 'zod';

export const desktopShellSettingsPath = '/internal/desktop/shell';
export const desktopShellPreferenceSchema = z.enum(['auto', 'git-bash', 'powershell']);
export const desktopShellSettingsSchema = z.strictObject({
  kind: z.literal('settings.general.shell'),
  storeId: z.string().min(1).max(128),
  preference: desktopShellPreferenceSchema,
  automatic: z.enum(['git-bash', 'powershell']).nullable(),
  gitBashAvailable: z.boolean(),
  powerShellAvailable: z.boolean(),
});
export const desktopShellSaveSchema = z.strictObject({
  expectedStoreId: desktopShellSettingsSchema.shape.storeId,
  preference: desktopShellPreferenceSchema,
});
export type DesktopShellSettings = z.infer<typeof desktopShellSettingsSchema>;
export type DesktopShellSettingsPort = {
  automatic: DesktopShellBackend;
  read(storeId: string): Promise<DesktopShellSettings>;
  save(storeId: string, preference: DesktopShellPreference): Promise<DesktopShellSettings>;
};

/** Cache the two finite, host-prepared backends. A failed alternate never substitutes for a pin. */
export function createDesktopShellEnvironments(
  initial: ShellConfigurationOptions | undefined,
  load: (
    backend: Exclude<DesktopShellPreference, 'auto'>,
  ) => Promise<ShellConfigurationOptions | undefined>,
) {
  const automatic = initial
    ? initial.windows?.kind === 'powershell'
      ? 'powershell'
      : 'git-bash'
    : null;
  const assets = new Map<
    'git-bash' | 'powershell',
    Promise<ShellConfigurationOptions | undefined>
  >();
  if (automatic) assets.set(automatic, Promise.resolve(initial));
  // An automatically selected PowerShell already established the absence of full Git Bash.
  if (automatic === 'powershell') assets.set('git-bash', Promise.resolve(undefined));
  function get(backend: 'git-bash' | 'powershell') {
    let result = assets.get(backend);
    if (!result) {
      result = load(backend).catch((error) => {
        assets.delete(backend);
        throw error;
      });
      assets.set(backend, result);
    }
    return result;
  }
  async function availability() {
    const [gitBash, powerShell] = await Promise.all([get('git-bash'), get('powershell')]);
    return { gitBashAvailable: !!gitBash, powerShellAvailable: !!powerShell };
  }
  return {
    async forSession(store: Store, rootSessionId: string) {
      const backend = await store.readSessionDesktopShell(rootSessionId);
      if (backend === null) return initial;
      if (backend === 'unavailable') return undefined;
      return get(backend);
    },
    settings(store: Store): DesktopShellSettingsPort {
      function facts(
        storeId: string,
        preference: DesktopShellPreference,
        choices: Awaited<ReturnType<typeof availability>>,
      ): DesktopShellSettings {
        return {
          kind: 'settings.general.shell',
          storeId,
          preference,
          automatic,
          ...choices,
        };
      }
      return {
        automatic: automatic ?? 'unavailable',
        async read(storeId) {
          // Finish loading the choices before reading the persisted preference.
          const choices = await availability();
          return facts(storeId, await store.readDesktopShellPreference(storeId), choices);
        },
        async save(storeId, preference) {
          const choices = await availability();
          if (
            (preference === 'git-bash' && !choices.gitBashAvailable) ||
            (preference === 'powershell' && !choices.powerShellAvailable)
          )
            throw new AgentError('desktop_shell_backend_unavailable');
          await store.saveDesktopShellPreference(storeId, preference);
          return facts(storeId, preference, choices);
        },
      };
    },
  };
}
