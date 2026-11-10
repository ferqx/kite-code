import { type ToolResultPresentation, toolResultPresentationSchema } from '@kite-ai/trajectory';
import { MessageContent } from '../MessageContent';

const metadataLabels: Record<string, string> = {
  operation: '操作',
  kind: '结果类型',
  status: '原状态',
  accepted: '已接纳',
  exitCode: '退出码',
  timedOut: '超时',
  cancelRequested: '取消已请求',
  executionId: '原执行',
  shellId: '后台会话',
  terminal: '确定终态',
  nextCursor: '后续读取位置',
  caughtUp: '已读至当前',
  path: '原路径',
  startLine: '起始行',
  endLine: '结束行',
  bytes: '字节数',
  title: '标题',
  url: '网址',
  characters: '已保存字符',
  contentType: '内容类型',
  version: '原版本',
  runId: '原执行轮次',
  agentId: '子 Agent',
  delivery: '投递状态',
  name: '名称',
  mutation: '操作类型',
  code: '原结果代码',
  replayed: '原操作回执',
  cwdChanged: '工作目录变化',
  truncated: '已截断',
  planId: '原计划',
  sequence: '快照序号',
  state: '页面状态',
};

const planStatuses: Record<string, string> = {
  pending: '待处理',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '受阻',
  compensated: '已补偿',
  approved: '已批准',
  not_approved: '未批准',
  cancelled: '已取消',
  draft: '草稿',
  outcome_unknown: '结果未知',
};
function Metadata({
  value,
  labels = {},
  statusLabels,
}: {
  value: object;
  labels?: Record<string, string>;
  statusLabels?: Record<string, string>;
}) {
  const statuses: Record<string, string> = {
    queued: '排队中',
    planned: '已计划',
    dispatching: '启动中',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已停止',
    outcome_unknown: '结果未知',
    pending: '等待交付',
    consumed: '父级已接收',
    suppressed: '未交付',
  };
  const operations: Record<string, string> = {
    read: '读取',
    write: '写入',
    edit: '编辑',
    execute: '运行命令',
    launch: '后台启动',
    wait: '等待结果',
    stop: '请求停止',
    spawn: '创建子 Agent',
    follow_up: '继续子 Agent',
    message: '发送消息',
    events: '观察任务',
    list: '查询任务',
    interrupt: '请求停止',
    load: '加载',
    resource: '读取资料',
    update: '更新',
    review: '评审',
    create: '创建',
    remove: '移除',
    open: '打开页面',
    snapshot: '读取快照',
    click: '点击',
    fill: '填写',
    scroll: '滚动',
    press: '按键',
    hover: '悬停',
    select: '选择',
    back: '后退',
    forward: '前进',
    reload: '重新加载',
    close: '关闭',
    capture: '截图',
    image: '读取图片',
    view: '查看',
    request_human: '请求人工操作',
  };
  return (
    <dl className="trajectory-metadata">
      {Object.entries(value)
        .filter(
          ([key, item]) =>
            item !== undefined &&
            typeof item !== 'object' &&
            !['executionId', 'shellId', 'nextCursor', 'runId', 'agentId', 'planId'].includes(key),
        )
        .map(([key, item]) => (
          <div className="trajectory-metadata-pair" key={key}>
            <dt>{labels[key] ?? metadataLabels[key] ?? key}</dt>
            <dd>
              {typeof item === 'boolean'
                ? item
                  ? '是'
                  : '否'
                : key === 'operation' && typeof item === 'string'
                  ? (operations[item] ?? item)
                  : ['status', 'delivery'].includes(key) && typeof item === 'string'
                    ? ((key === 'status' ? statusLabels?.[item] : undefined) ??
                      statuses[item] ??
                      item)
                    : String(item)}
            </dd>
          </div>
        ))}
    </dl>
  );
}
function ReceiptInfo({ value }: { value: object }) {
  if (!Object.values(value).some((item) => item !== undefined)) return null;
  return (
    <details className="trajectory-result-receipt">
      <summary>回执信息</summary>
      <Metadata value={value} />
    </details>
  );
}
function SavedText({ text, formatted = false }: { text: string; formatted?: boolean }) {
  if (text === '') return <p role="status">已保存的正文为空。</p>;
  return formatted ? <MessageContent text={text} streaming={false} /> : <pre>{text}</pre>;
}
function Presentation({ value }: { value: ToolResultPresentation }) {
  if (value.kind === 'shell')
    return (
      <>
        <Metadata
          value={{ status: value.status, exitCode: value.exitCode }}
          labels={{ status: '目标命令状态' }}
        />
        <ReceiptInfo
          value={{
            operation: value.operation,
            accepted: value.accepted,
            timedOut: value.timedOut,
            cancelRequested: value.cancelRequested,
            terminal: value.terminal,
            caughtUp: value.caughtUp,
          }}
        />
        {value.accepted && !value.terminal && <p role="status">接纳回执不表示后台任务已经完成。</p>}
        {value.operation === 'wait' && value.timedOut && (
          <p role="status">本次等待超时，命令不会因此停止。</p>
        )}
        {value.cancelRequested && !value.terminal && (
          <p role="status">已请求停止；尚未确认命令结束。</p>
        )}
        {value.stdout && (
          <section>
            <h4>stdout</h4>
            <pre>{value.stdout}</pre>
          </section>
        )}
        {value.stderr && (
          <section>
            <h4>stderr</h4>
            <pre>{value.stderr}</pre>
          </section>
        )}
        {value.output
          ?.filter(
            (item) =>
              item.stream === 'gap' ||
              item.content.length > 0 ||
              (item.droppedBytes !== undefined && item.droppedBytes !== '0'),
          )
          .filter(
            (item, index, items) =>
              items.findIndex(
                (other) =>
                  other.sequence === item.sequence &&
                  other.throughSequence === item.throughSequence &&
                  other.stream === item.stream &&
                  other.content === item.content &&
                  other.droppedBytes === item.droppedBytes,
              ) === index,
          )
          .map((item, index) => (
            <section key={`${item.sequence}:${item.stream}:${index}`}>
              <h4>
                {item.stream} · #{item.sequence}–{item.throughSequence}
              </h4>
              {item.stream === 'gap' ? (
                <>
                  <p role="status">此处输出缺失 · 丢弃 {item.droppedBytes ?? '未记录'} 字节</p>
                  {item.content.length > 0 && <pre>{item.content}</pre>}
                </>
              ) : (
                <>
                  {item.content.length > 0 && <pre>{item.content}</pre>}
                  {item.droppedBytes !== undefined && item.droppedBytes !== '0' && (
                    <p role="status">此段输出不完整 · 丢弃 {item.droppedBytes} 字节</p>
                  )}
                </>
              )}
            </section>
          ))}
        {!value.stdout &&
          !value.stderr &&
          !value.output?.some(
            (item) =>
              item.stream === 'gap' ||
              item.content.length > 0 ||
              (item.droppedBytes !== undefined && item.droppedBytes !== '0'),
          ) && (
            <p role="status">
              {value.stdout !== undefined ||
              value.stderr !== undefined ||
              value.output !== undefined
                ? '本次回执保存的命令输出为空。'
                : '本次回执未包含命令输出。'}
            </p>
          )}
        {value.truncated && <p role="status">原输出已截断。</p>}
        {value.droppedBytes !== undefined && <p>丢弃字节：{value.droppedBytes}</p>}
      </>
    );
  if (value.kind === 'file')
    return (
      <>
        <Metadata
          value={{
            operation: value.operation,
            path: value.path,
            startLine: value.startLine,
            endLine: value.endLine,
            bytes: value.bytes,
          }}
        />
        {value.text !== undefined && <SavedText text={value.text} />}
        {value.truncated && <p role="status">文件内容仅保留原读取窗口或截断片段。</p>}
      </>
    );
  if (value.kind === 'browser')
    return (
      <>
        <Metadata
          value={{
            title: value.title,
            url: value.url,
            state: value.state,
          }}
        />
        <ReceiptInfo value={{ operation: value.operation, sequence: value.sequence }} />
        {value.text !== undefined && <SavedText text={value.text} />}
        {value.elements !== undefined ? (
          value.elements.length ? (
            <ul>
              {value.elements.map((element, index) => (
                <li key={`${element.role}:${index}`}>
                  {element.role} · {element.name ?? '未命名'}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">该次快照未列出页面元素。</p>
          )
        ) : value.operation === 'snapshot' ? (
          <p role="status">此版本未保存页面元素列表。</p>
        ) : null}
      </>
    );
  if (value.kind === 'web')
    return (
      <>
        <Metadata value={{ title: value.title, url: value.url }} />
        <ReceiptInfo
          value={{
            contentType: value.contentType,
            characters: value.characters,
            truncated: value.truncated,
          }}
        />
        {value.truncated && <p role="status">网页文本已截断。</p>}
      </>
    );
  if (value.kind === 'task')
    return (
      <>
        <Metadata
          value={{ accepted: value.accepted, status: value.status, delivery: value.delivery }}
          labels={{ accepted: '本次投递受理', status: '子任务工作状态', delivery: '结果交付' }}
        />
        <ReceiptInfo value={{ operation: value.operation }} />
        {value.accepted && <p role="status">本次投递已接纳；这不是子任务最终结果。</p>}
      </>
    );
  if (value.kind === 'worktree')
    return (
      <>
        <Metadata
          value={{
            path: value.path,
            mutation: value.mutation,
            cwdChanged: value.cwdChanged,
            code: value.code,
          }}
          labels={{ path: '工作树路径' }}
        />
        <ReceiptInfo value={{ operation: value.operation, replayed: value.replayed }} />
      </>
    );
  if (value.kind === 'plan' || value.kind === 'skill')
    return (
      <>
        <Metadata
          value={
            value.kind === 'plan'
              ? { title: value.title, status: value.status }
              : { name: value.name }
          }
          labels={{ status: '计划状态' }}
          statusLabels={value.kind === 'plan' ? planStatuses : undefined}
        />
        <ReceiptInfo value={{ operation: value.operation, version: value.version }} />
        {value.text !== undefined && <SavedText text={value.text} formatted />}
        {value.kind === 'plan' &&
          (value.steps !== undefined ? (
            value.steps.length ? (
              <ol className="trajectory-plan-steps">
                {value.steps.map((step) => (
                  <li key={step.id}>
                    <span>{step.title}</span>
                    {step.status !== undefined && (
                      <small>{planStatuses[step.status] ?? step.status}</small>
                    )}
                    <span className="sr-only">{step.id}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p role="status">已保存的计划步骤列表为空。</p>
            )
          ) : (
            <p role="status">此版本未保存计划步骤列表。</p>
          ))}
      </>
    );
  if (value.kind === 'question')
    return (
      <>
        <h4>{value.title ?? '已保存问答'}</h4>
        {value.answers !== undefined ? (
          value.answers.length ? (
            value.answers.map((item, index) => (
              <section key={index}>
                <h4>{item.question}</h4>
                {item.answer === '' ? <p>已保存的答复为空。</p> : <p>{item.answer}</p>}
              </section>
            ))
          ) : (
            <p role="status">已保存的答复列表为空。</p>
          )
        ) : (
          <p role="status">此版本未保存答复项。</p>
        )}
      </>
    );
  if (value.kind === 'mcp')
    return (
      <>
        <p>{value.isError ? '工具返回错误' : '工具已返回'}</p>
        {value.text.map((text, index) => (
          <SavedText key={index} text={text} />
        ))}
        {value.structuredContent !== undefined && (
          <section aria-label="结构化结果">
            <h4>结构化结果</h4>
            <pre className="trajectory-json">
              {JSON.stringify(value.structuredContent, null, 2)}
            </pre>
          </section>
        )}
      </>
    );
  return <Metadata value={value} />;
}
function containsExactText(value: ToolResultPresentation | undefined, text: string): boolean {
  if (!value) return false;
  switch (value.kind) {
    case 'shell':
      return (
        value.stdout === text ||
        value.stderr === text ||
        value.output?.some((item) => item.content === text) === true
      );
    case 'file':
    case 'browser':
    case 'plan':
    case 'skill':
      return value.text === text;
    case 'mcp':
      return value.text.includes(text);
    case 'question':
      return value.answers?.some((item) => item.answer === text) === true;
    default:
      return false;
  }
}
/** Only owner-sealed public display data; no live ToolActivity actions or current file reads. */
export function TrajectoryResult({ data, fallback }: { data: unknown; fallback?: string }) {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  const presentation = toolResultPresentationSchema.safeParse(body?.presentation);
  const value = presentation.success ? presentation.data : undefined;
  const containsBody =
    value &&
    ((value.kind === 'shell' &&
      (value.stdout !== undefined ||
        value.stderr !== undefined ||
        Boolean(value.output?.length))) ||
      (value.kind === 'file' && value.text !== undefined) ||
      (value.kind === 'browser' && value.text !== undefined) ||
      ((value.kind === 'plan' || value.kind === 'skill') && value.text !== undefined) ||
      (value.kind === 'plan' && Boolean(value.steps?.length)) ||
      (value.kind === 'mcp' && (value.text.length > 0 || value.structuredContent !== undefined)) ||
      (value.kind === 'question' && Boolean(value.answers?.length)));
  const exceptionalContent =
    ['failed', 'cancelled', 'outcome_unknown'].includes(String(body?.outcome)) &&
    typeof body?.content === 'string' &&
    (!containsBody || body.content.length > 0) &&
    !containsExactText(value, body.content);
  return (
    <div className="trajectory-tool-result">
      {typeof body?.outcome === 'string' && (!value || body.outcome !== 'succeeded') && (
        <p className="trajectory-material-notice">
          {value?.kind === 'shell' || value?.kind === 'task' ? '本次工具回执：' : '执行结果：'}
          {(
            {
              succeeded: value?.kind === 'shell' || value?.kind === 'task' ? '已返回' : '已完成',
              failed: '失败',
              cancelled: '已取消',
              outcome_unknown: '结果未知',
            } as Record<string, string>
          )[body.outcome] ?? body.outcome}
        </p>
      )}
      {presentation.success && <Presentation value={presentation.data} />}
      {(exceptionalContent || !containsBody) &&
        (typeof body?.content === 'string' ? (
          value && value.kind !== 'web' && !exceptionalContent ? (
            <details className="trajectory-result-receipt">
              <summary>工具返回内容</summary>
              <SavedText text={body.content} formatted />
            </details>
          ) : (
            <SavedText text={body.content} formatted />
          )
        ) : fallback !== undefined ? (
          <SavedText text={fallback} formatted />
        ) : (
          !presentation.success && (
            <pre className="trajectory-json">{JSON.stringify(data, null, 2)}</pre>
          )
        ))}
    </div>
  );
}

/** A retained command checkpoint is a preview, never a reconstruction of current stdout. */
export function TrajectoryJobOutput({ data, fallback }: { data: unknown; fallback?: string }) {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  if (body?.contentMode !== 'retained_preview' || !Array.isArray(body.items))
    return <pre>{fallback ?? JSON.stringify(data, null, 2)}</pre>;
  const streams: Record<string, string> = {
    stdout: '标准输出',
    stderr: '标准错误',
    progress: '执行输出',
  };
  const seen = new Set<string>();
  const items = body.items.flatMap((value) => {
    const item =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    if (!item || typeof item.content !== 'string') return [];
    const key = JSON.stringify([
      item.seq,
      item.throughSeq,
      item.stream,
      item.content,
      item.droppedBytes,
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
  const gaps = Array.isArray(body.gaps) ? body.gaps : [];
  const visibleItems = items.filter(
    (item) =>
      item.stream === 'gap' ||
      String(item.content).length > 0 ||
      (typeof item.droppedBytes === 'string' && item.droppedBytes !== '0'),
  );
  return (
    <section aria-label="原命令输出">
      <section aria-label="已保存命令文本">
        {visibleItems.length ? (
          visibleItems.map((item, index) => (
            <section key={index}>
              <h4>
                {streams[String(item.stream)] ?? (item.stream === 'gap' ? '输出缺口' : '输出')} · #
                {String(item.seq)}
                {item.throughSeq !== undefined && item.throughSeq !== item.seq
                  ? `–${String(item.throughSeq)}`
                  : ''}
              </h4>
              {item.stream === 'gap' ? (
                <>
                  <p role="status">
                    此处输出缺失 · 丢弃{' '}
                    {typeof item.droppedBytes === 'string' ? item.droppedBytes : '未记录'} 字节
                  </p>
                  {String(item.content).length > 0 && <pre>{String(item.content)}</pre>}
                </>
              ) : (
                <>
                  {String(item.content).length > 0 && <pre>{String(item.content)}</pre>}
                  {typeof item.droppedBytes === 'string' && item.droppedBytes !== '0' && (
                    <p role="status">此段输出不完整 · 丢弃 {item.droppedBytes} 字节</p>
                  )}
                </>
              )}
            </section>
          ))
        ) : (
          <p role="status">
            {body.items.length && !items.length
              ? '此版本的输出记录格式无法识别。'
              : items.length
                ? '该封存检查点保存的输出文本为空。'
                : '该封存检查点没有输出文本记录。'}
          </p>
        )}
      </section>
      {gaps.length > 0 && (
        <section aria-label="已记录输出缺口">
          <h4>输出缺口</h4>
          <ul>
            {gaps.map((value, index) => {
              const gap =
                value && typeof value === 'object' && !Array.isArray(value)
                  ? (value as Record<string, unknown>)
                  : undefined;
              return (
                <li key={index}>
                  {gap &&
                  typeof gap.stream === 'string' &&
                  typeof gap.fromSeq === 'string' &&
                  typeof gap.throughSeq === 'string' &&
                  typeof gap.droppedBytes === 'string' ? (
                    <p role="status">
                      {streams[gap.stream] ?? gap.stream} · #{gap.fromSeq}–{gap.throughSeq} · 丢弃{' '}
                      {gap.droppedBytes} 字节
                    </p>
                  ) : (
                    <pre>{JSON.stringify(value, null, 2)}</pre>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}

export function TrajectoryFileChange({ data }: { data: unknown }) {
  const value =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  if (
    !value ||
    typeof value.text !== 'string' ||
    !['line_diff', 'file_content'].includes(String(value.format))
  )
    return <pre className="trajectory-json">{JSON.stringify(data, null, 2)}</pre>;
  return (
    <section className="trajectory-file-change">
      <h4>{typeof value.path === 'string' ? value.path : '原文件变更'}</h4>
      <p>{value.format === 'line_diff' ? '已保存的原差异' : '已保存的原文件内容'}</p>
      <pre>
        {value.text.split('\n').map((line, index) => (
          <span
            key={index}
            className={
              value.format === 'line_diff'
                ? line.startsWith('+')
                  ? 'trajectory-diff-added'
                  : line.startsWith('-')
                    ? 'trajectory-diff-removed'
                    : undefined
                : undefined
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      {value.truncated === true && <p role="status">原差异已截断，未保存内容不可还原。</p>}
    </section>
  );
}
