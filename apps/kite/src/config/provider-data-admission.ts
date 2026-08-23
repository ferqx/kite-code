import { createModelSecretDetector, type ModelSecretInspection } from '@kite/builtin-runtime/model';
import type { ModelProviderDispatchPurpose } from '@kite/runtime-spi';
import type { AgentConfig } from './index';

export type ProviderPayloadKind = 'user_prompt' | 'file_snippet' | 'tool_result' | 'summary';
export type ProviderDispatchPurpose = ModelProviderDispatchPurpose;

export interface WorkspaceDataLabel {
  classification: 'public' | 'internal' | 'confidential' | 'secret';
  source: 'artifact' | 'admin' | 'project_raise_only' | 'runtime_secret_detector';
  provenance: 'user_prompt' | 'workspace_file' | 'tool_result' | 'generated_summary';
  canonicalPathDigest?: string;
}

export interface ProviderPayloadPart {
  kind: ProviderPayloadKind;
  text: string;
  label: WorkspaceDataLabel;
}

export type ProviderDataAdmissionReason =
  | 'admitted'
  | 'mandatory_policy_unavailable'
  | 'provider_content_inspection_unknown'
  | 'provider_secret_denied';

export interface ProviderDataAdmissionDecision {
  admitted: boolean;
  reason: ProviderDataAdmissionReason;
  routeAlias: string;
  admissionRevision?: string;
}

export type SessionLoggingContentInspector = (input: {
  text: string;
  provenance: 'user_message' | 'model_visible_answer';
}) => ModelSecretInspection;

export type ProviderDataAdmissionGate = (
  payload: ProviderPayloadPart[],
  purpose?: ProviderDispatchPurpose,
) => ProviderDataAdmissionDecision;

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_=-]{16,}\b/,
] as const;
const PROTECTED_PATH_PATTERN =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.kube|credentials?|secrets?)(?:$|[/\\])/i;

function hasSecretMarker(part: ProviderPayloadPart): boolean {
  return (
    part.label.classification === 'secret' ||
    part.label.source === 'runtime_secret_detector' ||
    PROTECTED_PATH_PATTERN.test(part.text) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(part.text))
  );
}

function routeAlias(config: AgentConfig): string {
  return `${config.providerType}:${config.providerName}:${config.modelName}`;
}

/** Fail closed only when the production composition omitted this required boundary. */
export const denyMissingProviderDataAdmission: ProviderDataAdmissionGate = () => ({
  admitted: false,
  reason: 'mandatory_policy_unavailable',
  routeAlias: 'unresolved',
});

/**
 * Admit the provider selected by the user's resolved configuration while
 * keeping raw credential material and obvious local secrets out of payloads.
 */
export function createApprovedProviderDataAdmission(
  config: AgentConfig,
  _loadedAt = new Date(),
  contentInspector: SessionLoggingContentInspector = createModelSecretDetector({
    knownSecrets: [config.apiKey],
  }),
): ProviderDataAdmissionGate {
  const alias = routeAlias(config);
  return (payload) => {
    if (payload.some(hasSecretMarker)) {
      return { admitted: false, reason: 'provider_secret_denied', routeAlias: alias };
    }
    for (const part of payload) {
      let verdict: ModelSecretInspection['verdict'] = 'unknown';
      try {
        verdict = contentInspector({
          text: part.text,
          provenance:
            part.label.provenance === 'generated_summary' ? 'model_visible_answer' : 'user_message',
        }).verdict;
      } catch {
        verdict = 'unknown';
      }
      if (verdict !== 'clear') {
        return {
          admitted: false,
          reason:
            verdict === 'secret' ? 'provider_secret_denied' : 'provider_content_inspection_unknown',
          routeAlias: alias,
        };
      }
    }
    return {
      admitted: true,
      reason: 'admitted',
      routeAlias: alias,
      admissionRevision: 'configured-provider',
    };
  };
}

export {
  ProviderDataAdmissionError,
  providerPayloadFromModelPrompt,
} from '@kite/builtin-runtime/model';
