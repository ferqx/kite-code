import type { Store } from '../storage/port';
import type { ExecutionRecord, Json } from '../storage/types';

/** Owner identity comes only from the original Run's captured registration. */
export function capturedToolOwner(
  execution: { kind: string; definitionId?: string | null; definitionVersion?: string | null },
  configuration: Json,
): string | undefined {
  if (
    execution.kind !== 'tool' ||
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration)
  )
    return;
  const tools = configuration.tools;
  const extensions = configuration.extensions;
  if (!Array.isArray(tools) || !Array.isArray(extensions)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    if (
      tool.id !== execution.definitionId ||
      tool.version !== execution.definitionVersion ||
      typeof tool.extensionId !== 'string'
    )
      continue;
    if (
      extensions.some(
        (extension) =>
          extension &&
          typeof extension === 'object' &&
          !Array.isArray(extension) &&
          extension.id === tool.extensionId,
      )
    )
      return tool.extensionId;
  }
  return undefined;
}

/** A dynamic step's original Model owns its captured bindings, independent of today's catalogue. */
export async function readExecutionToolOwner(
  host: Pick<Store, 'getExecution' | 'getRun'>,
  execution: ExecutionRecord,
): Promise<string | undefined> {
  if (execution.kind !== 'tool' || !execution.runId) return;
  const source = execution.decisionSource;
  const modelId =
    source && typeof source === 'object' && !Array.isArray(source)
      ? source.modelExecutionId
      : undefined;
  if (typeof modelId === 'string') {
    const model = await host.getExecution(modelId);
    if (
      !model ||
      model.kind !== 'model' ||
      model.status !== 'succeeded' ||
      model.runId !== execution.runId ||
      model.sessionId !== execution.sessionId ||
      model.originStoreId !== execution.originStoreId ||
      model.rootWorkCommandId !== execution.rootWorkCommandId ||
      model.rootWorkSeq !== execution.rootWorkSeq ||
      model.stepId !== execution.stepId
    )
      return;
    const captured = model.decisionSource;
    const bindings =
      captured && typeof captured === 'object' && !Array.isArray(captured)
        ? captured.toolBindings
        : undefined;
    if (!Array.isArray(bindings)) return;
    const matching = bindings.filter(
      (binding) =>
        binding &&
        typeof binding === 'object' &&
        !Array.isArray(binding) &&
        binding.id === execution.definitionId &&
        binding.version === execution.definitionVersion,
    );
    const binding = matching.length === 1 ? matching[0] : undefined;
    return binding &&
      typeof binding === 'object' &&
      !Array.isArray(binding) &&
      typeof binding.extensionId === 'string'
      ? binding.extensionId
      : undefined;
  }
  const run = await host.getRun(execution.runId);
  return run &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId
    ? capturedToolOwner(execution, run.configuration)
    : undefined;
}
