import type {
  CompiledContext,
  ContextCompilerPort,
  ContextFragmentCandidate,
  ContextSource,
  ContextSourceRequest,
  RuntimeJsonValue,
  RuntimeModuleRegistryWriter,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from './capability-binding';
import { MODEL_PROVIDER_ID_ } from './model/runtime-module';

export const BUILTIN_CONTEXT_SOURCE_IDS_ = Object.freeze([
  'builtin:project-instructions-context',
  'builtin:skill-context',
  'builtin:mcp-observation-context',
] as const);

export const BUILTIN_CONTEXT_COMPILER_ID_ = 'kite-builtin-context-compiler' as const;
export const BUILTIN_CONTEXT_COMPILER_REVISION_ = digestCapabilityBindingValue({
  schema: 'kite.builtin-context-compiler.v1',
  selection: 'always-then-selected-in-source-order',
  onDemand: 'excluded',
});

type BuiltinContextSourceDefinition = Readonly<{
  sourceId: (typeof BUILTIN_CONTEXT_SOURCE_IDS_)[number];
  factKey: string;
  kind: 'project_instruction' | 'skill_instruction' | 'external_content';
  authority: 'project' | 'user' | 'external';
}>;

const SOURCE_DEFINITIONS_: readonly BuiltinContextSourceDefinition[] = Object.freeze([
  Object.freeze({
    sourceId: 'builtin:project-instructions-context',
    factKey: 'projectInstructionFragments',
    kind: 'project_instruction',
    authority: 'project',
  }),
  Object.freeze({
    sourceId: 'builtin:skill-context',
    factKey: 'skillContextFragments',
    kind: 'skill_instruction',
    authority: 'user',
  }),
  Object.freeze({
    sourceId: 'builtin:mcp-observation-context',
    factKey: 'mcpObservationFragments',
    kind: 'external_content',
    authority: 'external',
  }),
]);

export function registerBuiltinContextSources(registry: RuntimeModuleRegistryWriter): void {
  for (const definition of SOURCE_DEFINITIONS_) {
    registry.registerContextSource(createBuiltinContextSource(definition));
  }
}

export function createBuiltinContextCompilerPort(): ContextCompilerPort {
  return Object.freeze({
    compilerId: BUILTIN_CONTEXT_COMPILER_ID_,
    revision: BUILTIN_CONTEXT_COMPILER_REVISION_,
    async compile(
      request: Parameters<ContextCompilerPort['compile']>[0],
    ): Promise<CompiledContext> {
      if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0) {
        throw new Error('Builtin Context Compiler requires a positive integer token budget.');
      }
      const seen = new Set<string>();
      const ordered = [
        ...request.candidates.filter((candidate) => candidate.disclosure === 'always'),
        ...request.candidates.filter((candidate) => candidate.disclosure === 'selected'),
      ];
      const selected: ContextFragmentCandidate[] = [];
      let used = 0;
      for (const candidate of ordered) {
        if (seen.has(candidate.fragmentId)) {
          throw new Error(
            `Builtin Context Compiler received duplicate fragment: ${candidate.fragmentId}`,
          );
        }
        seen.add(candidate.fragmentId);
        if (used + candidate.tokenEstimate > request.tokenBudget) {
          if (candidate.disclosure === 'always') {
            throw new Error(
              `Required Context fragment exceeds the token budget: ${candidate.fragmentId}`,
            );
          }
          continue;
        }
        selected.push(candidate);
        used += candidate.tokenEstimate;
      }
      return Object.freeze({
        selectedFragmentIds: Object.freeze(selected.map((candidate) => candidate.fragmentId)),
        payload: Object.freeze({
          schema: 'kite.compiled-context.v1',
          purpose: request.purpose,
          tokenEstimate: used,
          fragments: Object.freeze(
            selected.map((candidate) =>
              Object.freeze({
                fragmentId: candidate.fragmentId,
                kind: candidate.kind,
                authority: candidate.authority,
                content: candidate.content,
              }),
            ),
          ),
        }),
      });
    },
  });
}

function createBuiltinContextSource(definition: BuiltinContextSourceDefinition): ContextSource {
  return Object.freeze({
    sourceId: definition.sourceId,
    revision: digestCapabilityBindingValue({
      schema: 'kite.builtin-context-source.v1',
      ...definition,
    }),
    providerId: MODEL_PROVIDER_ID_,
    collect: (request: ContextSourceRequest) => collectCommittedFragments(request, definition),
  });
}

function collectCommittedFragments(
  request: ContextSourceRequest,
  definition: BuiltinContextSourceDefinition,
): readonly ContextFragmentCandidate[] {
  const value = request.committedFacts[definition.factKey];
  if (!request.projectId.startsWith('project_')) {
    throw new Error('Builtin Context source requires a Host-issued Project identity.');
  }
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error(`Committed Context fact must be an array: ${definition.factKey}`);
  }
  return Object.freeze(
    value.map((item, index) => {
      const record = asRecord(item);
      const fragmentId = record && typeof record.fragmentId === 'string' ? record.fragmentId : '';
      const tokenEstimate = record?.tokenEstimate;
      const disclosure = record?.disclosure;
      if (
        !fragmentId ||
        !Number.isSafeInteger(tokenEstimate) ||
        (tokenEstimate as number) <= 0 ||
        (disclosure !== 'always' && disclosure !== 'selected' && disclosure !== 'on_demand') ||
        !record ||
        !('content' in record)
      ) {
        throw new Error(`Committed Context fragment is invalid: ${definition.factKey}[${index}]`);
      }
      return Object.freeze({
        fragmentId,
        kind: definition.kind,
        authority: definition.authority,
        content: record.content as RuntimeJsonValue,
        tokenEstimate: tokenEstimate as number,
        disclosure,
      });
    }),
  );
}

function asRecord(value: RuntimeJsonValue): Readonly<Record<string, RuntimeJsonValue>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, RuntimeJsonValue>>)
    : undefined;
}
