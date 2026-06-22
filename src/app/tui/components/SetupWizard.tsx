import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultConfigPath, type ModelProviderType, saveProviderConfig } from '@/core/config';
import { useTheme } from '../theme';

type SetupStep = 'provider' | 'credentials' | 'model';
type CredFocus = 'apiKey' | 'baseURL';

interface ProviderOption {
  type: ModelProviderType;
  label: string;
  defaultBaseURL: string;
  keyHint: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    keyHint: 'https://platform.deepseek.com/api_keys',
  },
  {
    type: 'openai',
    label: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    keyHint: 'https://platform.openai.com/api-keys',
  },
  {
    type: 'openai-compatible',
    label: 'OpenAI-Compatible',
    defaultBaseURL: 'http://localhost:8080/v1',
    keyHint: 'Enter API key for your endpoint',
  },
  { type: 'ollama', label: 'Ollama', defaultBaseURL: 'http://localhost:11434', keyHint: '' },
];

const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface SetupWizardProps {
  onComplete: (result: { modelName: string }) => void;
}

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const t = useTheme();

  // ── State ──
  const [step, setStep] = useState<SetupStep>('provider');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [providerType, setProviderType] = useState<ModelProviderType>('deepseek');
  const [credFocus, setCredFocus] = useState<CredFocus>('apiKey');
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [modelIndex, setModelIndex] = useState(0);
  const [selModelIndex, setSelModelIndex] = useState(0);
  const [customModel, setCustomModel] = useState('');
  const [thinkingIndex, setThinkingIndex] = useState(THINKING_EFFORTS.indexOf('max'));
  const [selThinkingIndex, setSelThinkingIndex] = useState(THINKING_EFFORTS.indexOf('max'));
  const [modelFocus, setModelFocus] = useState<'models' | 'effort' | 'reasoning'>('models');
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [reasoning, setReasoning] = useState(true);
  const [selReasoning, setSelReasoning] = useState(true);

  // ── Refs ──
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const baseURLRef = useRef(baseURL);
  baseURLRef.current = baseURL;
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;
  const stepRef = useRef(step);
  stepRef.current = step;
  const providerTypeRef = useRef(providerType);
  providerTypeRef.current = providerType;
  const modelIndexRef = useRef(modelIndex);
  modelIndexRef.current = modelIndex;
  const selModelIndexRef = useRef(selModelIndex);
  selModelIndexRef.current = selModelIndex;
  const customModelRef = useRef(customModel);
  customModelRef.current = customModel;
  const thinkingIndexRef = useRef(thinkingIndex);
  thinkingIndexRef.current = thinkingIndex;
  const selThinkingIndexRef = useRef(selThinkingIndex);
  selThinkingIndexRef.current = selThinkingIndex;
  const reasoningRef = useRef(reasoning);
  reasoningRef.current = reasoning;
  const selReasoningRef = useRef(selReasoning);
  selReasoningRef.current = selReasoning;

  const selectedOption =
    PROVIDER_OPTIONS.find((o) => o.type === providerType) ?? PROVIDER_OPTIONS[0]!;

  const availableModels = useMemo(() => {
    if (remoteModels === null) return [];
    return remoteModels.map((name) => ({ name }));
  }, [remoteModels]);

  // ── Fetch models on Step 3 ──
  useEffect(() => {
    if (step !== 'model' || remoteModels !== null || modelsLoading) return;
    const url = (baseURL || selectedOption.defaultBaseURL).replace(/\/+$/, '');
    const isOllama = providerType === 'ollama';
    const endpoint = isOllama ? `${url}/api/tags` : `${url}/models`;
    const headers: Record<string, string> = {};
    if (!isOllama && apiKey) headers.Authorization = `Bearer ${apiKey}`;
    setModelsLoading(true);
    fetch(endpoint, { headers, signal: AbortSignal.timeout(8000) })
      .then((res) => res.json())
      .then((data: any) => {
        const items: any[] = isOllama ? (data?.models ?? []) : (data?.data ?? []);
        const names = items
          .map((it) => (isOllama ? it?.name : it?.id))
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        setRemoteModels(names);
      })
      .catch(() => setRemoteModels([]))
      .finally(() => setModelsLoading(false));
  }, [
    step,
    remoteModels,
    modelsLoading,
    baseURL,
    providerType,
    apiKey,
    selectedOption.defaultBaseURL,
  ]);

  // ── Global handlers ──
  useInput((input: string, key: { ctrl?: boolean }) => {
    if (key.ctrl && input === 'c') process.exit(0);
  });

  const goToStep = useCallback((next: SetupStep) => {
    setError(null);
    if (next === 'credentials') {
      setCredFocus('apiKey');
      const opt = PROVIDER_OPTIONS.find((o) => o.type === providerTypeRef.current);
      if (opt) setBaseURL(opt.defaultBaseURL);
    }
    if (next === 'model') {
      setCustomModel('');
      setModelIndex(0);
      setSelModelIndex(0);
      setThinkingIndex(selThinkingIndex);
    }
    setStep(next);
  }, []);

  // ── Step 1: Provider ──
  useInput(
    (
      _input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      if (stepRef.current !== 'provider') return;
      if (key.escape) {
        process.exit(0);
      }
      if (key.upArrow) {
        setSelectedIndex((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((s) => Math.min(PROVIDER_OPTIONS.length - 1, s + 1));
        return;
      }
      if (key.return) {
        const opt = PROVIDER_OPTIONS[selectedRef.current];
        if (!opt) return;
        setProviderType(opt.type);
        providerTypeRef.current = opt.type;
        setReasoning(opt.type === 'deepseek');
        setSelReasoning(opt.type === 'deepseek');
        if (opt.type === 'ollama') {
          setApiKey('');
          goToStep('model');
        } else goToStep('credentials');
      }
    },
  );

  // ── Step 2: Credentials ──
  const submitCredentials = useCallback(() => {
    if (!apiKeyRef.current.trim()) {
      setError('API key cannot be empty');
      return;
    }
    setError(null);
    goToStep('model');
  }, [goToStep]);

  useInput((_input: string, key: { escape?: boolean; tab?: boolean }) => {
    if (stepRef.current !== 'credentials') return;
    if (key.escape) {
      setApiKey('');
      setBaseURL('');
      goToStep('provider');
      return;
    }
    if (key.tab) {
      setCredFocus((f) => (f === 'apiKey' ? 'baseURL' : 'apiKey'));
    }
  });

  // ── Step 3: Model ──
  const confirmSetup = useCallback(
    (chosenModel: string) => {
      const name = chosenModel.trim();
      if (!name) {
        setError('Please enter a model name');
        return;
      }
      setError(null);
      const effort = THINKING_EFFORTS[selThinkingIndexRef.current] ?? 'max';
      const models =
        remoteModels && remoteModels.length > 0
          ? remoteModels.map((m) => ({ name: m, default: m === name }))
          : [{ name, default: true }];
      const ok = saveProviderConfig({
        name: providerTypeRef.current,
        type: providerTypeRef.current,
        apiKey: apiKeyRef.current,
        baseURL: baseURLRef.current || undefined,
        models,
        effort,
        reasoning: selReasoningRef.current,
      });
      if (!ok) {
        setError('Failed to write config file');
        return;
      }
      onComplete({ modelName: name });
    },
    [onComplete, remoteModels],
  );

  useInput(
    (
      _input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        tab?: boolean;
      },
    ) => {
      if (stepRef.current !== 'model') return;
      if (key.escape) {
        goToStep('credentials');
        return;
      }
      if (key.tab) {
        const order: readonly string[] = selReasoningRef.current
          ? ['models', 'reasoning', 'effort']
          : ['models', 'reasoning'];
        const idx = order.indexOf(modelFocus);
        setModelFocus(order[(idx + 1) % order.length]! as typeof modelFocus);
        return;
      }
      const mi = modelIndexRef.current;
      const si = selModelIndexRef.current;
      const ti = thinkingIndexRef.current;
      const hasList = availableModels.length > 0;
      const textInputActive = modelFocus === 'models' && ((hasList && mi < 0) || !hasList);
      if (key.return && !textInputActive) {
        if (!hasList && !customModelRef.current.trim()) {
          setError('Please enter a model name');
          return;
        }
        const name =
          hasList && si >= 0 ? (availableModels[si]?.name ?? '') : customModelRef.current;
        confirmSetup(name);
        return;
      }
      if (_input === ' ' && !textInputActive) {
        if (modelFocus === 'models' && hasList && mi >= 0) {
          setSelModelIndex(mi);
          return;
        }
        if (modelFocus === 'effort' && ti >= 0) {
          setSelThinkingIndex(ti);
          return;
        }
        if (modelFocus === 'reasoning') {
          setSelReasoning(reasoningRef.current);
          return;
        }
        return;
      }
      if (modelFocus === 'models' && hasList && mi >= 0) {
        if (key.upArrow) {
          setModelIndex((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setModelIndex((s) => Math.min(availableModels.length - 1, s + 1));
          return;
        }
      }
      if (modelFocus === 'effort') {
        if (key.upArrow) {
          setThinkingIndex((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setThinkingIndex((s) => Math.min(THINKING_EFFORTS.length - 1, s + 1));
          return;
        }
      }
      if (modelFocus === 'reasoning') {
        if (key.upArrow || key.downArrow) {
          setReasoning((r) => !r);
          return;
        }
      }
    },
  );

  // ═══════════════════════════════════════════
  // Shared primitives
  // ═══════════════════════════════════════════

  const idx = (s: string) => ['provider', 'credentials', 'model'].indexOf(s) + 1;

  const cur = (active: boolean, sel?: boolean) => {
    if (active) return '❯';
    if (sel) return '●';
    return ' ';
  };

  const focusColor = (active: boolean) => (active ? t.primary : t.muted);

  const itemColor = (active: boolean, sel: boolean) => (active || sel ? t.primary : t.muted);

  const Item = ({
    label,
    active,
    selected,
  }: {
    label: string;
    active: boolean;
    selected?: boolean;
  }) => (
    <Box>
      <Text color={itemColor(active, !!selected)}>
        {cur(active, selected)} {label}
      </Text>
    </Box>
  );

  // ═══════════════════════════════════════════
  // Step 1: Provider
  // ═══════════════════════════════════════════
  if (step === 'provider') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={t.primary}
          paddingX={2}
          paddingY={1}
        >
          <Text bold color={t.primary}>
            Setup OpenPX ({idx('provider')}/3)
          </Text>
          <Text color={t.muted}>Choose your model provider.</Text>
          <Box marginTop={1} flexDirection="column">
            {PROVIDER_OPTIONS.map((opt, i) => (
              <Item key={opt.type} active={i === selectedIndex} label={opt.label} />
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={t.dim}>↑↓ select Enter confirm Esc quit</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // ═══════════════════════════════════════════
  // Step 2: Credentials
  // ═══════════════════════════════════════════
  if (step === 'credentials') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={t.primary}
          paddingX={2}
          paddingY={1}
        >
          <Text bold color={t.primary}>
            Configure {selectedOption.label} ({idx('credentials')}/3)
          </Text>
          <Text color={t.dim}>{selectedOption.keyHint}</Text>
          {error ? (
            <Box>
              <Text color={t.error}>{error}</Text>
            </Box>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={focusColor(credFocus === 'apiKey')}>
                {cur(credFocus === 'apiKey')} API Key{' '}
              </Text>
              <TextInput
                value={apiKey}
                onChange={(v) => {
                  setApiKey(v);
                  apiKeyRef.current = v;
                }}
                focus={credFocus === 'apiKey'}
                placeholder="sk-..."
                onSubmit={submitCredentials}
              />
            </Box>
            <Box>
              <Text color={focusColor(credFocus === 'baseURL')}>
                {cur(credFocus === 'baseURL')} Base URL{' '}
              </Text>
              <TextInput
                value={baseURL}
                onChange={(v) => {
                  setBaseURL(v);
                  baseURLRef.current = v;
                }}
                focus={credFocus === 'baseURL'}
                onSubmit={submitCredentials}
              />
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text color={t.dim}>Tab switch Enter confirm Esc back</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // ═══════════════════════════════════════════
  // Step 3: Model & Thinking
  // ═══════════════════════════════════════════
  if (step === 'model') {
    const thinkingLevel = THINKING_EFFORTS[selThinkingIndex] ?? 'max';
    const hasList = availableModels.length > 0;
    const selModelName = availableModels[selModelIndex]?.name ?? '';
    const activeModelName =
      hasList && selModelIndex >= 0 ? selModelName : customModel || selModelName || '';

    return (
      <Box flexDirection="column" padding={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={t.primary}
          paddingX={2}
          paddingY={1}
        >
          <Text bold color={t.primary}>
            Model & Thinking ({idx('model')}/3)
          </Text>
          {error ? (
            <Box>
              <Text color={t.error}>{error}</Text>
            </Box>
          ) : null}

          {/* Model */}
          <Box marginTop={1}>
            <Text bold color={focusColor(modelFocus === 'models')}>
              Model
            </Text>
          </Box>
          {modelsLoading ? (
            <Box paddingLeft={2}>
              <Text color={t.dim}>Fetching…</Text>
            </Box>
          ) : hasList ? (
            <Box flexDirection="column" paddingLeft={2}>
              {availableModels.map((m, i) => (
                <Item
                  key={m.name}
                  active={modelFocus === 'models' && i === modelIndex}
                  selected={i === selModelIndex}
                  label={m.name}
                />
              ))}
            </Box>
          ) : (
            <Box paddingLeft={2}>
              {remoteModels !== null ? <Text color={t.dim}>Could not fetch: </Text> : null}
              <TextInput
                value={customModel}
                onChange={(v) => {
                  setCustomModel(v);
                  customModelRef.current = v;
                }}
                placeholder={activeModelName || 'model-name'}
                focus={modelFocus === 'models'}
                onSubmit={(v) => confirmSetup(v || activeModelName)}
              />
            </Box>
          )}

          {/* Reasoning */}
          <Box marginTop={1}>
            <Text bold color={focusColor(modelFocus === 'reasoning')}>
              Reasoning
            </Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            <Item
              active={modelFocus === 'reasoning' && !reasoning}
              selected={!selReasoning}
              label="Off"
            />
            <Item
              active={modelFocus === 'reasoning' && reasoning}
              selected={selReasoning}
              label="On"
            />
          </Box>

          {/* Effort */}
          {selReasoning && (
            <>
              <Box marginTop={1}>
                <Text bold color={focusColor(modelFocus === 'effort')}>
                  Effort
                </Text>
              </Box>
              <Box flexDirection="column" paddingLeft={2}>
                {THINKING_EFFORTS.map((eff, i) => (
                  <Item
                    key={eff}
                    active={modelFocus === 'effort' && i === thinkingIndex}
                    selected={i === selThinkingIndex}
                    label={eff}
                  />
                ))}
              </Box>
            </>
          )}

          {/* Summary */}
          <Box marginTop={1}>
            <Text color={t.dim}>
              {selectedOption.label} · {activeModelName || '…'}
              {selReasoning ? ` · ${thinkingLevel}` : ''}
            </Text>
          </Box>
          <Box>
            <Text color={t.dim}>{defaultConfigPath()}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={t.primary}>Enter — Confirm & Start</Text>
          </Box>
          <Box>
            <Text color={t.dim}>Space select Tab switch Esc back</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return null;
}
