import type { Execution, Run, SelectContextRequest, SelectedContextPage } from '@kite-ai/client';

/** These are persisted facts; including a result does not start or authorize execution. */
export function ContextPanel({
  context,
  history = [],
  busy = false,
  storeId,
  activeRun,
  onRewind,
  onInclude,
  onNextPage,
}: {
  context: SelectedContextPage;
  history?: readonly Execution[];
  busy?: boolean;
  storeId?: string;
  activeRun?: Run;
  onRewind?: (boundary: SelectContextRequest['boundary']) => void | Promise<void>;
  onInclude?: (
    execution: Execution,
    scope: { storeId: string; sessionId: string; contextSelectionId: string; targetRunId?: string },
  ) => void | Promise<void>;
  onNextPage?: () => void | Promise<void>;
}) {
  return (
    <section aria-label="Selected context">
      <h3>Context selection {context.selection.id}</h3>
      <p>
        Boundary {context.selection.boundaryMessageId ?? 'empty'} · sequence{' '}
        {context.selection.boundarySeq} · snapshot through {context.highWaterSeq}
      </p>
      <pre>{JSON.stringify(context.selection.ranges, null, 2)}</pre>
      {busy && (
        <p>
          Active or unresolved execution: input_busy. Rewind is unavailable. Include requires the
          exact active Run.
        </p>
      )}
      <p>
        Rewind changes selected history. Existing file effects remain. Include result only saves a
        source; an idle include requires another Run, while active include queues for the selected
        Run checkpoint.
      </p>
      {onRewind && (
        <button type="button" disabled={busy} onClick={() => onRewind(null)}>
          Rewind to empty selected history
        </button>
      )}
      <ul>
        {context.messages.map((message) => (
          <li key={message.id}>
            <p>
              {message.id} · {message.seq} · {message.role} · {message.status}
            </p>
            <pre>{message.content}</pre>
            {onRewind && (
              <button
                type="button"
                disabled={busy || message.status !== 'complete'}
                onClick={() => onRewind({ messageId: message.id, seq: message.seq })}
              >
                Rewind through this exact message
              </button>
            )}
          </li>
        ))}
      </ul>
      <ul>
        {context.resultSources.map((source) => (
          <li key={source.id}>
            <p>
              Source {source.id} · {source.inclusion} · original Store {source.originStoreId} ·
              Execution {source.executionId} · revision {source.resultRevision}
            </p>
            <pre>{JSON.stringify(source.result, null, 2)}</pre>
          </li>
        ))}
      </ul>
      <p>
        Next message cursor: {context.nextAfterSeq ?? 'end'} · next source cursor:{' '}
        {context.nextAfterSourceId ?? 'end'}
      </p>
      {onNextPage && (context.nextAfterSeq !== null || context.nextAfterSourceId !== null) && (
        <button type="button" onClick={onNextPage}>
          Read next pinned context page
        </button>
      )}
      {activeRun && <p>Include target Run: {activeRun.id}</p>}
      <ul>
        {history
          .filter((execution) => execution.kind === 'job' && execution.delivery === 'suppressed')
          .map((execution) => (
            <li key={execution.id}>
              <p>
                Historical Execution {execution.id} · revision {execution.resultRevision} ·
                suppressed: {execution.deliveryReason ?? 'unspecified'}
              </p>
              {execution.deliveryReason === 'context_rewound' && (
                <p>Excluded by Rewind; it remains history until explicitly included.</p>
              )}
              <p>
                Original Store:{' '}
                {'originStoreId' in execution && typeof execution.originStoreId === 'string'
                  ? execution.originStoreId
                  : 'provenance unavailable in this execution view'}
              </p>
              <pre>{JSON.stringify(execution.result, null, 2)}</pre>
              {onInclude && (
                <button
                  type="button"
                  disabled={
                    !storeId ||
                    !execution.originStoreId ||
                    !execution.resultRevision ||
                    (busy &&
                      !(
                        activeRun?.isActive &&
                        activeRun.sessionId === context.selection.sessionId &&
                        activeRun.id
                      )) ||
                    execution.status === 'planned' ||
                    execution.status === 'dispatching' ||
                    execution.status === 'running' ||
                    execution.status === 'outcome_unknown'
                  }
                  onClick={() => {
                    if (!storeId || (busy && !activeRun)) return;
                    return onInclude(structuredClone(execution), {
                      storeId,
                      sessionId: context.selection.sessionId,
                      contextSelectionId: context.selection.id,
                      ...(activeRun?.isActive ? { targetRunId: activeRun.id } : {}),
                    });
                  }}
                >
                  Include this exact historical result
                </button>
              )}
            </li>
          ))}
      </ul>
      {!onRewind && !onInclude && <p>Read only</p>}
    </section>
  );
}

export function ContextSubmissionNotice({
  submission,
}: {
  submission: { kind: 'rewind' | 'include'; commandId: string; phase: string; error?: string };
}) {
  return (
    <p role={submission.error ? 'alert' : 'status'}>
      Context {submission.kind} {submission.phase} · command {submission.commandId}
      {submission.error ? ` · ${submission.error}` : ''}. Saved sources do not start a Run or replay
      an execution.{' '}
      {submission.phase === 'queued' && 'Awaiting the original Run checkpoint; not yet included.'}
    </p>
  );
}
