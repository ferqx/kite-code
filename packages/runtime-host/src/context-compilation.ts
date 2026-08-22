import type {
  CapabilityRegistrySnapshotV1,
  CompiledContextV1,
  ContextCompilerPortV1,
  ContextFragmentCandidateV1,
  RuntimeJsonValueV1,
  RuntimeModuleRegistryV1,
} from '@kite/runtime-spi';

export interface RuntimeHostContextCompilationRequestV1 {
  readonly sessionId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly tokenBudget: number;
  readonly committedFacts: Readonly<Record<string, RuntimeJsonValueV1>>;
}

export interface RuntimeHostContextCompilationPortV1 {
  compile(request: RuntimeHostContextCompilationRequestV1): Promise<CompiledContextV1>;
}

/** Host mechanism only: collect registered pure projections, validate bounds, then call Builtin. */
export function createRuntimeHostContextCompilationPortV1(
  registry: RuntimeModuleRegistryV1,
  compiler: ContextCompilerPortV1,
): RuntimeHostContextCompilationPortV1 {
  return createRuntimeHostContextCompilationPortFromSnapshotV1(
    registry,
    compiler,
    registry.snapshot(),
  );
}

/** Internal Host seam that reuses the Host's single immutable registry snapshot. */
export function createRuntimeHostContextCompilationPortFromSnapshotV1(
  registry: RuntimeModuleRegistryV1,
  compiler: ContextCompilerPortV1,
  snapshot: Readonly<CapabilityRegistrySnapshotV1>,
): RuntimeHostContextCompilationPortV1 {
  const sources = Object.freeze(
    snapshot.contextSources
      .map(({ sourceId }) => registry.contextSource(sourceId))
      .filter((source) => source !== undefined),
  );
  return Object.freeze({
    async compile(request: RuntimeHostContextCompilationRequestV1): Promise<CompiledContextV1> {
      if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0) {
        throw new Error('Runtime Host requires a positive integer Context token budget.');
      }
      if (!request.projectId.startsWith('project_')) {
        throw new Error('Runtime Host requires a Host-issued Context Project identity.');
      }
      const candidates = Object.freeze(
        sources.flatMap((source) =>
          source.collect({
            sessionId: request.sessionId,
            projectId: request.projectId,
            purpose: request.purpose,
            committedFacts: request.committedFacts,
          }),
        ),
      );
      validateCandidatesV1(candidates);
      const compiled = await compiler.compile({
        purpose: request.purpose,
        tokenBudget: request.tokenBudget,
        candidates,
      });
      validateCompiledContextV1(compiled, candidates, request.tokenBudget);
      return compiled;
    },
  });
}

function validateCandidatesV1(candidates: readonly ContextFragmentCandidateV1[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate.fragmentId ||
      seen.has(candidate.fragmentId) ||
      !Number.isSafeInteger(candidate.tokenEstimate) ||
      candidate.tokenEstimate <= 0 ||
      !isRuntimeJsonValueV1(candidate.content)
    ) {
      throw new Error(`Runtime Context candidate is invalid: ${candidate.fragmentId || '<empty>'}`);
    }
    seen.add(candidate.fragmentId);
  }
}

function validateCompiledContextV1(
  compiled: CompiledContextV1,
  candidates: readonly ContextFragmentCandidateV1[],
  tokenBudget: number,
): void {
  const byId = new Map(candidates.map((candidate) => [candidate.fragmentId, candidate]));
  const selected = new Set<string>();
  let tokens = 0;
  for (const fragmentId of compiled.selectedFragmentIds) {
    const candidate = byId.get(fragmentId);
    if (!candidate || selected.has(fragmentId)) {
      throw new Error(`Context Compiler selected an invalid fragment: ${fragmentId}`);
    }
    selected.add(fragmentId);
    tokens += candidate.tokenEstimate;
  }
  if (tokens > tokenBudget || !isRuntimeJsonValueV1(compiled.payload)) {
    throw new Error('Context Compiler returned an invalid or over-budget payload.');
  }
}

function isRuntimeJsonValueV1(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isRuntimeJsonValueV1(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isRuntimeJsonValueV1(item, seen));
  seen.delete(value);
  return valid;
}
