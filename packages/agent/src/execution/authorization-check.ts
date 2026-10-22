import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import {
  type AuthorizationCheckOutput,
  authorizationCheckAnswer,
} from '../authorization-check-output';
import { semanticDigest } from '../json';
import { bodyReference } from '../model-body';
import { semanticDigestBytes } from '../model-body/digest';
import { type ModelOutputReference, ModelOutputWriter } from '../model-output';
import type { DispatchInput, PermissionControlRead, Store } from '../storage/port';
import {
  AgentError,
  type ArtifactReference,
  type ExecutionRecord,
  type Json,
  type OwnerRef,
} from '../storage/types';
import type { ModelResponse } from './index';
import type { ExecutionResources } from './resources';

/** One internal Model call. Its owning operation supplies the sealed purpose and persistence. */
export async function runInternalModelCall(options: {
  purpose: 'authorization_check' | 'session_title';
  store: Store;
  resources: ExecutionResources;
  owner: OwnerRef;
  workspaceId: string;
  execution: ExecutionRecord;
  model: ModelAdapter;
  request: ModelRequest;
  input: Json;
  modelMetadata: Json;
  controlReads?: readonly PermissionControlRead[];
  signal: AbortSignal;
  checkpoint(): Promise<void>;
  authorize?(): Promise<DispatchInput['authorization']>;
  publish(value: Json, signal: AbortSignal): Promise<ArtifactReference>;
  publishReceipt?(receipt: AuthorizationCheckOutput, signal: AbortSignal): Promise<void>;
}): Promise<ModelResponse | null> {
  const { store, execution, owner, signal } = options;
  const permissionCheck = options.purpose === 'authorization_check';
  const persist = permissionCheck
    ? store.persistAuthorizationCheckPartial.bind(store)
    : store.persistInternalModelPartial.bind(store);
  const finish = permissionCheck
    ? store.finishAuthorizationCheck.bind(store)
    : store.finishInternalModel.bind(store);
  const base = { expectedStoreId: execution.originStoreId, owner, executionId: execution.id };
  let content = '';
  let reasoning = '';
  let firstOutput: 'content' | 'reasoning' | undefined;
  let usage: Json = {};
  let release: (() => void) | undefined;
  let output: ModelOutputWriter | undefined;
  let dispatched = false;
  const preview = () => content.slice(0, 4096);
  const partial = async (modelOutput?: ModelOutputReference) => {
    await persist({
      ...base,
      content: modelOutput ? preview() : content,
      reasoning: modelOutput ? '' : reasoning,
      ...(firstOutput ? { firstOutput } : {}),
      ...(modelOutput ? { modelOutput } : {}),
    });
  };
  try {
    await options.checkpoint();
    const prepared = permissionCheck
      ? await store.prepareAuthorizationCheck({
          ...base,
          input: options.input,
          modelMetadata: options.modelMetadata,
        })
      : execution;
    if (!permissionCheck) {
      if (!options.authorize) throw new AgentError('internal_model_permission_unavailable');
      await options.authorize();
    }
    release = await options.resources.acquire(
      { slot: 'model' },
      { sessionId: execution.sessionId, workspaceId: options.workspaceId },
      signal,
    );
    signal.throwIfAborted();
    await options.checkpoint();
    if (permissionCheck)
      await store.dispatchAuthorizationCheck({ ...base, controlReads: options.controlReads });
    else {
      const authorization = await options.authorize!();
      signal.throwIfAborted();
      await store.dispatchInternalModel({ ...base, authorization });
    }
    dispatched = true;
    const command = await store.getCommand(execution.originCommandId);
    if (!command) throw new AgentError('authorization_check_unverifiable');
    const activateOutput = async () => {
      output = new ModelOutputWriter(
        {
          storeId: execution.originStoreId,
          sessionId: execution.sessionId,
          subjectId: command.subjectId,
          executionId: execution.id,
        },
        (value) => options.publish(value, signal),
        (reference) => partial(reference),
      );
      await output.text('text', content);
      await output.text('reasoning', reasoning);
    };
    const sealedInput = prepared.input as Record<string, Json>;
    const sealedBody = bodyReference(sealedInput.body);
    const { authorizationCheckBindingDigest: _checkBinding, ...inlineRequest } = sealedInput;
    const expectedHash = sealedBody?.reference.hash ?? (await semanticDigest(inlineRequest));
    if ((await semanticDigest(options.request as unknown as Json)) !== expectedHash)
      throw new AgentError(
        permissionCheck ? 'authorization_check_binding_changed' : 'internal_model_binding_changed',
      );
    let finished = false;
    let savedLength = 0;
    let savedAt = Date.now();
    const providerRequest = structuredClone(options.request);
    signal.throwIfAborted();
    for await (const event of options.model.stream(providerRequest, { signal })) {
      signal.throwIfAborted();
      if (finished) throw new AgentError('model_event_after_finish');
      if (event.type === 'usage') {
        usage = structuredClone({ ...event.usage });
        continue;
      }
      if (event.type === 'text_delta') {
        if (event.text.length) firstOutput ??= 'content';
        content += event.text;
        if (output) await output.text('text', event.text);
      } else if (event.type === 'reasoning_delta') {
        if (event.text.length) firstOutput ??= 'reasoning';
        reasoning += event.text;
        if (output) await output.text('reasoning', event.text);
      } else if (event.type === 'tool_call') {
        throw new AgentError(
          permissionCheck ? 'authorization_check_output_invalid' : 'internal_model_output_invalid',
        );
      } else {
        usage = structuredClone({ ...event.usage });
        if (event.reason !== 'stop')
          throw new AgentError(
            permissionCheck
              ? 'authorization_check_output_invalid'
              : 'internal_model_output_invalid',
          );
        finished = true;
        if (event.continuation !== undefined) {
          if (!output) await activateOutput();
          await output!.continuation(event.continuation);
        }
      }
      if (!output && Buffer.byteLength(content) + Buffer.byteLength(reasoning) > 64 * 1024)
        await activateOutput();
      if (
        !output &&
        ((savedLength === 0 && content.length + reasoning.length > 0) ||
          content.length + reasoning.length - savedLength >= 32768 ||
          Date.now() - savedAt >= 100)
      ) {
        await partial();
        savedLength = content.length + reasoning.length;
        savedAt = Date.now();
      }
    }
    if (!finished) throw new AgentError('model_response_incomplete');
    signal.throwIfAborted();
    const descriptor = output?.descriptor(true);
    let receipt: AuthorizationCheckOutput | undefined;
    if (descriptor && permissionCheck) {
      let answer: ReturnType<typeof authorizationCheckAnswer> = null;
      try {
        answer = authorizationCheckAnswer(JSON.parse(content));
      } catch {
        /* Invalid text cannot authorize. */
      }
      if (answer) {
        receipt = {
          kind: 'authorization_check_output',
          version: 1,
          modelExecutionId: execution.id,
          modelOutputDigest: await semanticDigest(descriptor as unknown as Json),
          contentHash: await semanticDigestBytes(Buffer.from(content), signal),
          answer,
        };
        await options.publishReceipt!(receipt, signal);
      }
    }
    const input = prepared.input as Record<string, Json>;
    const body = bodyReference(input.body);
    await finish({
      ...base,
      status: 'succeeded',
      result: {
        content: descriptor ? preview() : content,
        reasoning: descriptor ? '' : reasoning,
        ...(firstOutput ? { firstOutput } : {}),
        toolCalls: [],
        usage,
        finishReason: 'stop',
        ...(body ? { modelInputBodyHash: body.reference.hash } : {}),
        ...(descriptor ? { modelOutput: descriptor as unknown as Json } : {}),
        ...(receipt ? { authorizationCheckOutput: receipt as unknown as Json } : {}),
      },
    });
    return {
      content,
      reasoning,
      toolCalls: [],
      usage,
      executionId: execution.id,
      finishReason: 'stop',
    };
  } catch (error) {
    const settled = await finish({
      ...base,
      status: signal.aborted ? 'cancelled' : 'failed',
      result: {
        code: error instanceof AgentError ? error.code : 'model_failed',
        incomplete: true,
        content: output ? preview() : content.slice(0, 64 * 1024),
        reasoning: output ? '' : reasoning.slice(0, 64 * 1024),
        usage,
        ...(firstOutput ? { firstOutput } : {}),
        ...(output?.descriptor() ? { modelOutput: output.descriptor() as unknown as Json } : {}),
        ...(!dispatched ? { dispatchCommitted: false } : {}),
      },
    }).catch(() => undefined);
    if (!permissionCheck && !settled) {
      const observed = await store.getExecution(execution.id).catch(() => null);
      if (!observed || !['succeeded', 'failed', 'cancelled'].includes(observed.status))
        throw new AgentError('internal_model_stop_unconfirmed');
    }
    if (signal.aborted || !permissionCheck) throw error;
    return null;
  } finally {
    release?.();
  }
}
