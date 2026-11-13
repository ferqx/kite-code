import { type ModelAdapter, ModelAttemptError, type ModelRequest } from '@kite-ai/ai';
import type {
  AuthorizationCheckAnswer,
  AuthorizationCheckOutput,
} from '../authorization-check-output';
import { semanticDigest } from '../json';
import { modelExecutionError } from '../model-attempt';
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
import type { ToolBehaviorBinding } from '../tool-behavior';
import { type AuthorizationTimingState, authorizationTimingSnapshot } from './authorization-timing';
import type { ModelResponse } from './index';
import type { ExecutionResources } from './resources';

/** One internal Model call. Its owning operation supplies the sealed purpose and persistence. */
export async function runInternalModelCall(options: {
  purpose: 'authorization_check' | 'session_title';
  review?: {
    behavior: ToolBehaviorBinding;
    target: AuthorizationCheckOutput['target'];
    checkInputDigest: string;
    materialFingerprint?: string;
    interpret(content: string): { answer: AuthorizationCheckAnswer; evidence?: Json } | null;
  };
  store: Store;
  resources: ExecutionResources;
  owner: OwnerRef;
  workspaceId: string;
  execution: ExecutionRecord;
  model: ModelAdapter;
  request: ModelRequest;
  input: Json;
  modelMetadata: Json;
  timing?: AuthorizationTimingState;
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
  const timing = () =>
    options.timing ? { ...authorizationTimingSnapshot(options.timing) } : undefined;
  const preview = () => content.slice(0, 4096);
  const partial = async (modelOutput?: ModelOutputReference) => {
    await persist({
      ...base,
      content: modelOutput ? preview() : content,
      reasoning: modelOutput ? '' : reasoning,
      ...(firstOutput ? { firstOutput } : {}),
      usage,
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
    if (options.timing) options.timing.queueStartedAt = Date.now();
    release = permissionCheck
      ? await options.resources.acquire(
          { slot: 'model' },
          { sessionId: execution.sessionId, workspaceId: options.workspaceId },
          signal,
        )
      : await options.resources.acquireTitleModel(signal);
    if (options.timing) options.timing.queueFinishedAt = Date.now();
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
    if (options.timing) options.timing.providerStartedAt = Date.now();
    for await (const event of options.model.stream(providerRequest, { signal })) {
      if (finished) throw new AgentError('model_event_after_finish');
      if (event.type === 'usage') usage = structuredClone({ ...event.usage });
      signal.throwIfAborted();
      if (event.type === 'usage') {
        await partial(output?.descriptor() ?? undefined);
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
              ? event.reason === 'length'
                ? 'authorization_check_output_limit'
                : 'authorization_check_output_invalid'
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
    let assessment: { answer: AuthorizationCheckAnswer; evidence?: Json } | null = null;
    if (permissionCheck) {
      try {
        assessment = options.review?.interpret(content) ?? null;
      } catch {
        /* Invalid text cannot authorize or become a request for human approval. */
      }
      if (!assessment)
        throw new AgentError(
          content.trim()
            ? 'authorization_check_output_invalid'
            : 'authorization_check_output_empty',
        );
    }
    const descriptor = output?.descriptor(true);
    const completeOutput = descriptor ?? {
      content,
      reasoning,
      ...(firstOutput ? { firstOutput } : {}),
      toolCalls: [],
      usage,
      finishReason: 'stop',
    };
    let receipt: AuthorizationCheckOutput | undefined;
    if (permissionCheck) {
      if (!options.review || !assessment)
        throw new AgentError('authorization_check_binding_invalid');
      receipt = {
        kind: 'authorization_check_output',
        version: 1,
        modelExecutionId: execution.id,
        behavior: structuredClone(options.review.behavior),
        target: structuredClone(options.review.target),
        checkInputDigest: options.review.checkInputDigest,
        sealedInputHash: expectedHash,
        modelOutputDigest: await semanticDigest(completeOutput as unknown as Json),
        contentHash: await semanticDigestBytes(Buffer.from(content), signal),
        ...(options.review.materialFingerprint
          ? { materialFingerprint: options.review.materialFingerprint }
          : {}),
        answer: assessment.answer,
        ...(assessment.evidence !== undefined ? { evidence: assessment.evidence } : {}),
      };
      if (descriptor) await options.publishReceipt!(receipt, signal);
    }
    const input = prepared.input as Record<string, Json>;
    const body = bodyReference(input.body);
    if (!permissionCheck && Buffer.byteLength(content) + Buffer.byteLength(reasoning) > 32768)
      throw new AgentError('session_title_response_too_large');
    await finish({
      ...base,
      status: 'succeeded',
      result: {
        // Naming is bounded to 32KiB. Keep its complete text bound to the result
        // receipt so the final metadata transaction never validates a streamed prefix.
        content: !permissionCheck ? content : descriptor ? preview() : content,
        reasoning: descriptor ? '' : reasoning,
        ...(firstOutput ? { firstOutput } : {}),
        toolCalls: [],
        usage,
        finishReason: 'stop',
        ...(timing() ? { timing: timing()! } : {}),
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
  } catch (cause) {
    const error = modelExecutionError(cause);
    const timedOut =
      signal.reason instanceof AgentError && signal.reason.code === 'authorization_check_timeout';
    const settled = await finish({
      ...base,
      status: timedOut ? 'failed' : signal.aborted ? 'cancelled' : 'failed',
      result: {
        code: timedOut
          ? 'authorization_check_timeout'
          : error instanceof AgentError
            ? error.code
            : ModelAttemptError.isInstance(error)
              ? error.message
              : 'model_failed',
        incomplete: true,
        ...(timedOut && options.timing
          ? { deadlineAt: options.timing.startedAt + options.timing.budgetMs }
          : {}),
        ...(timing() ? { timing: timing()! } : {}),
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
