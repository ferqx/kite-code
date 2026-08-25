import type { BuiltinModelToolCatalogEntry } from '@kite/builtin-runtime';
import {
  checkProjectInstructionSnapshotFreshness,
  projectProjectInstructionGuardTarget,
  resolveProjectInstructionSnapshot,
} from '@kite/builtin-runtime/model';
import type { RuntimeJsonValue } from '@kite/runtime-spi';
import type { RuntimeState } from '#app/bootstrap/runtime/state-runtime';

export function projectInstructionGuardFailure(input: {
  readonly state: RuntimeState;
  readonly modelMessageId: string | undefined;
  readonly entry: BuiltinModelToolCatalogEntry;
  readonly argumentOrigin: 'model_public' | 'runtime_private';
  readonly rawArguments: unknown;
}): string | null {
  const parsed =
    input.argumentOrigin === 'runtime_private'
      ? input.entry.parse(input.rawArguments)
      : input.entry.parseModelInput(input.rawArguments);
  if (!parsed.success) return null;
  const parser =
    input.argumentOrigin === 'runtime_private'
      ? input.entry.parser
      : (input.entry.modelParser ?? input.entry.parser);
  const canonicalArguments = parser.canonicalize(parsed.data);
  if (!isRuntimeJsonRecord(canonicalArguments)) return null;
  const classifiedEffects = input.entry.classifyEffects(canonicalArguments);
  const target = projectProjectInstructionGuardTarget({
    executionMechanism: input.entry.executionMechanism,
    declaredFilesystemEffect: input.entry.descriptor.declaredEffects.filesystem,
    effectiveFilesystemEffect: classifiedEffects.effectiveEffects.filesystem,
    canonicalArguments,
  });
  if (!target) return null;
  const visibleSnapshot = resolveProjectInstructionSnapshot({
    workspace: input.state.session.workspace,
    state: input.state,
    excludeModelMessageId: input.modelMessageId,
  });
  if (!visibleSnapshot) return null;
  const guard = checkProjectInstructionSnapshotFreshness({
    workspace: input.state.session.workspace,
    visibleSnapshot,
    target,
  });
  return guard.status === 'changed' ? guard.message : null;
}

function isRuntimeJsonRecord(
  value: RuntimeJsonValue,
): value is Readonly<Record<string, RuntimeJsonValue>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function visibleProjectInstructions(
  state: RuntimeState,
  modelMessageId: string | undefined,
) {
  return resolveProjectInstructionSnapshot({
    workspace: state.session.workspace,
    state,
    excludeModelMessageId: modelMessageId,
  });
}
