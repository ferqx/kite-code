import { type ReactNode, useEffect, useState } from 'react';
import type { NativeBridge, NativeRequest } from './native-bridge';
import { useNativeDiagnostics } from './native-diagnostics';
import { nativeReadDeadline } from './native-read-deadline';

export function NativeExecutionResultRead({
  bridge,
  generation,
  viewSelection,
  historyEpoch,
  executionId,
  resultRevision,
  model,
}: Omit<Extract<NativeRequest, { method: 'execution.result' }>, 'method'> & {
  bridge: NativeBridge;
  model: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ result: unknown } | { failed: true }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry rereads the same result revision.
  useEffect(() => {
    let active = true;
    void nativeReadDeadline(
      bridge.request({
        method: 'execution.result',
        generation,
        viewSelection,
        historyEpoch,
        executionId,
        resultRevision,
      }),
    )
      .then((reply) => {
        if (active)
          setState(
            reply && 'kind' in reply && reply.kind === 'execution.result' && 'result' in reply
              ? { result: reply.result }
              : { failed: true },
          );
      })
      .catch(() => {
        if (active) setState({ failed: true });
      });
    return () => {
      active = false;
    };
  }, [attempt, bridge, generation, viewSelection, historyEpoch, executionId, resultRevision]);
  if (state && 'failed' in state)
    return (
      <button
        type="button"
        onClick={() => {
          setState(undefined);
          setAttempt((value) => value + 1);
        }}
      >
        重试读取执行结果
      </button>
    );
  return state ? <NativeExecutionResult result={state.result} model={model} /> : null;
}

function resultFields(value: unknown, path: string): ReactNode {
  if (Array.isArray(value)) {
    return value.length ? (
      <ol>
        {value.map((item, index) => (
          <li key={`${path}/${index}`}>{resultFields(item, `${path}/${index}`)}</li>
        ))}
      </ol>
    ) : (
      <span>[]</span>
    );
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value);
    return fields.length ? (
      <dl>
        {fields.map(([name, item]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{resultFields(item, `${path}/${name}`)}</dd>
          </div>
        ))}
      </dl>
    ) : (
      <span>{'{}'}</span>
    );
  }
  return (
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {value === null ? 'null' : String(value)}
    </pre>
  );
}

/** All persisted result fields remain content; no key-name allowlist or projection. */
export function NativeExecutionResult({
  result,
  model = false,
}: {
  result: unknown;
  model?: boolean;
}) {
  const diagnostics = useNativeDiagnostics();
  if (diagnostics) return <pre>{JSON.stringify(result, null, 2)}</pre>;
  // Model reply/reasoning/tool calls have their complete dedicated reading path.
  if (model || result === undefined) return null;
  return <section aria-label="执行结果">{resultFields(result, 'result')}</section>;
}
