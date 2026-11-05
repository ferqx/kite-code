import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeModelSettingsFacts } from '../src/native-bridge';
import { type NativeModelChoice, NativeModelPicker } from '../src/native-model-picker';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

// This isolated artifact records intermediate frames without adding a client diagnostic entry.
const samples: unknown[] = [];
Reflect.set(window, 'modelPreferenceFrames', samples);
function sample() {
  const trigger = document.querySelector<HTMLButtonElement>('[data-model-trigger]');
  samples.push({
    time: performance.now(),
    label: trigger?.textContent,
    disabled: trigger?.disabled,
    busy: document.querySelector('[data-model-picker]')?.getAttribute('aria-busy'),
    alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
    pickers: document.querySelectorAll('[data-model-picker]').length,
  });
  if (samples.length < 2000) requestAnimationFrame(sample);
}
requestAnimationFrame(sample);

const models: NativeModelSettingsFacts['models'] = ['a', 'b'].map((id) => ({
  id,
  provider: 'openai',
  model: `Fixture ${id.toUpperCase()}`,
  enabled: true,
  configured: true,
  reasoningEffortChoices: ['low', 'medium', 'high', 'xhigh', 'max', 'ultar'],
  diagnostics: [],
}));
function Fixture() {
  const [storeId, setStoreId] = useState('store');
  const [choice, setChoice] = useState<NativeModelChoice>({});
  const [ready, setReady] = useState(false);
  const bridge = useMemo<NativeBridge>(
    () => ({
      watch: () => () => {},
      request: async () => ({
        kind: 'settings.models',
        observationId: 1,
        storeId,
        scope: 'user',
        canWrite: true,
        errors: [],
        defaultModelId: 'a',
        models,
      }),
    }),
    [storeId],
  );
  return (
    <main style={{ padding: 40 }}>
      <h1>模型记忆退出恢复验证</h1>
      <p>当前数据源：{storeId}</p>
      <button
        type="button"
        onClick={() => {
          setChoice({});
          setStoreId(storeId === 'store' ? 'other' : 'store');
        }}
      >
        切换数据源
      </button>
      <NativeModelPicker
        key={storeId}
        bridge={bridge}
        generation={1}
        preparing={{ storeId }}
        value={choice}
        onChange={setChoice}
        onReady={setReady}
      />
      <button type="button" disabled={!ready}>
        发送测试
      </button>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
