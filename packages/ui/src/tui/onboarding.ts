export type TuiOnboardingProvider = 'deepseek' | 'openai' | 'compatible';
export type TuiOnboardingSnapshot = {
  observer?: 'workspace_missing';
  trusted: boolean;
  readScopes: readonly { kind: string; description: string }[];
  modelName?: string;
  hasModels: boolean;
  models?: readonly { id: string; name: string; enabled: boolean; configured: boolean }[];
};
export type TuiOnboardingResult =
  | { status: 'ready'; modelName: string }
  | { status: 'model-required'; stage?: 'provider' }
  | { status: 'unknown'; canContinue?: boolean }
  | { status: 'cancelled' }
  | { status: 'failed'; code: string };
export type TuiOnboardingConnection = {
  provider: TuiOnboardingProvider;
  apiKey: string;
  baseURL: string;
  modelName?: string;
};
export type TuiOnboardingConnectPhase = 'discovering' | 'publishing';
export interface TuiOnboardingPort {
  read(workspaceId: string, signal?: AbortSignal): Promise<TuiOnboardingSnapshot>;
  trust(workspaceId: string, signal?: AbortSignal): Promise<TuiOnboardingResult>;
  selectModel(
    workspaceId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<TuiOnboardingResult>;
  connect(
    workspaceId: string,
    input: TuiOnboardingConnection,
    signal?: AbortSignal,
    onPhase?: (phase: TuiOnboardingConnectPhase) => void,
  ): Promise<TuiOnboardingResult>;
  /** Reads only the original mutation. Never repeats a write after an unknown result. */
  recover(workspaceId: string, signal?: AbortSignal): Promise<TuiOnboardingResult>;
  /** User explicitly continues the remaining legs after the original mutation is applied. */
  resume(workspaceId: string, signal?: AbortSignal): Promise<TuiOnboardingResult>;
}
