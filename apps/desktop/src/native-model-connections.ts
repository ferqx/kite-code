import type { Message } from '@kite-ai/client';
import type { Message as DesktopMessage } from '@kite-ai/ui/desktop';
import type { NativeRunFact, NativeToolExecution } from './tool-messages-bridge';

const reasons = ['connection_failed', 'provider_unavailable', 'stream_incomplete'];
const failures = {
  connection_refused: {
    description: '模型服务拒绝了连接，当前地址没有可用的服务响应。',
    suggestion: '请确认服务已启动，并检查服务地址和代理设置后再试。',
  },
  connection_timeout: {
    description: '连接模型服务超时，未能及时取得响应。',
    suggestion: '请检查网络和代理是否可用，确认模型服务可以访问后再试。',
  },
  name_resolution_failed: {
    description: '无法解析模型服务的地址，因此未能建立连接。',
    suggestion: '请检查服务地址是否正确，以及网络、域名解析和代理设置。',
  },
  connection_interrupted: {
    description: '与模型服务的连接在传输过程中中断，未收到完整回复。',
    suggestion: '请检查网络或代理连接是否稳定，稍后再试。已有消息和执行结果已保留。',
  },
  rate_limited: {
    description: '模型服务限制了请求频率，暂时拒绝继续响应。',
    suggestion: '请稍后再试；如果反复发生，请检查所用服务的请求额度或并发限制。',
  },
  request_timeout: {
    description: '模型服务处理或传输回复超时，未能完成请求。',
    suggestion: '请稍后再试；如果持续超时，请检查服务状态和网络连接。',
  },
  service_unavailable: {
    description: '模型服务暂时不可用，或处理请求时发生故障。',
    suggestion: '请稍后再试；如果持续失败，请检查模型服务的运行状态。',
  },
  stream_incomplete: {
    description: '模型服务的回复提前结束，未收到完整结果。',
    suggestion: '请检查服务状态及网络或代理连接，稍后再试。已有消息和执行结果已保留。',
  },
  connection_failed: {
    description: '无法与模型服务建立连接，重连后仍未恢复。',
    suggestion: '请检查网络、代理和模型服务地址，确认服务可以访问后再试。',
  },
};
function readableFailure(execution: NativeToolExecution) {
  const result = execution.result;
  const failure =
    result && typeof result === 'object' && !Array.isArray(result) ? result.modelFailure : null;
  const detail =
    failure && typeof failure === 'object' && !Array.isArray(failure) ? failure.detail : null;
  if (typeof detail === 'string' && Object.hasOwn(failures, detail))
    return failures[detail as keyof typeof failures];
  const code = result && typeof result === 'object' && !Array.isArray(result) ? result.code : null;
  return code === 'MODEL_ATTEMPT_RETRYABLE_FAILURE:provider_unavailable'
    ? failures.service_unavailable
    : code === 'MODEL_ATTEMPT_RETRYABLE_FAILURE:stream_incomplete'
      ? failures.stream_incomplete
      : failures.connection_failed;
}
function retryable(execution: NativeToolExecution) {
  const result = execution.result;
  return (
    execution.status === 'failed' &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    result.incomplete === true &&
    reasons.some((reason) => result.code === `MODEL_ATTEMPT_RETRYABLE_FAILURE:${reason}`)
  );
}

