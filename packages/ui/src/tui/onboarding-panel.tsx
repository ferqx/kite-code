import { Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import ConfigErrorScreen from './ink/first-run/ConfigErrorScreen';
import ConnectionScreen from './ink/first-run/ConnectionScreen';
import ConnectionStatusScreen from './ink/first-run/ConnectionStatusScreen';
import ErrorScreen from './ink/first-run/ErrorScreen';
import FirstRunShell from './ink/first-run/FirstRunShell';
import ManualModelScreen from './ink/first-run/ManualModelScreen';
import ProviderScreen from './ink/first-run/ProviderScreen';
import {
  type ConnectionError,
  classifyError,
  getErrorActions,
  PROVIDERS,
  type ProviderDefinition,
} from './ink/first-run/types';
import WorkspaceTrustGate from './ink/first-run/WorkspaceTrustGate';
import type { TuiOnboardingPort, TuiOnboardingResult, TuiOnboardingSnapshot } from './onboarding';

type Phase =
  | 'loading'
  | 'trust'
  | 'trust-saving'
  | 'provider'
  | 'models'
  | 'connection'
  | 'connecting'
  | 'manual'
  | 'error'
  | 'unknown'
  | 'configuration-error';
export function TuiOnboarding({
  port,
  workspaceId,
  path,
  onReady,
  onExit,
}: {
  port: TuiOnboardingPort;
  workspaceId: string;
  path: string;
  onReady(): void;
  onExit(): void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [snapshot, setSnapshot] = useState<TuiOnboardingSnapshot>();
  const [selected, setSelected] = useState(0);
  const [provider, setProvider] = useState<ProviderDefinition>(PROVIDERS[0]!);
  const [form, setForm] = useState({ apiKey: '', baseURL: '' });
  const cachedForms = useRef(new Map<string, { apiKey: string; baseURL: string }>());
  const [editing, setEditing] = useState<string>();
  const [modelName, setModelName] = useState('');
  const [connectionError, setConnectionError] = useState<ConnectionError>({
    kind: 'generic',
    message: 'The connection could not be completed.',
  });
  const [canContinue, setCanContinue] = useState(false);
  const mounted = useRef(true),
    busy = useRef(false);
  const abort = useRef<AbortController | undefined>(undefined);
  const operationGeneration = useRef(0);
  // Ports without explicit phase evidence remain conservatively a possible publication.
  const connectionPhase = useRef<'discovering' | 'publishing'>('publishing');
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  function apply(result: TuiOnboardingResult) {
    if (!mounted.current) return;
    if (result.status === 'cancelled') {
      setEditing(undefined);
      setPhase('connection');
    } else if (result.status === 'ready') {
      setForm({ apiKey: '', baseURL: '' });
      cachedForms.current.clear();
      onReadyRef.current();
    } else if (result.status === 'model-required') setPhase('manual');
    else if (result.status === 'unknown') {
      setCanContinue(result.canContinue === true);
      setPhase('unknown');
    } else {
      setSelected(0);
      const generic =
        'The connection could not be completed. Review the endpoint and API key, or enter a model name manually.';
      setConnectionError(
        result.code === 'provider_discovery_auth_failed'
          ? classifyError(401, generic, form.baseURL)
          : [
                'provider_discovery_failed',
                'provider_discovery_invalid',
                'provider_discovery_empty',
                'provider_discovery_too_large',
              ].includes(result.code)
            ? classifyError(undefined, generic, form.baseURL)
            : result.code === 'provider_discovery_unavailable'
              ? classifyError(undefined, 'Could not fetch the model list.', form.baseURL)
              : { kind: 'generic', message: generic },
      );
      setPhase('error');
    }
  }
  const read = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase('loading');
    const generation = ++operationGeneration.current;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const next = await port.read(workspaceId, controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== operationGeneration.current
      )
        return;
      setSnapshot(next);
      if (next.observer === 'workspace_missing') onReadyRef.current();
      else if (!next.trusted) setPhase('trust');
      else if (next.modelName) onReadyRef.current();
      else if (next.hasModels) {
        setSelected(0);
        setPhase('models');
      } else setPhase('provider');
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        generation === operationGeneration.current
      )
        setPhase('configuration-error');
    } finally {
      if (generation === operationGeneration.current) busy.current = false;
    }
  }, [port, workspaceId]);
  async function run(
    action: (signal: AbortSignal) => Promise<TuiOnboardingResult>,
    trusting = false,
  ) {
    if (busy.current) return;
    busy.current = true;
    setPhase(trusting ? 'trust-saving' : 'connecting');
    const controller = new AbortController();
    const generation = ++operationGeneration.current;
    abort.current = controller;
    try {
      const result = await action(controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== operationGeneration.current
      )
        return;
      if (result.status === 'model-required' && (trusting || result.stage === 'provider')) {
        const next = await port.read(workspaceId, controller.signal);
        if (mounted.current) {
          setSnapshot(next);
          setSelected(0);
          setPhase(next.hasModels ? 'models' : 'provider');
        }
      } else if (trusting && result.status === 'failed') setPhase('configuration-error');
      else apply(result);
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        generation === operationGeneration.current
      )
        setPhase('configuration-error');
    } finally {
      if (generation === operationGeneration.current) busy.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, [read]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onExit();
    if (phase === 'models') {
      const rows = snapshot?.models ?? [];
      if (key.escape) {
        onExit();
        return;
      }
      if (key.upArrow || key.downArrow)
        setSelected((value) =>
          Math.max(0, Math.min(rows.length, value + (key.downArrow ? 1 : -1))),
        );
      if (key.return) {
        const chosen = rows[selected];
        if (!chosen) {
          setSelected(0);
          setPhase('provider');
        } else if (chosen.configured)
          void run((signal) => port.selectModel(workspaceId, chosen.id, signal));
      }
    }
    if (phase === 'unknown' && key.return)
      void run((signal) =>
        canContinue ? port.resume(workspaceId, signal) : port.recover(workspaceId, signal),
      );
    if (phase === 'unknown' && key.escape) onExit();
  });
  const connect = (apiKey = form.apiKey, baseURL = form.baseURL, manual?: string) => {
    connectionPhase.current = 'publishing';
    return run((signal) =>
      port.connect(
        workspaceId,
        {
          provider: provider.type,
          apiKey,
          baseURL: baseURL || provider.defaultBaseURL,
          ...(manual ? { modelName: manual } : {}),
        },
        signal,
        (next) => {
          if (!signal.aborted) connectionPhase.current = next;
        },
      ),
    );
  };
  if (phase === 'loading')
    return (
      <FirstRunShell footer="">
        <Text>Loading configuration…</Text>
      </FirstRunShell>
    );
  if (phase === 'configuration-error')
    return (
      <ConfigErrorScreen
        configPath={path}
        message="Configuration is unavailable or has no usable default model. The original configuration remains unchanged."
        onRetry={() => void read()}
        onExit={onExit}
      />
    );
  if (phase === 'trust')
    return (
      <WorkspaceTrustGate
        path={path}
        readScopes={snapshot?.readScopes ?? []}
        onTrust={() => void run((signal) => port.trust(workspaceId, signal), true)}
        onExit={onExit}
      />
    );
  if (phase === 'trust-saving')
    return (
      <FirstRunShell footer="">
        <Text>Saving workspace trust…</Text>
      </FirstRunShell>
    );
  if (phase === 'models')
    return (
      <FirstRunShell
        title="Choose an existing model or configure a provider"
        footer="↑↓ Navigate   Enter Confirm   Esc Exit"
      >
        {(snapshot?.models ?? []).map((item, index) => (
          <Text key={item.id}>
            {selected === index ? '›' : ' '} {item.name}
            {item.configured ? (item.enabled ? '' : ' (enable and use)') : ' (needs configuration)'}
          </Text>
        ))}
        <Text>{selected === (snapshot?.models?.length ?? 0) ? '›' : ' '} Configure a provider</Text>
      </FirstRunShell>
    );
  if (phase === 'provider')
    return (
      <ProviderScreen
        selectedIndex={selected}
        onSelect={setSelected}
        onConfirm={(next) => {
          setProvider(next);
          setForm(
            cachedForms.current.get(next.type) ?? { apiKey: '', baseURL: next.defaultBaseURL },
          );
          setPhase('connection');
        }}
        onExit={onExit}
      />
    );
  if (phase === 'connecting')
    return (
      <ConnectionStatusScreen
        provider={provider}
        stage="models"
        onCancel={() => {
          ++operationGeneration.current;
          abort.current?.abort();
          busy.current = false;
          if (connectionPhase.current === 'publishing') {
            setCanContinue(false);
            setPhase('unknown');
          } else {
            setEditing(undefined);
            setPhase('connection');
          }
        }}
      />
    );
  if (phase === 'unknown')
    return (
      <FirstRunShell
        title="The original write needs confirmation"
        footer={`Enter ${canContinue ? 'Continue confirmed state' : 'Check original request'}   Esc Exit`}
      >
        <Text>
          {canContinue
            ? 'The original mutation is applied. Continue the remaining setup steps.'
            : 'The original outcome is pending or unknown. Checking does not send the write again.'}
        </Text>
      </FirstRunShell>
    );
  if (phase === 'manual')
    return (
      <ManualModelScreen
        modelName={modelName}
        onModelNameChange={setModelName}
        onSubmit={() => {
          if (modelName.trim()) void connect(undefined, undefined, modelName.trim());
        }}
        onBack={() => setPhase('connection')}
      />
    );
  if (phase === 'error')
    return (
      <ErrorScreen
        provider={provider}
        error={connectionError}
        selectedAction={selected}
        onSelectAction={setSelected}
        onConfirmAction={(index) => {
          const action = getErrorActions(connectionError, provider)[index]?.action;
          if (action === 'enter-model') setPhase('manual');
          else if (action === 'back-to-provider') setPhase('provider');
          else {
            setEditing(provider.connectionForm === 'custom-endpoint' ? 'baseURL' : 'apiKey');
            setPhase('connection');
          }
        }}
        onBack={() => setPhase('connection')}
        onExit={onExit}
      />
    );
  return (
    <ConnectionScreen
      provider={provider}
      form={form}
      editingField={editing}
      onEditingFieldChange={setEditing}
      onCancelEdit={(field, value) => {
        setForm((prior) => ({ ...prior, [field]: value }));
        setEditing(undefined);
      }}
      onUpdateField={(field, value) => setForm((prior) => ({ ...prior, [field]: value }))}
      onSubmit={(key, url) => void connect(key, url)}
      onBack={() => {
        cachedForms.current.set(provider.type, { ...form });
        setPhase('provider');
      }}
    />
  );
}
