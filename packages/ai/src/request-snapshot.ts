/** Finite wire values supported by this compatible transport; remote model support is separate. */
export const reasoningEfforts = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);
export type ReasoningEffort = (typeof reasoningEfforts)[number];
/** Non-secret facts about the adapter's actual prepared request. No endpoint, headers or credentials. */
export interface ModelAdapterSnapshot {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly provider:
    | { readonly availability: 'available'; readonly family: string; readonly modelId: string }
    | { readonly availability: 'unavailable'; readonly reason: string };
  readonly settings: {
    readonly reasoningEffort?: ReasoningEffort;
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxOutputTokens?: number;
    readonly maxRetries: number;
    readonly maxSteps: number;
    readonly allowSystemInMessages: boolean;
    readonly includeUsage?: boolean;
  };
  readonly transformation: { readonly id: string; readonly version: string };
}
