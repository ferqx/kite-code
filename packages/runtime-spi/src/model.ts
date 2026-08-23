import type { RuntimeJsonValue } from './capability';
import type { ExecutionReceipt } from './execution';

export interface ContextSourceRequest {
  readonly sessionId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly committedFacts: Readonly<Record<string, RuntimeJsonValue>>;
}

export interface ContextFragmentCandidate {
  readonly fragmentId: string;
  readonly kind: string;
  readonly authority: 'runtime' | 'project' | 'user' | 'external';
  readonly content: RuntimeJsonValue;
  readonly tokenEstimate: number;
  readonly disclosure: 'always' | 'selected' | 'on_demand';
}

export interface ContextSource {
  readonly sourceId: string;
  readonly revision: string;
  readonly providerId: string;
  collect(request: ContextSourceRequest): readonly ContextFragmentCandidate[];
}

export interface ContextCompilerRequest {
  readonly purpose: string;
  readonly tokenBudget: number;
  readonly candidates: readonly ContextFragmentCandidate[];
}

export interface CompiledContext {
  readonly selectedFragmentIds: readonly string[];
  readonly payload: RuntimeJsonValue;
}

export interface ContextCompilerPort {
  readonly compilerId: string;
  readonly revision: string;
  compile(request: ContextCompilerRequest): Promise<CompiledContext>;
}

export interface RuntimeReceiptNormalizer {
  readonly normalizerId: string;
  readonly revision: string;
  normalize(receipt: ExecutionReceipt): ExecutionReceipt;
}
