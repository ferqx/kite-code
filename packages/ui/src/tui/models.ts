import type { HostMutation, ModelSettingsRequest, ModelSettingsView } from '@kite-ai/client';
export interface TuiModelIntent {
  sessionId: string;
  scope: 'workspace';
  request: ModelSettingsRequest;
}
export interface TuiModelOutcome {
  intent: TuiModelIntent;
  status: HostMutation['state'] | 'outcome_unknown';
  mutation?: HostMutation;
}
export interface TuiModelPort {
  read(workspaceId: string, signal: AbortSignal): Promise<ModelSettingsView>;
  submit(intent: TuiModelIntent): Promise<TuiModelOutcome>;
  lookup(intent: TuiModelIntent): Promise<TuiModelOutcome>;
}
