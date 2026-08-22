import type {
  CompiledContextV1,
  ContextCompilerPortV1,
  ContextFragmentCandidateV1,
  ContextSourceRequestV1,
  ContextSourceV1,
  RuntimeJsonValueV1,
  RuntimeModuleRegistryWriterV1,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import { RMV1_11_PROVIDER_ID_V1 } from './rmv1-11-operations';

export const BUILTIN_CONTEXT_SOURCE_IDS_V1 = Object.freeze([
  'builtin:project-instructions-context',
  'builtin:skill-context',
  'builtin:mcp-observation-context',
] as const);

export const BUILTIN_CONTEXT_COMPILER_ID_V1 = 'kite-builtin-context-compiler' as const;
export const BUILTIN_CONTEXT_COMPILER_REVISION_V1 = digestCapabilityBindingValueV1({
  schema: 'kite.builtin-context-compiler.v1',
  selection: 'always-then-selected-in-source-order',
  onDemand: 'excluded',
});

type BuiltinContextSourceDefinitionV1 = Readonly<{
  sourceId: (typeof BUILTIN_CONTEXT_SOURCE_IDS_V1)[number];
  factKey: string;
  kind: 'project_instruction' | 'skill_instruction' | 'external_content';
  authority: 'project' | 'user' | 'external';
}>;

const SOURCE_DEFINITIONS_V1: readonly BuiltinContextSourceDefinitionV1[] = Object.freeze([
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

export function registerBuiltinContextSourcesV1(registry: RuntimeModuleRegistryWriterV1): void {
  for (const definition of SOURCE_DEFINITIONS_V1) {
    registry.registerContextSource(createBuiltinContextSourceV1(definition));
  }
}

export function createBuiltinContextCompilerPortV1(): ContextCompilerPortV1 {
  return Object.freeze({
    compilerId: BUILTIN_CONTEXT_COMPILER_ID_V1,
    revision: BUILTIN_CONTEXT_COMPILER_REVISION_V1,
    async compile(
      request: Parameters<ContextCompilerPortV1['compile']>[0],
    ): Promise<CompiledContextV1> {
      if (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0) {
        throw new Error('Builtin Context Compiler requires a positive integer token budget.');
      }
      const seen = new Set<string>();
      const ordered = [
        ...request.candidates.filter((candidate) => candidate.disclosure === 'always'),
        ...request.candidates.filter((candidate) => candidate.disclosure === 'selected'),
      ];
      const selected: ContextFragmentCandidateV1[] = [];
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

function createBuiltinContextSourceV1(
  definition: BuiltinContextSourceDefinitionV1,
): ContextSourceV1 {
  return Object.freeze({
    sourceId: definition.sourceId,
    revision: digestCapabilityBindingValueV1({
      schema: 'kite.builtin-context-source.v1',
      ...definition,
    }),
    providerId: RMV1_11_PROVIDER_ID_V1,
    collect: (request: ContextSourceRequestV1) => collectCommittedFragmentsV1(request, definition),
  });
}

function collectCommittedFragmentsV1(
  request: ContextSourceRequestV1,
  definition: BuiltinContextSourceDefinitionV1,
): readonly ContextFragmentCandidateV1[] {
  const value = request.committedFacts[definition.factKey];
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
        content: record.content as RuntimeJsonValueV1,
        tokenEstimate: tokenEstimate as number,
        disclosure,
      });
    }),
  );
}

function asRecord(
  value: RuntimeJsonValueV1,
): Readonly<Record<string, RuntimeJsonValueV1>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, RuntimeJsonValueV1>>)
    : undefined;
}
