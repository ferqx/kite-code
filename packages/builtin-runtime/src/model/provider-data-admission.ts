import type { ModelProviderDispatchPurposeV1 } from '@kite/runtime-spi';

export type ProviderPayloadKindV1 = 'user_prompt' | 'file_snippet' | 'tool_result' | 'summary';

export interface ProviderPayloadPartV1 {
  kind: ProviderPayloadKindV1;
  text: string;
  label: {
    classification: 'public' | 'internal' | 'confidential' | 'secret';
    source: 'artifact' | 'admin' | 'project_raise_only' | 'runtime_secret_detector';
    provenance: 'user_prompt' | 'workspace_file' | 'tool_result' | 'generated_summary';
    canonicalPathDigest?: string;
  };
}

export type ProviderDataAdmissionReasonV1 =
  | 'admitted'
  | 'mandatory_policy_unavailable'
  | 'provider_content_inspection_unknown'
  | 'provider_secret_denied';

export interface ProviderDataAdmissionDecisionV1 {
  admitted: boolean;
  reason: ProviderDataAdmissionReasonV1;
  routeAlias: string;
  admissionRevision?: string;
}

export type ProviderDataAdmissionGateV1 = (
  payload: ProviderPayloadPartV1[],
  purpose?: ModelProviderDispatchPurposeV1,
) => ProviderDataAdmissionDecisionV1;

function promptPartText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object') {
    if ('text' in part && typeof part.text === 'string') return part.text;
    if ('output' in part && typeof part.output === 'string') return part.output;
  }
  return JSON.stringify(part) ?? '';
}

/** Build provenance-bearing admission parts without mutating the provider prompt. */
export function providerPayloadFromModelPromptV1(
  prompt: readonly unknown[],
): ProviderPayloadPartV1[] {
  return prompt.flatMap((value) => {
    const message =
      value && typeof value === 'object' ? (value as Record<string, unknown>) : { content: value };
    const rawRole =
      typeof message.role === 'string'
        ? message.role
        : typeof message._getType === 'function'
          ? String((message._getType as () => unknown)())
          : typeof message.type === 'string'
            ? message.type
            : 'user';
    const role = rawRole === 'human' ? 'user' : rawRole === 'ai' ? 'assistant' : rawRole;
    const content = Array.isArray(message.content) ? message.content : [message.content];
    return content.map((part) => ({
      kind:
        role === 'tool'
          ? ('tool_result' as const)
          : role === 'system' || role === 'assistant'
            ? ('summary' as const)
            : ('user_prompt' as const),
      text: promptPartText(part),
      label: {
        classification:
          role === 'system' || role === 'assistant'
            ? ('internal' as const)
            : ('confidential' as const),
        source: 'artifact' as const,
        provenance:
          role === 'tool'
            ? ('tool_result' as const)
            : role === 'system' || role === 'assistant'
              ? ('generated_summary' as const)
              : ('user_prompt' as const),
      },
    }));
  });
}

export class ProviderDataAdmissionError extends Error {
  readonly decision: ProviderDataAdmissionDecisionV1;
  readonly knownExternalEffects: 'none' | 'unknown';

  constructor(
    decision: ProviderDataAdmissionDecisionV1,
    options: { knownExternalEffects?: 'none' | 'unknown' } = {},
  ) {
    super(`Provider data admission denied: ${decision.reason}.`);
    this.name = 'ProviderDataAdmissionError';
    this.decision = decision;
    this.knownExternalEffects = options.knownExternalEffects ?? 'none';
  }
}
