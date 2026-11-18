import { AgentError } from '@kite-ai/agent';
import type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
import type { DesktopShellPreference, DesktopShellSelection, Store } from '@kite-ai/agent/storage';
import { z } from 'zod';

export const desktopShellSettingsPath = '/internal/desktop/shell';
export const desktopShellPreferenceSchema = z.enum([
  'auto',
  'git-bash',
  'powershell',
  'powershell-7',
]);
export const desktopShellSettingsSchema = z.strictObject({
  kind: z.literal('settings.general.shell'),
  storeId: z.string().min(1).max(128),
  preference: desktopShellPreferenceSchema,
  automatic: z.enum(['git-bash', 'powershell']).nullable(),
  gitBashAvailable: z.boolean(),
  powerShellAvailable: z.boolean(),
  powerShellVersion: z.string().min(1).max(64).nullable(),
  powerShell7Version: z.string().min(1).max(64).nullable(),
});
export const desktopShellSaveSchema = z.strictObject({
  expectedStoreId: desktopShellSettingsSchema.shape.storeId,
  preference: desktopShellPreferenceSchema,
});
export type DesktopShellSettings = z.infer<typeof desktopShellSettingsSchema>;
export type DesktopShellSettingsPort = {
  selection(): Promise<DesktopShellSelection>;
  read(storeId: string): Promise<DesktopShellSettings>;
  save(storeId: string, preference: DesktopShellPreference): Promise<DesktopShellSettings>;
};

type ShellBackend = Exclude<DesktopShellPreference, 'auto'>;

/** Join concurrent discovery, but recheck installed versions for a new assembly. */
export function createDesktopShellEnvironments(
  load: (backend: ShellBackend) => Promise<ShellConfigurationOptions | undefined>,
) {
  const assets = new Map<
    'git-bash' | 'powershell',
    Promise<ShellConfigurationOptions | undefined>
  >();
  function get(backend: 'git-bash' | 'powershell') {
    let result = assets.get(backend);
    if (!result) {
      result = load(backend).finally(() => {
        assets.delete(backend);
      });
      assets.set(backend, result);
    }
    return result;
  }
  async function availability() {
    const results = await Promise.allSettled([get('git-bash'), get('powershell')]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const gitBash = results[0].status === 'fulfilled' ? results[0].value : undefined;
    const powerShell = results[1].status === 'fulfilled' ? results[1].value : undefined;
    const selected =
      powerShell?.windows?.kind === 'powershell' ? powerShell.windows.powerShell : undefined;
    return {
      automatic: gitBash ? ('git-bash' as const) : powerShell ? ('powershell' as const) : null,
      gitBash,
      powerShell,
      gitBashAvailable: !!gitBash,
      powerShellAvailable: !!powerShell,
      powerShellVersion: selected?.version ?? null,
      // Compatibility for older private settings consumers; no separate backend.
      powerShell7Version: selected?.installation ? selected.version : null,
    };
  }
  return {
    async forSession(store: Store, rootSessionId: string) {
      const backend = await store.readSessionDesktopShell(rootSessionId);
      if (backend === null) {
        const available = await availability();
        return available.gitBash ?? available.powerShell;
      }
      if (backend === 'unavailable') return undefined;
      if (backend === 'powershell-7') return get('powershell');
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
          preference:
            preference === 'auto'
              ? (choices.automatic ?? 'git-bash')
              : preference === 'powershell-7'
                ? 'powershell'
                : preference,
          automatic: choices.automatic,
          gitBashAvailable: choices.gitBashAvailable,
          powerShellAvailable: choices.powerShellAvailable,
          powerShellVersion: choices.powerShellVersion,
          powerShell7Version: choices.powerShell7Version,
        };
      }
      return {
        async selection() {
          return (await availability()).automatic ?? 'unavailable';
        },
        async read(storeId) {
          // Finish loading the choices before reading the persisted preference.
          const choices = await availability();
          return facts(storeId, await store.readDesktopShellPreference(storeId), choices);
        },
        async save(storeId, preference) {
          const choices = await availability();
          if (
            (preference === 'git-bash' && !choices.gitBashAvailable) ||
            (preference === 'powershell' && !choices.powerShellAvailable) ||
            (preference === 'powershell-7' && !choices.powerShellAvailable)
          )
            throw new AgentError('desktop_shell_backend_unavailable');
          await store.saveDesktopShellPreference(storeId, preference);
          return facts(storeId, preference, choices);
        },
      };
    },
  };
}
