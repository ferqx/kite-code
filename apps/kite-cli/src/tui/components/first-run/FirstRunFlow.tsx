import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type { NativeProviderCredentialClient } from '@kite-ai/kite-local-runtime/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import ConnectionScreen from './ConnectionScreen';
import ConnectionStatusScreen from './ConnectionStatusScreen';
import {
  connectProviderWithKey,
  type FirstRunProviderClients,
  saveManualProviderModel,
} from './connect-provider';
import ErrorScreen from './ErrorScreen';
import ManualModelScreen from './ManualModelScreen';
import ProviderScreen from './ProviderScreen';
import type { ConnectionFormState, FirstRunState, ProviderDefinition } from './types';
import { getErrorActions, PROVIDERS } from './types';

interface FirstRunFlowProps {
  onComplete: (result: { modelName: string }) => void;
  /** Native credential and workspace-scoped App Control capabilities are injected by composition. */
  appControl?: KiteAppControlClient;
  credentialClient?: NativeProviderCredentialClient;
  workspace?: KiteWorkspaceIdentity;
  onExit?: () => void;
}

export default function FirstRunFlow({
  onComplete,
  appControl,
  credentialClient,
  workspace,
  onExit = () => undefined,
}: FirstRunFlowProps) {
  const clients: FirstRunProviderClients | undefined =
    appControl && credentialClient && workspace
      ? { appControl, credentialClient, workspace }
      : undefined;
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

      if (!clients) {
        transition({
          phase: 'error',
          provider: cur.provider,
          error: {
            kind: 'generic',
            message: 'First-run credential and App Control clients are unavailable.',
          },
          selectedAction: 0,
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
          clients,
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
          onComplete({ modelName: result.modelName });
        } else if (result.status === 'model-required') {
          transition({
            phase: 'manual-model',
            provider: cur.provider,
            modelName: '',
            apiKey,
            baseURL,
          });
        } else if (result.status === 'outcome-unknown') {
          transition({
            phase: 'error',
            provider: cur.provider,
            error: {
              kind: 'outcome-unknown',
              message:
                'The credential write outcome is unknown. Review the confirmed provider state before continuing.',
              ...(result.modelName === undefined ? {} : { confirmedModelName: result.modelName }),
            },
            selectedAction: 0,
          });
        } else {
          transition({
            phase: 'error',
            provider: cur.provider,
            error: result.error,
            selectedAction: 0,
          });
        }
      } catch {
        clearTimeout(stageTimer);
        if (controller.signal.aborted || cancelledRef.current) return;
        transition({
          phase: 'error',
          provider: cur.provider,
          error: { kind: 'generic', message: 'The provider connection could not be completed.' },
          selectedAction: 0,
        });
      }
    },
    [clients, transition, onComplete],
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
        case 'continue-confirmed':
          if (error.confirmedModelName) {
            transition({
              phase: 'complete',
              provider,
              modelName: error.confirmedModelName,
            });
            onComplete({ modelName: error.confirmedModelName });
          }
          break;
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
          connectAbortRef.current?.abort('first-run-exit');
          onExit();
      }
    },
    [onComplete, onExit, transition],
  );

  const handleManualModelSubmit = useCallback(
    async (modelName: string) => {
      const cur = stateRef.current;
      if (!modelName.trim() || cur.phase !== 'manual-model') return;
      const name = modelName.trim();
      if (!clients) {
        transition({
          phase: 'error',
          provider: cur.provider,
          error: {
            kind: 'generic',
            message: 'First-run credential and App Control clients are unavailable.',
          },
          selectedAction: 0,
        });
        return;
      }

      const controller = new AbortController();
      connectAbortRef.current?.abort();
      connectAbortRef.current = controller;
      cancelledRef.current = false;
      transition({ phase: 'connecting', provider: cur.provider, stage: 'credentials' });

      try {
        const result = await saveManualProviderModel(
          cur.provider,
          cur.apiKey,
          cur.baseURL,
          name,
          clients,
          controller.signal,
        );
        if (controller.signal.aborted || cancelledRef.current) return;
        if (result.status === 'connected') {
          transition({ phase: 'complete', provider: cur.provider, modelName: result.modelName });
          onComplete({ modelName: result.modelName });
          return;
        }
        if (result.status === 'outcome-unknown') {
          transition({
            phase: 'error',
            provider: cur.provider,
            error: {
              kind: 'outcome-unknown',
              message:
                'The credential write outcome is unknown. Review the confirmed provider state before continuing.',
              ...(result.modelName === undefined ? {} : { confirmedModelName: result.modelName }),
            },
            selectedAction: 0,
          });
          return;
        }
        if (result.status === 'model-required') {
          transition({ ...cur, modelName: name });
          return;
        }
        transition({
          phase: 'error',
          provider: cur.provider,
          error: result.error,
          selectedAction: 0,
        });
      } catch {
        if (controller.signal.aborted || cancelledRef.current) return;
        transition({
          phase: 'error',
          provider: cur.provider,
          error: { kind: 'generic', message: 'The provider connection could not be completed.' },
          selectedAction: 0,
        });
      }
    },
    [clients, onComplete, transition],
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
          onExit={onExit}
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
          onExit={onExit}
        />
      );

    case 'complete':
      return null;
  }
}
