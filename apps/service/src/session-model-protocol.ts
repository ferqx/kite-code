import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import { createConfigurationSnapshot } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import type { RunRecord } from '@kite-ai/agent/storage';
import { isSupportedModelProvider, type ModelProtocol, modelProtocol } from './model-providers';

const object = (value: Json | undefined): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read the original selected model only; current settings cannot complete old history. */
export function runModelProtocol(run: Pick<RunRecord, 'configuration'>): ModelProtocol {
  try {
    const manifest = run.configuration;
    if (!object(manifest) || typeof manifest.modelId !== 'string') throw Error();
    let snapshot = manifest.snapshot;
    if (object(snapshot) && snapshot.kind === 'human_input_processing')
      snapshot = snapshot.originalConfiguration;
    if (
      !object(snapshot) ||
      snapshot.version !== 1 ||
      typeof snapshot.digest !== 'string' ||
      !object(snapshot.configuration) ||
      createConfigurationSnapshot(snapshot.configuration).digest !== snapshot.digest ||
      !Array.isArray(snapshot.configuration.models)
    )
      throw Error();
    const selected = snapshot.configuration.models.filter(
      (model) => object(model) && model.id === manifest.modelId,
    );
    if (
      selected.length !== 1 ||
      !object(selected[0]) ||
      !isSupportedModelProvider(selected[0].provider)
    )
      throw Error();
    return modelProtocol(selected[0].provider, selected[0].protocol);
  } catch {
    throw new AgentError('session_model_protocol_unavailable');
  }
}

/** Store keeps the earliest Run in this ordered view, including after cold reconstruction. */
export async function assertSessionModelProtocol(
  runtime: Pick<AgentRuntime, 'getMetadata' | 'getView'> | undefined,
  sessionId: string,
  protocol: ModelProtocol,
): Promise<void> {
  if (!runtime) throw new AgentError('execution_scope_unavailable');
  const metadata = await runtime.getMetadata();
  const view = await runtime.getView(sessionId);
  if (view.storeId !== metadata.storeId || view.session.id !== sessionId)
    throw new AgentError('session_model_protocol_unavailable');
  const first = view.runs[0];
  if (!first) return;
  // Restored Runs retain their original Store identity; the current Store view owns this read.
  if (first.sessionId !== sessionId) throw new AgentError('session_model_protocol_unavailable');
  if (runModelProtocol(first) !== protocol) throw new AgentError('session_model_protocol_locked');
}
