import { Button as DesktopButton } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeShellPreference,
  NativeShellSettingsFacts,
} from './native-bridge';
import { NativeSettingsSelect } from './native-settings-select';

const names = {
  auto: '自动（推荐）',
  'git-bash': 'Git Bash',
  powershell: 'Windows PowerShell 5.1',
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

  const options =
    facts &&
    (['auto', 'git-bash', 'powershell'] as const).map((value) => {
      const disabled =
        (value === 'git-bash' && !facts.gitBashAvailable) ||
        (value === 'powershell' && !facts.powerShellAvailable);
      return { value, label: disabled ? `${names[value]}（不可用）` : names[value], disabled };
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
          更改后仅对新会话生效。
          {facts?.preference === 'auto' &&
            facts.automatic &&
            ` 自动当前使用 ${names[facts.automatic]}。`}
          {facts?.preference === 'auto' && !facts.automatic && ' 自动当前没有可用的 Shell。'}
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
