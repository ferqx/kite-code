import { Button as DesktopButton } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeShellPreference,
  NativeShellSettingsFacts,
} from './native-bridge';
import { NativeSettingsSelect } from './native-settings-select';

const names = {
  'git-bash': 'Git Shell',
  powershell: 'PowerShell',
};

export function NativeShellSettings({
  bridge,
  generation,
  storeId,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId?: string;
}) {
  const id = useId();
  const observation = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  const [facts, setFacts] = useState<NativeShellSettingsFacts>();
  const [error, setError] = useState<string>();
  const read = useCallback(
    async (preference?: NativeShellPreference) => {
      const result = await bridge.request(
        preference === undefined
          ? { method: 'settings.general.shell.read', generation }
          : { method: 'settings.general.shell.save', generation, preference },
      );
      if (
        !result ||
        !('kind' in result) ||
        result.kind !== 'settings.general.shell' ||
        !('preference' in result) ||
        result.storeId !== storeId
      )
        throw Error('desktop_shell_settings_unavailable');
      return result;
    },
    [bridge, generation, storeId],
  );

  const refresh = useCallback(() => {
    if (!storeId) return;
    observation.current?.abort();
    const current = new AbortController();
    observation.current = current;
    setError(undefined);
    void read()
      .then((value) => {
        if (!current.signal.aborted) setFacts(value);
      })
      .catch(() => {
        if (!current.signal.aborted) setError('暂时无法读取集成终端设置。');
      });
  }, [read, storeId]);

  useEffect(() => {
    refresh();
    return () => observation.current?.abort();
  }, [refresh]);

  const choices = ['git-bash', 'powershell'] as const;
  const options =
    facts &&
    choices.map((value) => {
      const disabled =
        (value === 'git-bash' && !facts.gitBashAvailable) ||
        (value === 'powershell' && !facts.powerShellAvailable);
      const name =
        value === 'powershell' && facts.powerShellVersion
          ? `PowerShell ${facts.powerShellVersion}`
          : names[value];
      return { value, label: disabled ? `${name}（不可用）` : name, disabled };
    });
  async function save(preference: string) {
    const choice = options?.find((option) => option.value === preference && !option.disabled);
    const current = observation.current;
    if (
      !choice ||
      !current ||
      current.signal.aborted ||
      choice.value === facts?.preference ||
      saving.current
    )
      return;
    saving.current = true;
    setPending(true);
    setError(undefined);
    try {
      const value = await read(choice.value);
      if (!current.signal.aborted) setFacts(value);
    } catch {
      // A lost response does not authorize sending a second save.
      if (current.signal.aborted) return;
      const value = await read().catch(() => undefined);
      if (current.signal.aborted) return;
      setFacts(value);
      if (value?.preference !== choice.value)
        setError(value ? '未确认这次选择，请重试。' : '无法确认保存结果，请重新读取。');
    } finally {
      saving.current = false;
      if (!current.signal.aborted) setPending(false);
    }
  }
  const selectedUnavailable = options?.find(({ value }) => value === facts?.preference)?.disabled;
  return (
    <div className="settings-row" aria-busy={pending || (!facts && !error) || undefined}>
      <span>
        <label htmlFor={id}>
          <strong>集成终端 Shell</strong>
        </label>
        <small id={`${id}-hint`}>
          更改类型后仅对新会话生效。PowerShell 使用本机最高可用版本。
          {selectedUnavailable && ' 所选 Shell 当前不可用，请选择其他环境。'}
        </small>
        {pending && <small role="status">正在保存…</small>}
        {error && <small role="alert">{error}</small>}
      </span>
      {!facts && error ? (
        <DesktopButton type="button" variant="outline" onClick={refresh}>
          重新读取
        </DesktopButton>
      ) : (
        <NativeSettingsSelect
          id={id}
          aria-label="集成终端 Shell"
          aria-describedby={`${id}-hint`}
          disabled={!facts}
          value={facts?.preference ?? 'loading'}
          options={options ?? [{ value: 'loading', label: '正在读取…' }]}
          onValueChange={(value) => void save(value)}
        />
      )}
    </div>
  );
}