/** One process row per actual retry chain; no new attempt or failure inferred from elapsed time. */
export function nativeModelConnections(
  modeled: DesktopMessage[],
  messages: readonly Message[],
  executions: readonly NativeToolExecution[],
  runs: ReadonlyMap<string, NativeRunFact>,
  storeId: string,
  sessionId: string,
  identity: (runId: string) => string,
) {
  const models = executions.filter(
    (execution) =>
      execution.kind === 'model' &&
      execution.originStoreId === storeId &&
      execution.sessionId === sessionId &&
      execution.runId &&
      runs.has(execution.runId),
  );
  const roots = new Map<string, string>();
  const chains = new Map<string, NativeToolExecution>();
  const latestByRun = new Map<string, NativeToolExecution>();
  const byId = new Map(models.map((execution) => [execution.id, execution]));
  for (const execution of models) {
    latestByRun.set(execution.runId!, execution);
    const retry = execution.modelRetry;
    if (
      retry &&
      Number.isSafeInteger(retry.attempt) &&
      retry.attempt >= 2 &&
      reasons.includes(retry.reason) &&
      retry.previousExecutionId !== execution.id
    ) {
      const previous = byId.get(retry.previousExecutionId);
      if (previous && (previous.runId !== execution.runId || previous.status !== 'failed'))
        continue;
      const root = roots.get(retry.previousExecutionId) ?? retry.previousExecutionId;
      roots.set(execution.id, root);
      chains.set(root, execution);
    }
    if (retryable(execution)) {
      const root = roots.get(execution.id) ?? execution.id;
      roots.set(execution.id, root);
      chains.set(root, execution);
    }
  }
  const originals = new Map(messages.map((message) => [message.id, message]));
  for (const [root, execution] of chains) {
    const run = runs.get(execution.runId!)!;
    const turnId = identity(run.id);
    const receiving = messages.some(
      (message) =>
        !message.originMessage &&
        message.sessionId === sessionId &&
        message.runId === run.id &&
        message.sourceIds?.includes(execution.id) &&
        (message.firstOutput || message.content),
    );
    const connected = execution.status === 'succeeded' || (receiving && !retryable(execution));
    const cancelled = run.status === 'cancelled' || execution.status === 'cancelled';
    const maximumAttempts = execution.modelRetry?.maxAttempts ?? 6;
    const attempts = execution.modelRetry?.attempt ?? 1;
    const canRetry = attempts < maximumAttempts;
    const exhausted =
      !run.isActive &&
      run.status === 'failed' &&
      run.reason === 'model_reconnect_exhausted' &&
      latestByRun.get(run.id)?.id === execution.id;
    const finishing = run.isActive && run.status === 'running' && !canRetry && retryable(execution);
    const stopping =
      run.isActive &&
      run.status === 'cancelling' &&
      !connected &&
      latestByRun.get(run.id)?.id === execution.id;
    const pending =
      run.isActive &&
      run.status === 'running' &&
      !connected &&
      latestByRun.get(run.id)?.id === execution.id &&
      ((retryable(execution) && canRetry) ||
        ['planned', 'dispatching', 'running'].includes(execution.status));
    const attempt = attempts - 1 + (pending && retryable(execution) ? 1 : 0);
    const row: DesktopMessage = {
      id: `native-model-connection:${identity(run.id)}:${root}`,
      turnId,
      role: 'system',
      systemKind: 'model_connection',
      title: connected
        ? '已重新连接模型服务'
        : exhausted
          ? '重连失败'
          : pending
            ? '正在重新连接模型服务'
            : stopping
              ? '正在停止重新连接'
              : cancelled
                ? '重新连接已停止'
                : '重新连接未完成',
      text:
        execution.modelRetry?.maxAttempts === null
          ? `第 ${attempt} 次重连`
          : `第 ${attempt}/${maximumAttempts - 1} 次重连`,
      ...(exhausted ? { modelConnectionFailure: readableFailure(execution) } : {}),
      settled: !pending && !stopping && !finishing,
      status: connected
        ? 'completed'
        : pending || stopping
          ? 'running'
          : finishing
            ? 'waiting'
            : cancelled
              ? 'cancelled'
              : 'failed',
    };
    // Keep the row before its retry output or subsequent work, after the original
    // attempt's partial text. The surrounding Turn owns collapse and reading state.
    const rootIndex = executions.findIndex((candidate) => candidate.id === root);
    const firstRetryIndex = executions.findIndex(
      (candidate) => candidate.id !== root && roots.get(candidate.id) === root,
    );
    const following = new Set(
      executions
        .slice(rootIndex >= 0 ? rootIndex + 1 : firstRetryIndex)
        .map((candidate) => candidate.id),
    );
    let index = modeled.findIndex(
      (message) =>
        message.turnId === turnId &&
        originals.get(message.id)?.sourceIds?.some((id) => following.has(id)),
    );
    if (index < 0) {
      index = modeled.length;
      for (let position = modeled.length - 1; position >= 0; position--)
        if (
          modeled[position]!.turnId === turnId &&
          !['turn_timing', 'turn_terminal'].includes(modeled[position]!.systemKind ?? '')
        ) {
          index = position + 1;
          break;
        }
    }
    modeled.splice(index, 0, row);
  }
}
