import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAgentConfig, saveProviderConfig } from '#app/config';
import ConnectionScreen from './ConnectionScreen';
import ConnectionStatusScreen from './ConnectionStatusScreen';
import { connectProviderWithKey } from './connect-provider';
import ErrorScreen from './ErrorScreen';
import ManualModelScreen from './ManualModelScreen';
import ProviderScreen from './ProviderScreen';
import type { ConnectionFormState, FirstRunState, ProviderDefinition } from './types';
import { getErrorActions, PROVIDERS } from './types';

interface FirstRunFlowProps {
  onComplete: (result: { modelName: string }) => void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function FirstRunFlow({ onComplete }: FirstRunFlowProps) {
  const [state, setState] = useState<FirstRunState>({
    phase: 'provider',
    selectedIndex: 0,
  });

  // Disable terminal focus reporting — prevents \x1b[I/\x1b[O focus events
  // from leaking into useInput as stray 'I'/'O' characters.
  useEffect(() => {
    process.stdout.write('\x1b[?1004l');
    return () => {
      process.stdout.write('\x1b[?1004h');
    };
  }, []);

  const connectAbortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const cachedFormRef = useRef<ConnectionFormState>({ apiKey: '', baseURL: '' });
  const cachedProviderTypeRef = useRef<string>('');
  const stateRef = useRef(state);
  stateRef.current = state;

  const transition = useCallback((next: FirstRunState) => {
    const cur = stateRef.current;
    if (next.phase !== 'connection' && cur.phase === 'connection' && 'form' in cur) {
      cachedFormRef.current = { ...cur.form };
      cachedProviderTypeRef.current = cur.provider.type;
    }
    setState(next);
  }, []);

  const handleProviderSelect = useCallback(
    (provider: ProviderDefinition) => {
      // Only restore cached form if returning to the SAME provider
      const cached = cachedFormRef.current;
      const form =
        cachedProviderTypeRef.current === provider.type &&
        (cached.apiKey || cached.baseURL !== provider.defaultBaseURL)
          ? { ...cached }
          : { apiKey: '', baseURL: provider.defaultBaseURL };
      transition({
        phase: 'connection',
        provider,
        form,
        editingField: undefined,
      });
    },
    [transition],
  );

  const handleConnect = useCallback(
    async (apiKey: string, baseURL: string) => {
      const cur = stateRef.current;
      if (cur.phase !== 'connection') return;

      if (cur.provider.apiKey !== 'optional' && !apiKey.trim()) {
        transition({
          ...cur,
          error: 'API key cannot be empty',
        });
        return;
      }

      const controller = new AbortController();
      connectAbortRef.current?.abort();
      connectAbortRef.current = controller;
      cancelledRef.current = false;

      transition({
        phase: 'connecting',
        provider: cur.provider,
        stage: 'credentials',
      });

      const stageTimer = setTimeout(() => {
        if (!controller.signal.aborted) {
          transition({
            phase: 'connecting',
            provider: cur.provider,
            stage: 'models',
          });
        }
      }, 1500);

      try {
        const result = await connectProviderWithKey(
          cur.provider,
          apiKey,
          baseURL,
          controller.signal,
        );
        clearTimeout(stageTimer);
        if (controller.signal.aborted) return;

        if (result.status === 'connected') {
          transition({
            phase: 'complete',
            provider: cur.provider,
            modelName: result.modelName,
          });
          try {
            const cfg = loadAgentConfig({ modelName: result.modelName });
            onComplete({ modelName: cfg.modelName });
          } catch {
            onComplete({ modelName: result.modelName });
          }
        } else if (result.status === 'model-required') {
          transition({
            phase: 'manual-model',
            provider: cur.provider,
            modelName: '',
            apiKey,
            baseURL,
          });
        } else {
          transition({
            phase: 'error',
            provider: cur.provider,
            error: result.error,
            selectedAction: 0,
          });
        }
      } catch (err: unknown) {
        clearTimeout(stageTimer);
        if (controller.signal.aborted || cancelledRef.current) return;
        const messageText = toErrorMessage(err);
        const message = messageText.includes('requires apiKey')
          ? 'The API key was rejected.'
          : messageText.includes('baseURL')
            ? 'Check the endpoint address.'
            : messageText;
        transition({
          phase: 'error',
          provider: cur.provider,
          error: { kind: 'generic', message },
          selectedAction: 0,
        });
      }
    },
    [transition, onComplete],
  );

  const handleErrorAction = useCallback(
    (actionIndex: number) => {
      const cur = stateRef.current;
      if (cur.phase !== 'error') return;
      const { provider, error } = cur;
      const actionDefs = getErrorActions(error);
      const actionDef = actionDefs[actionIndex];
      if (!actionDef) return;

      switch (actionDef.action) {
        case 'edit-key':
        case 'edit-settings':
          transition({
            phase: 'connection',
            provider,
            form: { ...cachedFormRef.current },
            editingField: actionDef.action === 'edit-key' ? undefined : 'baseURL',
          });
          break;
        case 'try-again':
          transition({
            phase: 'connection',
            provider,
            form: { ...cachedFormRef.current },
          });
          break;
        case 'enter-model':
          transition({
            phase: 'manual-model',
            provider,
            modelName: '',
            apiKey: cachedFormRef.current.apiKey,
            baseURL: cachedFormRef.current.baseURL || provider.defaultBaseURL,
          });
          break;
        case 'back-to-provider': {
          const idx = PROVIDERS.indexOf(provider);
          transition({ phase: 'provider', selectedIndex: idx >= 0 ? idx : 0 });
          break;
        }
        case 'back-to-connection':
          transition({
            phase: 'connection',
            provider,
            form: { ...cachedFormRef.current },
          });
          break;
        case 'exit':
          process.exit(0);
      }
    },
    [transition],
  );

  const handleManualModelSubmit = useCallback(
    (modelName: string) => {
      const cur = stateRef.current;
      if (!modelName.trim() || cur.phase !== 'manual-model') return;
      const name = modelName.trim();
      saveProviderConfig({
        name: cur.provider.type,
        type: cur.provider.type,
        apiKey: cur.apiKey || undefined,
        baseURL: cur.baseURL !== cur.provider.defaultBaseURL ? cur.baseURL : undefined,
        models: [{ name, default: true }],
        reasoning: cur.provider.defaultReasoning === 'on',
        effort: cur.provider.defaultReasoning === 'on' ? 'max' : undefined,
      });
      try {
        const cfg = loadAgentConfig({ modelName: name });
        onComplete({ modelName: cfg.modelName });
      } catch (err: unknown) {
        transition({
          phase: 'error',
          provider: cur.provider,
          error: {
            kind: 'generic',
            message: toErrorMessage(err) || 'Configuration error',
          },
          selectedAction: 0,
        });
      }
    },
    [onComplete, transition],
  );

  const handleConnectionBack = useCallback(() => {
    const cur = stateRef.current;
    if (cur.phase !== 'connection') return;
    const idx = PROVIDERS.indexOf(cur.provider);
    transition({ phase: 'provider', selectedIndex: idx >= 0 ? idx : 0 });
  }, [transition]);

  const handleEditingFieldChange = useCallback(
    (field?: string) => {
      const cur = stateRef.current;
      if (cur.phase !== 'connection') return;
      transition({ ...cur, editingField: field });
    },
    [transition],
  );

  const handleCancelEdit = useCallback(
    (field: string, restoreValue: string) => {
      const cur = stateRef.current;
      if (cur.phase !== 'connection') return;
      transition({
        ...cur,
        editingField: undefined,
        form: { ...cur.form, [field]: restoreValue },
      });
    },
    [transition],
  );

  const handleUpdateField = useCallback(
    (field: keyof ConnectionFormState, value: string) => {
      const cur = stateRef.current;
      if (cur.phase !== 'connection') return;
      transition({ ...cur, form: { ...cur.form, [field]: value } });
    },
    [transition],
  );

  switch (state.phase) {
    case 'provider':
      return (
        <ProviderScreen
          key="provider"
          selectedIndex={state.selectedIndex}
          onSelect={(i) => transition({ phase: 'provider', selectedIndex: i })}
          onConfirm={handleProviderSelect}
        />
      );

    case 'connection':
      return (
        <ConnectionScreen
          key={`connection-${state.provider.type}`}
          provider={state.provider}
          form={state.form}
          editingField={state.editingField}
          error={state.error}
          onEditingFieldChange={handleEditingFieldChange}
          onCancelEdit={handleCancelEdit}
          onSubmit={handleConnect}
          onBack={handleConnectionBack}
          onUpdateField={handleUpdateField}
        />
      );

    case 'connecting':
      return (
        <ConnectionStatusScreen
          provider={state.provider}
          stage={state.stage}
          onCancel={() => {
            cancelledRef.current = true;
            connectAbortRef.current?.abort();
            transition({
              phase: 'connection',
              provider: state.provider,
              form: { ...cachedFormRef.current },
              editingField: undefined,
            });
          }}
        />
      );

    case 'manual-model':
      return (
        <ManualModelScreen
          modelName={state.modelName}
          onModelNameChange={(name) => {
            if (state.phase === 'manual-model') {
              transition({ ...state, modelName: name });
            }
          }}
          onSubmit={() => handleManualModelSubmit(state.modelName)}
          onBack={() => {
            if (state.phase === 'manual-model') {
              transition({
                phase: 'connection',
                provider: state.provider,
                form: { ...cachedFormRef.current },
              });
            }
          }}
        />
      );

    case 'error':
      return (
        <ErrorScreen
          provider={state.provider}
          error={state.error}
          selectedAction={state.selectedAction}
          onSelectAction={(i) => {
            if (state.phase === 'error') {
              transition({ ...state, selectedAction: i });
            }
          }}
          onConfirmAction={handleErrorAction}
          onBack={() => {
            if (state.phase === 'error') {
              transition({
                phase: 'connection',
                provider: state.provider,
                form: { ...cachedFormRef.current },
              });
            }
          }}
        />
      );

    case 'complete':
      return null;
  }
}
