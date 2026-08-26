import type { AppModelProviderType } from '@kite-ai/kite-app-contract';

export interface ProviderDefinition {
  type: AppModelProviderType;
  label: string;
  description?: string;
  defaultBaseURL: string;
  connectionForm: 'api-key' | 'ollama' | 'custom-endpoint';
  apiKey: 'required' | 'optional' | 'none';
  supportsModelDiscovery: boolean;
  recommendedModels: string[];
  defaultReasoning: 'automatic' | 'on' | 'off';
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    connectionForm: 'api-key',
    apiKey: 'required',
    supportsModelDiscovery: true,
    recommendedModels: [],
    defaultReasoning: 'automatic',
  },
  {
    type: 'openai',
    label: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    connectionForm: 'api-key',
    apiKey: 'required',
    supportsModelDiscovery: true,
    recommendedModels: [],
    defaultReasoning: 'automatic',
  },
  {
    type: 'openai-compatible',
    label: 'Custom endpoint',
    description: 'Self-hosted or compatible',
    defaultBaseURL: 'http://localhost:8080/v1',
    connectionForm: 'custom-endpoint',
    apiKey: 'optional',
    supportsModelDiscovery: true,
    recommendedModels: [],
    defaultReasoning: 'automatic',
  },
];

export interface ConnectionFormState {
  apiKey: string;
  baseURL: string;
}

export interface ConnectionError {
  kind: 'auth' | 'unreachable' | 'incompatible' | 'timeout' | 'outcome-unknown' | 'generic';
  message: string;
  details?: string;
  /** Present only when a post-unknown state query found a ready route. */
  confirmedModelName?: string;
}

export type ErrorAction =
  | 'edit-key'
  | 'edit-settings'
  | 'continue-confirmed'
  | 'try-again'
  | 'enter-model'
  | 'back-to-provider'
  | 'back-to-connection'
  | 'exit';

export interface ErrorActionDef {
  action: ErrorAction;
  label: string;
}

export type FirstRunState =
  | {
      phase: 'provider';
      selectedIndex: number;
    }
  | {
      phase: 'connection';
      provider: ProviderDefinition;
      form: ConnectionFormState;
      editingField?: string;
      error?: string;
    }
  | {
      phase: 'connecting';
      provider: ProviderDefinition;
      stage: 'credentials' | 'models';
    }
  | {
      phase: 'manual-model';
      provider: ProviderDefinition;
      modelName: string;
      apiKey: string;
      baseURL: string;
    }
  | {
      phase: 'error';
      provider: ProviderDefinition;
      error: ConnectionError;
      selectedAction: number;
    }
  | {
      phase: 'complete';
      provider: ProviderDefinition;
      modelName: string;
    };

export type ConnectProviderResult =
  | {
      status: 'connected';
      modelName: string;
    }
  | {
      status: 'model-required';
      message: string;
    }
  | {
      status: 'failed';
      error: ConnectionError;
    }
  | {
      /** The mutation result was unknown; any continuation must be explicit. */
      status: 'outcome-unknown';
      modelName?: string;
      message: string;
    };

export interface ConnectProviderInput {
  provider: ProviderDefinition;
  signal?: AbortSignal;
}

export function classifyError(
  status: number | null | undefined,
  message: string,
  url: string,
): ConnectionError {
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message,
      details: 'The API key was rejected.',
    };
  }
  if (
    message.includes('fetch') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('timed out')
  ) {
    return {
      kind: 'unreachable',
      message,
      details: url,
    };
  }
  return {
    kind: 'incompatible',
    message,
  };
}

export function getErrorActions(error: ConnectionError): ErrorActionDef[] {
  switch (error.kind) {
    case 'auth':
      return [
        { action: 'edit-key', label: 'Edit API key' },
        { action: 'back-to-provider', label: 'Choose another provider' },
      ];
    case 'unreachable':
      return [
        { action: 'edit-settings', label: 'Edit connection settings' },
        { action: 'back-to-provider', label: 'Choose another provider' },
      ];
    case 'incompatible':
      return [
        { action: 'enter-model', label: 'Enter a model name' },
        { action: 'edit-settings', label: 'Edit connection settings' },
        { action: 'back-to-provider', label: 'Choose another provider' },
      ];
    case 'outcome-unknown':
      return [
        ...(error.confirmedModelName
          ? [{ action: 'continue-confirmed' as const, label: 'Continue with confirmed state' }]
          : []),
        { action: 'edit-settings', label: 'Review connection settings' },
        { action: 'back-to-provider', label: 'Choose another provider' },
      ];
    default:
      return [
        { action: 'edit-settings', label: 'Edit connection settings' },
        { action: 'back-to-provider', label: 'Choose another provider' },
      ];
  }
}

export interface AvailableModel {
  name: string;
  default?: boolean;
}

export function chooseInitialModel(
  provider: ProviderDefinition,
  models: AvailableModel[],
): AvailableModel | null {
  const declaredDefault = models.find((model) => model.default);
  if (declaredDefault) return declaredDefault;

  for (const recommendedName of provider.recommendedModels) {
    const recommended = models.find((model) => model.name === recommendedName);
    if (recommended) return recommended;
  }

  return models[0] ?? null;
}
