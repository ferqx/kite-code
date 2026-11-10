import { type TrajectoryEvent, trajectoryEventSchema } from '@kite-ai/trajectory';

export const outputStateCases = [
  'empty-virtual',
  'empty-message',
  'text-virtual',
  'text-message',
  'generating-text',
  'generating-empty',
  'generating-late-text',
  'legacy',
  'foreign-ref',
  'failed',
  'unknown',
  'retry',
] as const;
export type OutputStateCase = (typeof outputStateCases)[number];

/** Isolated owner-bound facts and original materials. Never reads a real Profile. */
export function seedOutputState(facts: TrajectoryEvent[], caseName: OutputStateCase) {
  const bodies = new Map<string, unknown>();
  const bodyKey = (eventId: string, reference: { evidenceId: string; contentVersion: string }) =>
    `${eventId}:${reference.evidenceId}:${reference.contentVersion}`;
  const runId = 'output-state-run';
  const subject = 'output-subject';
  const message = caseName.endsWith('-message');
  const generating = caseName.startsWith('generating-');
  const text = `准确保存的回复正文 ${caseName}。`;
  const root = {
    commandId: 'output-command',
    rootWorkCommandId: 'output-command',
    rootWorkSeq: '1',
  };
  function add(
    kind: TrajectoryEvent['kind'],
    executionId: string | undefined,
    phase: TrajectoryEvent['phase'],
    attributes: Record<string, unknown>,
    material?: { kind: 'model_output' | 'message'; body: unknown; partial?: boolean },
  ) {
    const sequence = String(BigInt(facts.at(-1)?.sequence ?? '0') + 1n);
    const reference = material && {
      kind: material.kind,
      evidenceId: `output-evidence-${sequence}`,
      contentVersion: `output-version-${sequence}`,
      mediaType: 'application/json',
      availability: material.partial ? 'partial' : 'available',
    };
    const event = trajectoryEventSchema.parse({
      schema: 'kite.trajectory',
      schemaVersion: 1,
      eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
      sequence,
      origin: { storeId: 'store', cursor: sequence },
      sessionId: 'a',
      workspaceId: 'w',
      runId,
      runOriginStoreId: 'store',
      ...(executionId ? { executionId, executionOriginStoreId: 'store' } : {}),
      kind,
      phase,
      recordedStatus:
        kind === 'message' ? attributes.status : phase === 'completed' ? 'succeeded' : phase,
      sourceEventType: kind === 'message' ? 'message.updated' : 'execution.changed',
      sourceRecordRevision: sequence,
      occurredAt: Number(sequence) * 250,
      identityConfidence: 'verified_origin',
      attributes: kind === 'message' ? attributes : { ...root, ...attributes },
      evidenceRefs: reference ? [reference] : [],
    });
    if (reference) bodies.set(bodyKey(event.eventId, event.evidenceRefs[0]!), material!.body);
    facts.push(event);
    return event;
  }
  const modelAttributes = {
    definitionId: 'fixture.respond',
    definitionVersion: '1',
    display: {
      kind: 'model',
      title: '请求模型',
      modelName: 'fixture-provider-model',
      operation: 'request',
    },
  };
  add('run', undefined, 'running', {});
  const filler = (index: number) =>
    add('tool', `output-anchor-${index}`, 'completed', {
      definitionId: 'files.read',
      definitionVersion: '5',
      display: {
        kind: 'file',
        operation: 'read',
        title: '读取文件',
        summary: `src/anchor-${index}.ts`,
      },
    });
  for (let index = 0; index < 12; index++) filler(index);
  if (caseName === 'retry') {
    add('model', 'output-first', 'failed', modelAttributes, {
      kind: 'model_output',
      partial: true,
      body: { content: '', reasoning: '首次请求连接失败。', toolCalls: [], complete: false },
    });
  }
  const attributes = {
    ...modelAttributes,
    ...(caseName === 'retry'
      ? {
          previousExecutionId: 'output-first',
          previousExecutionOriginStoreId: 'store',
          retryReason: 'connection_failed',
          retryAttempt: 2,
        }
      : {}),
  };
  function output(final: boolean) {
    const empty =
      caseName.startsWith('empty-') ||
      ['failed', 'unknown'].includes(caseName) ||
      (caseName === 'generating-empty' && final);
    const hasText = !empty && (!generating || final || caseName === 'generating-text');
    const complete = final && caseName !== 'failed' && caseName !== 'unknown';
    const sequence = String(BigInt(facts.at(-1)!.sequence) + 1n);
    const presence = {
      hasText: caseName === 'foreign-ref' ? false : hasText,
      toolCallCount: empty || caseName === 'foreign-ref' ? 1 : 0,
      complete,
      evidenceId: caseName === 'foreign-ref' ? 'foreign-evidence' : `output-evidence-${sequence}`,
      contentVersion: `output-version-${sequence}`,
    };
    const phase = !final
      ? 'running'
      : caseName === 'failed'
        ? 'failed'
        : caseName === 'unknown'
          ? 'outcome_unknown'
          : 'completed';
    if (message) {
      add('model', subject, 'completed', attributes);
      // The following message owns its own evidence; the Model event above does not.
      presence.evidenceId = `output-evidence-${BigInt(sequence) + 1n}`;
      presence.contentVersion = `output-version-${BigInt(sequence) + 1n}`;
      add(
        'message',
        subject,
        'observed',
        {
          messageId: 'output-message',
          role: 'assistant',
          messageSeq: '2',
          revision: final ? '2' : '1',
          status: complete ? 'complete' : 'incomplete',
          display: {
            kind: 'message',
            title: 'Agent 回复',
            ...(hasText ? { summary: text } : {}),
            outputPresence: presence,
          },
        },
        {
          kind: 'message',
          body: {
            messageId: 'output-message',
            role: 'assistant',
            messageSeq: '2',
            revision: final ? '2' : '1',
            status: complete ? 'complete' : 'incomplete',
            content: hasText ? text : '',
            toolCalls: empty ? [{ id: 'call-output', name: 'files.read', arguments: '{}' }] : [],
          },
        },
      );
    } else {
      add(
        'model',
        subject,
        phase,
        {
          ...attributes,
          display: {
            ...attributes.display,
            ...(caseName === 'legacy' ? {} : { outputPresence: presence }),
          },
        },
        {
          kind: 'model_output',
          partial: !complete,
          body: {
            content: hasText ? text : '',
            reasoning: '已保存的公开思考。',
            complete,
            toolCalls: empty ? [{ id: 'call-output', name: 'files.read', arguments: '{}' }] : [],
          },
        },
      );
    }
    if (empty)
      add('tool', 'output-real-tool', 'completed', {
        definitionId: 'files.read',
        definitionVersion: '5',
        display: {
          kind: 'file',
          operation: 'read',
          title: '读取文件',
          summary: 'src/real-tool.ts',
        },
      });
  }
  output(!generating);
  for (let index = 12; index < 36; index++) filler(index);
  if (!generating) add('run', undefined, 'completed', {});
  let advanced = false;
  return {
    bodies,
    bodyKey,
    completeShell() {},
    caseName,
    text,
    rowId: message
      ? 'message:output-message'
      : `execution:${caseName === 'retry' ? 'output-first' : subject}:part:reply`,
    hiddenInitially:
      caseName.startsWith('empty-') ||
      caseName === 'generating-empty' ||
      caseName === 'generating-late-text',
    hiddenFinally: caseName === 'generating-empty' || caseName.startsWith('empty-'),
    advance() {
      if (!generating || advanced) return;
      advanced = true;
      output(true);
      add('run', undefined, 'completed', {});
    },
  };
}
