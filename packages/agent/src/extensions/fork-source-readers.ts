import { createHash } from 'node:crypto';
import type { ArtifactReadInput } from '../artifact-port';
import { canonicalJson } from '../json';

import type { ModelInputSnapshot, ModelOutputSnapshot } from '../runtime';
import type { Store } from '../storage/port';
import { AgentError, type ForkReadonlyProof } from '../storage/types';

const semanticDigestBytes = async (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

export interface TrustedForkSourceReaders {
  readModelInput(input: Parameters<Store['getModelInputSnapshot']>[0]): Promise<ModelInputSnapshot>;
  readModelOutput(
    input: Parameters<Store['getModelOutputSnapshot']>[0],
  ): Promise<ModelOutputSnapshot>;
  readArtifact(input: ArtifactReadInput): Promise<{ content: Uint8Array }>;
}
/** Only actual host readers populate full hashes. Declarations cannot carry them. */
export async function verifyForkReadonlyBodies(
  store: Store,
  readers: TrustedForkSourceReaders | undefined,
  proof: ForkReadonlyProof,
  expectedStoreId: string,
  subjectId: string,
) {
  if (!readers) throw new AgentError('fork_source_reader_unavailable');
  const models = new Map<string, { executionId: string; inputHash: string; outputHash: string }>();
  for (const source of proof.sources) {
    const modelId = source.kind === 'model' ? source.executionId : source.modelExecutionId;
    if (modelId && !models.has(modelId)) {
      const model = await store.getExecution(modelId);
      if (model?.kind !== 'model' || model.status !== 'succeeded')
        throw new AgentError('fork_source_unverifiable');
      const scope = {
        expectedStoreId,
        subjectId,
        sessionId: model.sessionId,
        executionId: modelId,
      };
      const input = await readers.readModelInput(scope),
        output = await readers.readModelOutput(scope);
      if (
        input.executionId !== modelId ||
        input.sessionId !== model.sessionId ||
        output.executionId !== modelId ||
        output.sessionId !== model.sessionId ||
        !output.output.complete
      )
        throw new AgentError('fork_source_unverifiable');
      models.set(modelId, {
        executionId: modelId,
        inputHash: input.bodyHash,
        outputHash: output.bodyHash,
      });
    }
    if (source.kind === 'tool' && source.modelExecutionId) {
      const actual = await store.getExecution(source.executionId);
      const output = await readers.readModelOutput({
        expectedStoreId,
        subjectId,
        sessionId: source.sessionId,
        executionId: source.modelExecutionId,
      });
      const call = output.output.toolCalls.find((call) => call.id === actual?.callId);
      let args: unknown;
      try {
        args = call && JSON.parse(call.arguments);
      } catch {}
      if (
        !actual ||
        !call ||
        call.name !== actual.definitionId ||
        canonicalJson(args as never) !== canonicalJson(actual.input)
      )
        throw new AgentError('fork_source_unverifiable');
    }
    for (const ref of source.artifactRefs) {
      const value = await readers.readArtifact({
        expectedStoreId,
        subjectId,
        sessionId: ref.sessionId,
        refId: ref.id,
        scope: ref.scope,
      });
      if (
        String(value.content.byteLength) !== ref.size ||
        (await semanticDigestBytes(value.content)) !== ref.hash
      )
        throw new AgentError('fork_source_media_invalid');
    }
  }
  const expected = proof.models;
  const actual = [...models.values()];
  for (const sealed of expected) {
    const verified = models.get(sealed.executionId);
    if (!verified || canonicalJson(sealed as never) !== canonicalJson(verified as never))
      throw new AgentError('fork_source_body_changed');
  }
  proof.models = actual;
}
