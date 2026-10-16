/** User-selectable levels. Ultar is an explicit Kite wire value, not an inferred Provider alias. */
export const reasoningEffortLevels = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultar',
] as const);
/** Keep existing configuration and recorded requests valid without offering extra UI levels. */
export const reasoningEfforts = Object.freeze([
  'none',
  'minimal',
  ...reasoningEffortLevels,
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
