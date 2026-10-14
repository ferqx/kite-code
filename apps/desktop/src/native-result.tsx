import type { ReactNode } from 'react';
import { useNativeDiagnostics } from './native-diagnostics';

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
