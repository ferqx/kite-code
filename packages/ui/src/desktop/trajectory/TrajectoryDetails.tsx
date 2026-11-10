import {
  ArrowRight01Icon,
  Cancel01Icon,
  Search01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  parseDecimal64,
  type TrajectoryDisplay,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
} from '@kite-ai/trajectory';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '../components/ui/code-block';
import { Input } from '../components/ui/input';
import { ScrollArea } from '../components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { MessageContent } from '../MessageContent';
import { highlightMarkdownCode } from '../markdown-highlight';
import { Button } from '../ui';
import { TrajectoryExecutionTiming, TrajectoryRequestMetrics } from './DetailMetrics';
import { TrajectoryAttachments, TrajectoryMessageImages } from './TrajectoryAttachments';
import { TrajectoryInteraction } from './TrajectoryInteraction';
import { TrajectoryContextSelection, TrajectoryDelegation } from './TrajectoryOperationContent';
import type { TrajectoryEvidenceView, TrajectoryMaterialTarget } from './TrajectoryPanel';
import { TrajectoryFileChange, TrajectoryJobOutput, TrajectoryResult } from './TrajectoryResult';
import type { TrajectoryTreeNode } from './tree';
import type { TrajectoryDetailTab } from './view-state';
import type { WorkbenchRow } from './workbench';
import {
  trajectoryCompressionMetadata,
  trajectoryDetailTabs,
  trajectoryMaterialTargets,
  trajectoryModelRequestGroups,
  trajectoryRequestUserMessages,
  trajectorySelectedMember,
  trajectorySelectedObservation,
} from './workbench-details';

export const trajectoryPhaseLabels: Record<string, string> = {
  planned: '已计划',
  dispatching: '派发中',
  running: '运行中',
  waiting_interaction: '等待回答',
  waiting_execution: '等待执行',
  cancelling: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  outcome_unknown: '结果未知',
  observed: '已记录',
};
/** Display labels use only verified lightweight metadata; no body summaries are inferred. */
export function trajectoryTypeBadge(row: WorkbenchRow): { label: string; tone: string } {
  if (row.virtualPart)
    return {
      label: { system: '系统', input: '输入', thinking: '思考', reply: '输出' }[
        row.virtualPart.kind
      ],
      tone: { system: 'neutral', input: 'user', thinking: 'model', reply: 'assistant' }[
        row.virtualPart.kind
      ],
    };
  if (row.category === 'compression')
    return { label: row.kind === 'model' ? '自动压缩' : '压缩', tone: 'compression' };
  if (row.category === 'approval') return { label: '审批', tone: 'approval' };
  if (row.kind === 'message')
    return row.step?.messageRole === 'user'
      ? { label: '用户', tone: 'user' }
      : row.step?.messageRole === 'assistant'
        ? { label: '助手', tone: 'assistant' }
        : { label: '消息', tone: 'user' };
  if (row.kind === 'model') return { label: '决策', tone: 'model' };
  if (row.kind === 'run' && row.loop !== undefined) return { label: 'Agent', tone: 'model' };
  if (row.operation?.type === 'shell') return { label: 'Shell', tone: 'tool' };
  if (row.operation?.type === 'child') return { label: '子 Agent', tone: 'tool' };
  if (row.kind === 'tool') return { label: '工具', tone: 'tool' };
  if (row.kind === 'job' || row.kind === 'child') return { label: '子任务', tone: 'tool' };
  return {
    label:
      (
        {
          session: '会话',
          run: '轮次',
          interaction: '交互',
          context: '上下文',
          recovery: '恢复',
          artifact: '产物',
          verification: '核验',
          command: '命令',
          unknown: '记录',
        } as Record<string, string>
      )[row.kind] ?? '记录',
    tone: 'neutral',
  };
}
const tabLabels: Record<Exclude<TrajectoryDetailTab, 'raw'>, string> = {
  overview: '概述',
  preview: '预览',
  parameters: '参数',
  result: '结果',
  system_prompt: '系统提示词',
  tools: '工具',
  content: '内容',
  thinking: '思考',
  request_info: '请求信息',
};
function readableDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} 毫秒`
    : `${Number((milliseconds / 1000).toFixed(2))} 秒`;
}
const materialLabels: Record<string, string> = {
  model_input: '已保存请求',
  model_output: '公开输出',
  tool_input: '执行请求 JSON',
  tool_result: '工具返回',
  job_output: '后台输出',
  message: '消息正文',
  context: '上下文与保留范围',
  interaction: '原请求与决定',
  artifact: '原产物',
  file_change: '原文件变更',
  verification: '原检查结论',
};
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}
function savedModelName(data: unknown): string | undefined {
  const adapter = record(record(record(data)?.metadata)?.adapter);
  const provider = record(adapter?.provider);
  return adapter?.availability === 'available' &&
    provider?.availability === 'available' &&
    typeof provider.modelId === 'string'
    ? provider.modelId || undefined
    : undefined;
}
function ThoughtPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long = text.length > 1000 || text.split('\n').length > 12;
  return (
    <div className="trajectory-thought-preview" data-expanded={!long || expanded}>
      <div id={id} className="trajectory-thought-body">
        <MessageContent text={text} streaming={false} />
      </div>
      {long && (
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起思考' : '展开全部思考'}
        </Button>
      )}
    </div>
  );
}
function TrajectoryJson({ text, title = 'JSON' }: { text: string; title?: string }) {
  const [expanded, setExpanded] = useState(true);
  const highlighted = useMemo(() => highlightMarkdownCode(text, 'json'), [text]);
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <Button
            size="xs"
            variant="ghost"
            aria-label={expanded ? '收起 JSON' : '展开 JSON'}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : '展开'}
          </Button>
          <CodeBlockCopyButton value={text} />
        </CodeBlockActions>
      </CodeBlockHeader>
      {expanded && (
        <CodeBlockContent wrap codeClassName="language-json" aria-label="原公开 JSON">
          {highlighted}
        </CodeBlockContent>
      )}
    </CodeBlock>
  );
}

function ModelRequestPreview({
  data,
  fallback,
  approvalCheck = false,
}: {
  data: unknown;
  fallback?: string;
  approvalCheck?: boolean;
}) {
  const groups = trajectoryModelRequestGroups(data);
  if (!groups)
    return fallback !== undefined ? (
      <pre>{fallback}</pre>
    ) : (
      <TrajectoryJson text={json(data) ?? ''} />
    );
  const modelName = savedModelName(data);
  const message = (value: Record<string, unknown>, index: number) => (
    <section key={index}>
      <h4>
        {approvalCheck && value.role === 'user'
          ? '检查内容'
          : ((
              {
                system: '系统指令',
                user: '用户／上下文',
                assistant: 'Agent',
                tool: '工具结果',
              } as Record<string, string>
            )[String(value.role)] ?? String(value.role))}{' '}
        · {index + 1}
      </h4>
      {typeof value.content === 'string' ? (
        <MessageContent text={value.content} streaming={false} />
      ) : (
        <TrajectoryJson title="原消息内容" text={json(value.content) ?? 'null'} />
      )}
      {Array.isArray(value.toolCalls) && value.toolCalls.length > 0 && (
        <details>
          <summary>本消息中的工具请求 · {value.toolCalls.length} 个</summary>
          <TrajectoryJson title="已保存工具请求" text={json(value.toolCalls)} />
        </details>
      )}
      <TrajectoryMessageImages images={value.images} />
    </section>
  );
  if (approvalCheck)
    return (
      <section aria-label="审批检查请求">
        {groups.messages.map(message)}
        {groups.system.length > 0 && (
          <details>
            <summary>检查规则 · {groups.system.length} 条</summary>
            {groups.system.map(message)}
          </details>
        )}
        {groups.tools.length > 0 && (
          <details>
            <summary>检查可用工具 · {groups.tools.length} 个</summary>
            <TrajectoryJson title="检查工具目录" text={json(groups.tools)} />
          </details>
        )}
      </section>
    );
  return (
    <section aria-label="本次请求准备">
      <p className="trajectory-material-notice">
        本次准确保存的模型输入；指令、消息和工具按原请求分组。
      </p>
      <p>请求模型：{modelName || '模型名称未记录'}</p>
      <details open>
        <summary>系统提示词与指令 · {groups.system.length} 条</summary>
        {groups.system.length ? (
          groups.system.map(message)
        ) : (
          <p>本次请求没有单独的系统指令消息。</p>
        )}
      </details>
      <details>
        <summary>对话与工具结果 · {groups.messages.length} 条</summary>
        {groups.messages.map(message)}
      </details>
      <details>
        <summary>可用工具 · {groups.tools.length} 个</summary>
        <TrajectoryJson title="原工具目录" text={json(groups.tools)} />
      </details>
    </section>
  );
}
function ModelOutputPreview({
  data,
  fallback,
  approvalCheck = false,
}: {
  data: unknown;
  fallback?: string;
  approvalCheck?: boolean;
}) {
  const output = record(data);
  const reasoning = typeof output?.reasoning === 'string' ? output.reasoning : '';
  const content = typeof output?.content === 'string' ? output.content : (fallback ?? '');
  const toolCalls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  if (approvalCheck && toolCalls.length === 0)
    return (
      <section aria-label="审批检查结果">
        {content ? (
          <MessageContent text={content} streaming={false} />
        ) : (
          <p>此版本没有保存检查结果正文。</p>
        )}
        {reasoning && (
          <details>
            <summary>已保存的检查思考</summary>
            <MessageContent text={reasoning} streaming={false} />
          </details>
        )}
      </section>
    );
  return (
    <section aria-label="Agent 输出">
      <section aria-label="Agent 思考">
        <h4>思考</h4>
        {reasoning ? <ThoughtPreview text={reasoning} /> : <p>未保存可展示的思考。</p>}
      </section>
      {toolCalls.length > 0 && (
        <section aria-label="发起的工具调用">
          <h4>发起的工具调用 · {toolCalls.length}</h4>
          {toolCalls.map((value, index) => {
            const call = record(value);
            return typeof call?.name === 'string' && typeof call.arguments === 'string' ? (
              <section key={index}>
                <h4>{call.name}</h4>
                <pre>{call.arguments}</pre>
              </section>
            ) : null;
          })}
          <p className="trajectory-material-notice">
            这里只记录模型发起的请求，执行结果见对应工具。
          </p>
        </section>
      )}
      <section aria-label="Agent 本次输出">
        <h4>{toolCalls.length ? 'Agent 说明' : '本次输出'}</h4>
        {content ? (
          <MessageContent text={content} streaming={false} />
        ) : (
          <p>此版本没有保存回复正文。</p>
        )}
      </section>
    </section>
  );
}
function RequestToolsPreview({ data }: { data: unknown }) {
  const [query, setQuery] = useState('');
  const groups = trajectoryModelRequestGroups(data);
  if (!groups) return <p role="status">此版本没有可识别的已保存工具目录。</p>;
  const search = query.trim().toLocaleLowerCase();
  const matches = groups.tools.map((value) => {
    const tool = record(value);
    return (
      !search ||
      [tool?.id, tool?.description].some(
        (text) => typeof text === 'string' && text.toLocaleLowerCase().includes(search),
      )
    );
  });
  const matchedCount = matches.filter(Boolean).length;
  return (
    <section className="trajectory-request-tools" aria-label="本次请求的工具目录">
      <header className="trajectory-request-tools-header">
        <span aria-live="polite" aria-atomic="true">
          {search ? `${matchedCount} / ${groups.tools.length}` : groups.tools.length} 个工具
        </span>
      </header>
      {groups.tools.length > 0 ? (
        <>
          <div className="trajectory-request-tools-search">
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            <Input
              type="search"
              aria-label="搜索工具名称或说明"
              placeholder="搜索工具名称或说明"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <ul className="trajectory-request-tools-list" aria-label="工具定义">
            {groups.tools.map((value, index) => {
              const tool = record(value);
              return (
                <li key={index} hidden={!matches[index]}>
                  {typeof tool?.id === 'string' ? (
                    <RequestTool tool={tool} />
                  ) : (
                    <p>此项已保存的工具定义格式无法识别。</p>
                  )}
                </li>
              );
            })}
          </ul>
          {matchedCount === 0 && <p role="status">没有匹配的工具。</p>}
        </>
      ) : (
        <p>本次请求没有工具定义。</p>
      )}
    </section>
  );
}
function RequestTool({ tool }: { tool: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const description = typeof tool.description === 'string' ? tool.description : '';
  const summary = description.slice(0, 320).replace(/\s+/gu, ' ').trim();
  return (
    <details
      className="trajectory-request-tool"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <HugeiconsIcon
          className="trajectory-request-tool-chevron"
          icon={ArrowRight01Icon}
          aria-hidden="true"
        />
        <HugeiconsIcon
          className="trajectory-request-tool-icon"
          icon={Wrench01Icon}
          aria-hidden="true"
        />
        <span className="trajectory-request-tool-copy">
          <span className="trajectory-request-tool-name" title={String(tool.id)}>
            {String(tool.id)}
          </span>
          {!expanded && (
            <span className="trajectory-request-tool-description">
              {summary || '未保存工具描述。'}
            </span>
          )}
        </span>
      </summary>
      {expanded && (
        <div className="trajectory-request-tool-body">
          <h4>工具说明</h4>
          {description ? (
            <MessageContent text={description} streaming={false} />
          ) : (
            <p>未保存工具描述。</p>
          )}
          {record(tool.inputSchema) ? (
            <TrajectoryJson title="参数定义" text={json(tool.inputSchema)} />
          ) : (
            <p>未保存可识别的参数定义。</p>
          )}
        </div>
      )}
    </details>
  );
}
function VirtualPartPreview({
  kind,
  data,
  tab,
  event,
  reference,
  complete,
}: {
  kind: NonNullable<WorkbenchRow['virtualPart']>['kind'];
  data: unknown;
  tab: TrajectoryDetailTab;
  event?: TrajectoryEvent;
  reference?: TrajectoryEvidenceRef;
  complete: boolean;
}) {
  if (tab === 'tools') return <RequestToolsPreview data={data} />;
  if (kind === 'system' || kind === 'input') {
    const groups = trajectoryModelRequestGroups(data);
    if (!groups) return <p role="status">已保存请求的格式无法识别，暂时无法展示此阶段内容。</p>;
    const messages =
      kind === 'system'
        ? groups.system
        : [...trajectoryRequestUserMessages(data, { event, complete })];
    const sections = kind === 'system' ? [messages] : messages.map((message) => [message]);
    return (
      <section aria-label={kind === 'system' ? '系统提示词' : '本次请求上下文'}>
        {messages.length ? (
          <Accordion
            type="multiple"
            defaultValue={['message-0']}
            className="trajectory-content-accordion"
          >
            {sections.map((section, index) => (
              <AccordionItem key={index} value={`message-${index}`}>
                <AccordionTrigger>
                  {kind === 'system' ? '系统提示词' : `用户上下文 · ${index + 1}`}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3">
                    {section.map((message, messageIndex) => (
                      <div key={messageIndex}>
                        {typeof message.content === 'string' ? (
                          /\S/u.test(message.content) ? (
                            <MessageContent text={message.content} streaming={false} />
                          ) : kind === 'system' ? (
                            <p>此消息正文为空。</p>
                          ) : null
                        ) : (
                          <p role="status">此消息的已保存正文格式无法识别。</p>
                        )}
                        <TrajectoryMessageImages images={message.images} />
                        {kind === 'input' &&
                          Array.isArray(message.toolCalls) &&
                          message.toolCalls.length > 0 && (
                            <p>此消息包含 {message.toolCalls.length} 个已保存工具请求。</p>
                          )}
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : (
          <p>{kind === 'system' ? '本次请求没有系统提示词。' : '本次请求没有用户上下文消息。'}</p>
        )}
      </section>
    );
  }
  const output = record(data);
  const text = kind === 'thinking' ? output?.reasoning : output?.content;
  const generating = event && ['planned', 'dispatching', 'running'].includes(event.phase);
  const prefix =
    output?.complete === false ||
    reference?.availability === 'partial' ||
    reference?.availability === 'truncated';
  return (
    <section aria-label={kind === 'thinking' ? 'Agent 思考' : 'Agent 本次输出'}>
      {kind === 'reply' && prefix && (
        <p className="trajectory-material-notice">
          {generating
            ? '正在生成 · 已保存前缀'
            : '此版本只包含已保存前缀，不能据此判断完整输出为空。'}
        </p>
      )}
      {typeof text === 'string' && text ? (
        /\S/u.test(text) ? (
          kind === 'thinking' ? (
            <ThoughtPreview text={text} />
          ) : (
            <Accordion
              type="multiple"
              defaultValue={['reply']}
              className="trajectory-content-accordion"
            >
              <AccordionItem value="reply">
                <AccordionTrigger>
                  {Array.isArray(output?.toolCalls) && output.toolCalls.length > 0
                    ? 'Agent 说明'
                    : 'Agent 回复'}
                </AccordionTrigger>
                <AccordionContent>
                  <MessageContent text={text} streaming={false} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )
        ) : (
          <p>正文仅包含空白字符（已保存）。</p>
        )
      ) : (
        <p>
          {kind === 'thinking'
            ? '未保存可展示的思考。'
            : prefix
              ? generating
                ? '当前前缀尚无正文。'
                : '已保存前缀尚无正文。'
              : Array.isArray(output?.toolCalls) && output.toolCalls.length > 0
                ? `本次仅发起 ${output.toolCalls.length} 个工具调用，没有独立正文。`
                : event?.phase === 'completed' && output?.complete === true
                  ? '已完成，无正文。'
                  : '此版本未保存正文，完整性未核实。'}
        </p>
      )}
    </section>
  );
}
function VirtualPartContent({
  row,
  targets,
  materials,
  onRetry,
  phase,
  tab,
}: {
  row: WorkbenchRow;
  targets: readonly TrajectoryMaterialTarget[];
  materials: readonly TrajectoryEvidenceView[];
  onRetry?: () => void;
  phase?: string;
  tab: TrajectoryDetailTab;
}) {
  const part = row.virtualPart!;
  return (
    <>
      {['failed', 'cancelled', 'outcome_unknown'].includes(phase ?? '') && (
        <p role="status">
          本次模型请求{trajectoryPhaseLabels[phase!]}；仅展示该版本实际保存的内容。
        </p>
      )}
      {targets.length === 0 && (
        <p role="status">
          {part.source === 'model_input'
            ? '此范围未封存可读取的请求材料。'
            : '此范围未封存可读取的公开输出。'}
        </p>
      )}
      {onRetry && materials.some((material) => material.status === 'unavailable') && (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          重试读取材料
        </Button>
      )}
      {targets.map(({ event, reference }) => (
        <section
          className="trajectory-material"
          aria-label="轨迹证据"
          key={`${event.eventId}:${reference.evidenceId}:${reference.contentVersion}`}
          title={`材料版本：${reference.contentVersion}`}
        >
          <PublicMaterial
            reference={reference}
            partKind={part.kind}
            partTab={tab}
            materialEvent={event}
            view={materials.find(
              (material) =>
                material.eventId === event.eventId &&
                material.evidenceId === reference.evidenceId &&
                material.contentVersion === reference.contentVersion,
            )}
          />
        </section>
      ))}
    </>
  );
}
function PublicMaterial({
  view,
  reference,
  compression = false,
  partKind,
  partTab,
  materialEvent,
  approvalCheck = false,
  delegation = false,
}: {
  view?: TrajectoryEvidenceView;
  reference: TrajectoryEvidenceRef;
  compression?: boolean;
  partKind?: NonNullable<WorkbenchRow['virtualPart']>['kind'];
  partTab?: TrajectoryDetailTab;
  materialEvent?: TrajectoryEvent;
  approvalCheck?: boolean;
  delegation?: boolean;
}) {
  if (!view) return <p role="status">正在读取原版本材料…</p>;
  if (view.status === 'loading') return <p role="status">正在读取原版本材料…</p>;
  if (['missing', 'unavailable', 'redacted', 'empty'].includes(view.status))
    return (
      <p role="status">
        {view.notice ??
          {
            missing: '未保存此材料。',
            unavailable: '此材料当前不可读取。',
            redacted: '此材料已遮蔽。',
            empty: '已保存的内容为空。',
          }[view.status as 'missing']}
      </p>
    );
  const data = record(view.data),
    content = typeof data?.content === 'string' ? data.content : view.text;
  const streams =
    data && ['stdout', 'stderr', 'progress'].filter((key) => typeof data[key] === 'string');
  return (
    <>
      {view.notice && (
        <p className="trajectory-material-notice" role="status">
          {view.notice}
        </p>
      )}
      {['partial', 'truncated'].includes(view.status) && (
        <p role="status">
          {view.status === 'partial'
            ? reference.kind === 'context'
              ? '仅展示已保存的公开上下文信息，不包含完整模型输入。'
              : reference.kind === 'interaction'
                ? '仅展示已保存的公开请求和答复信息。'
                : reference.kind === 'verification'
                  ? '仅展示已保存的公开检查摘要。'
                  : '已保存前缀；此版本尚未完整结束。'
            : '此材料包含截断，只能查看已保留内容。'}
        </p>
      )}
      {view.imageUrl ? (
        <img className="trajectory-artifact-image" src={view.imageUrl} alt="原记录图片" />
      ) : reference.kind === 'tool_input' ? (
        <>
          {delegation && <TrajectoryDelegation data={view.data} />}
          <TrajectoryJson
            title="执行请求 JSON"
            text={view.data !== undefined ? json(view.data) : (view.text ?? '')}
          />
        </>
      ) : partKind ? (
        <VirtualPartPreview
          kind={partKind}
          data={view.data}
          tab={partTab ?? 'preview'}
          event={materialEvent}
          reference={reference}
          complete={view.status === 'available' && reference.availability === 'available'}
        />
      ) : reference.kind === 'model_input' ? (
        <ModelRequestPreview data={view.data} fallback={view.text} approvalCheck={approvalCheck} />
      ) : reference.kind === 'model_output' && !compression ? (
        <ModelOutputPreview data={view.data} fallback={view.text} approvalCheck={approvalCheck} />
      ) : reference.kind === 'interaction' && data ? (
        <TrajectoryInteraction
          data={data}
          cancelled={
            materialEvent?.kind === 'interaction' &&
            (materialEvent.phase === 'cancelled' ||
              materialEvent.attributes.decision === 'cancelled')
          }
        />
      ) : reference.kind === 'context' && compression ? (
        <TrajectoryContextSelection data={view.data} />
      ) : reference.kind === 'file_change' ? (
        <TrajectoryFileChange data={view.data} />
      ) : reference.kind === 'tool_result' ? (
        <TrajectoryResult data={view.data} fallback={content} />
      ) : reference.kind === 'job_output' ? (
        <TrajectoryJobOutput data={view.data} fallback={view.text} />
      ) : streams?.length ? (
        streams.map((key) => (
          <section key={key} className="trajectory-output-stream">
            <h4>{key}</h4>
            <pre>{String(data?.[key])}</pre>
          </section>
        ))
      ) : reference.kind === 'message' && content !== undefined ? (
        /\S/u.test(content) ? (
          <Accordion
            type="multiple"
            defaultValue={['message']}
            className="trajectory-content-accordion"
          >
            <AccordionItem value="message">
              <AccordionTrigger>消息正文</AccordionTrigger>
              <AccordionContent>
                <MessageContent text={content} streaming={false} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : content.length > 0 ? (
          <p>正文仅包含空白字符（已保存）。</p>
        ) : ['attachments', 'images', 'files'].some(
            (key) => Array.isArray(data?.[key]) && (data[key] as unknown[]).length > 0,
          ) ? null : (
          <p>已保存的消息正文为空。</p>
        )
      ) : content !== undefined ? (
        <MessageContent text={content} streaming={false} />
      ) : (
        <pre className="trajectory-json">{json(view.data) ?? ''}</pre>
      )}
      {data?.status === 'incomplete' &&
        view.status !== 'partial' &&
        !view.notice?.includes('尚未完整结束') && <p role="status">此版本消息尚未完整结束。</p>}
      {data?.complete === false &&
        view.status !== 'partial' &&
        !view.notice?.includes('尚未完整结束') && (
          <p role="status">
            {compression ? '部分摘要，尚未完整结束。' : '此版本输出尚未完整结束。'}
          </p>
        )}
      {reference.kind === 'message' && <TrajectoryAttachments data={data} />}
      {reference.kind !== 'job_output' && Array.isArray(data?.gaps) && data.gaps.length > 0 && (
        <section>
          <h4>输出缺口</h4>
          <pre>{json(data.gaps)}</pre>
        </section>
      )}
      {data?.truncated === true && <p role="status">原输出已截断，未保留部分不可补读。</p>}
      {!compression &&
        !partKind &&
        reference.kind !== 'model_output' &&
        reference.kind !== 'message' &&
        view.details?.map((detail) => (
          <details key={detail.label}>
            <summary>{detail.label}</summary>
            <pre>{detail.text}</pre>
          </details>
        ))}
    </>
  );
}
function ModelRetries({
  row,
  current,
  observationId,
  onObservationChange,
  collapsible = false,
}: {
  row: WorkbenchRow;
  current?: TrajectoryEvent;
  observationId?: string | null;
  onObservationChange?: (id: string | null) => void;
  collapsible?: boolean;
}) {
  const operation = row.operation;
  const retryReasons: Record<string, string> = {
    provider_unavailable: '模型服务暂不可用',
    connection_failed: '连接失败',
    stream_incomplete: '回复传输中断',
  };
  const content = operation?.type === 'model' &&
    (operation.attempts.length > 1 ||
      operation.attemptsComplete === false ||
      (operation.reconnectCount ?? 0) > 0) && (
      <section aria-label="模型重连记录">
        {operation.attemptsComplete === false && (
          <p role="status">重连关联不完整；仅展示当前范围内可核实的尝试。</p>
        )}
        <ol>
          {operation.attempts.map((attempt, index) => {
            const last = attempt.events.at(-1);
            const retry = attempt.events.find(
              (event) => event.kind === 'model' && event.attributes.retryReason,
            );
            const reason = retry?.kind === 'model' ? retry.attributes.retryReason : undefined;
            const numbered = attempt.events.find(
              (event) => event.kind === 'model' && event.attributes.retryAttempt !== undefined,
            );
            const number =
              numbered?.kind === 'model'
                ? numbered.attributes.retryAttempt
                : operation.attemptsComplete !== false
                  ? index + 1
                  : undefined;
            return (
              <li key={attempt.nodeId}>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-pressed={last?.eventId === current?.eventId}
                  disabled={!last || !onObservationChange}
                  onClick={() => last && onObservationChange?.(last.eventId)}
                >
                  {number === 1
                    ? '首次请求'
                    : number !== undefined
                      ? `第 ${number - 1} 次重连`
                      : `已保存请求 ${index + 1}`}{' '}
                  · {trajectoryPhaseLabels[last?.phase ?? attempt.phase ?? ''] ?? '状态未记录'}
                </Button>
                {reason && <p>重连原因：{retryReasons[reason] ?? '原因未分类'}</p>}
                {attempt.interval.durationMs !== undefined && (
                  <p>
                    {attempt.interval.ongoing ? '已观测区间 ' : '记录区间 '}
                    {readableDuration(attempt.interval.durationMs)}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
        <p className="trajectory-material-notice">
          选择一次请求后，本阶段内容与原始材料会切换到该次准确版本。
        </p>
      </section>
    );
  if (!content) return null;
  const body = (
    <>
      {content}
      {observationId && (
        <Button size="xs" variant="ghost" onClick={() => onObservationChange?.(null)}>
          返回最新一次请求
        </Button>
      )}
    </>
  );
  return collapsible ? (
    <details className="trajectory-request-retries">
      <summary>
        重连 {operation?.reconnectCount ?? Math.max(0, (operation?.attempts.length ?? 1) - 1)} 次 ·{' '}
        {operation?.attempts.length ?? 0} 次已保存请求
      </summary>
      {body}
    </details>
  ) : (
    body
  );
}
export function TrajectoryDetails({
  node,
  active,
  row,
  tab,
  onTabChange,
  materials,
  targets,
  excluded,
  collapsed,
  scrollTop,
  onScroll,
  onClose,
  onRetry,
  observationId,
  relatedRows,
  rowsById,
  onRelated,
  onObservationChange,
  runLabel,
}: {
  node: TrajectoryTreeNode;
  active: boolean;
  row: WorkbenchRow;
  events: readonly TrajectoryEvent[];
  tab: TrajectoryDetailTab;
  onTabChange: (tab: TrajectoryDetailTab) => void;
  materials: readonly TrajectoryEvidenceView[];
  targets: readonly TrajectoryMaterialTarget[];
  excluded: boolean;
  collapsed: boolean;
  scrollTop: number;
  onScroll: (top: number) => void;
  onClose: () => void;
  onRetry?: () => void;
  onParent: () => void;
  observationId?: string | null;
  relatedRows: readonly WorkbenchRow[];
  rowsById: ReadonlyMap<string, WorkbenchRow>;
  onRelated: (id: string) => void;
  onObservationChange?: (id: string | null) => void;
  runLabel?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    restored = useRef('');
  const scrollKey = `${row.id}:${tab}:${observationId ?? 'latest'}`;
  const ready = targets.every((target) =>
    materials.some(
      (material) =>
        material.eventId === target.event.eventId &&
        material.evidenceId === target.reference.evidenceId &&
        material.contentVersion === target.reference.contentVersion &&
        material.status !== 'loading',
    ),
  );
  useLayoutEffect(() => {
    if (!active) {
      restored.current = '';
      return;
    }
    if (ready && viewport.current && restored.current !== scrollKey) {
      viewport.current.scrollTop = scrollTop;
      restored.current = scrollKey;
    }
  }, [scrollKey, scrollTop, active, ready]);
  const tabs = trajectoryDetailTabs(row);
  const current = trajectorySelectedObservation(row, observationId),
    member = trajectorySelectedMember(row, observationId),
    step = observationId && !current ? undefined : (member?.step ?? row.step ?? node.step),
    operation = row.operation,
    primary = operation?.members.find((item) => item.nodeId === operation.primaryNodeId),
    launch =
      operation?.members.find((item) => item.kind === 'tool' && item.nodeId === row.nodeId) ??
      operation?.members.find((item) => item.kind === 'tool');
  const display: TrajectoryDisplay | undefined = observationId
    ? current && 'display' in current.attributes
      ? current.attributes.display
      : undefined
    : ['shell', 'child'].includes(operation?.type ?? '')
      ? (launch?.step?.display ?? step?.display)
      : step?.display;
  const compression = trajectoryCompressionMetadata(row, observationId, rowsById);
  const isCompression = row.category === 'compression';
  const approvalCheck = row.kind === 'model' && row.category === 'approval';
  const modelOverview =
    row.kind === 'model' && !isCompression && !approvalCheck && !row.virtualPart;
  const selectedMaterials = trajectoryMaterialTargets(
    row,
    row.virtualPart ? tabs[0]! : 'preview',
    observationId,
    rowsById,
  ).map((target) => ({
    ...target,
    view: materials.find(
      (material) =>
        material.eventId === target.event.eventId &&
        material.evidenceId === target.reference.evidenceId &&
        material.contentVersion === target.reference.contentVersion,
    ),
  }));
  const savedInput = selectedMaterials.find((target) => target.reference.kind === 'model_input');
  const savedOutput = selectedMaterials.find((target) => target.reference.kind === 'model_output');
  const readableData = (view?: TrajectoryEvidenceView) =>
    view && ['available', 'partial', 'truncated'].includes(view.status) ? view.data : undefined;
  const inputData = readableData(savedInput?.view);
  const output = record(readableData(savedOutput?.view));
  const groups = trajectoryModelRequestGroups(inputData);
  const requestContext =
    display?.requestContext ??
    (groups
      ? {
          systemMessages: groups.system.length,
          historyMessages: groups.messages.length,
          tools: groups.tools.length,
        }
      : undefined);
  const actualModelName = display?.modelName ?? savedModelName(inputData);
  const modelNameLabel =
    actualModelName ??
    (!savedInput || savedInput.view?.status === 'empty'
      ? '模型名称未保存'
      : !savedInput.view || savedInput.view.status === 'loading'
        ? ['missing', 'redacted', 'unavailable'].includes(savedInput.reference.availability)
          ? '模型名称暂不可读'
          : '正在读取模型名称…'
        : ['available', 'partial', 'truncated'].includes(savedInput.view.status)
          ? '模型名称未保存'
          : '模型名称暂不可读');
  const compressionStatus = compression?.adopted
    ? '压缩已采用'
    : current?.phase === 'failed' || current?.phase === 'cancelled'
      ? '压缩未采用'
      : current?.phase === 'completed'
        ? '候选摘要，未确认采用'
        : ['planned', 'dispatching', 'running'].includes(current?.phase ?? '')
          ? '摘要生成中'
          : '结果未知，未确认采用';
  const usage = current?.kind === 'model' ? current.attributes.usage : undefined;
  const messageStatus = current?.kind === 'message' ? current.attributes.status : undefined;
  const badge = trajectoryTypeBadge(row);
  const thinkingContent = row.virtualPart?.kind === 'thinking' && tab === 'thinking';
  const observationLabels: Record<string, string> = {
    read: '读取输出',
    wait: '等待结果',
    stop: '请求停止',
    events: '观察任务',
    list: '查询任务',
    message: '发送消息',
    interrupt: '请求停止',
    follow_up: '继续任务',
  };
  const visibleOperationEvents = observationId
    ? current
      ? row.events.filter(
          (event) => parseDecimal64(event.sequence) <= parseDecimal64(current.sequence),
        )
      : []
    : row.events;
  const eventAtSelection = (events: readonly TrajectoryEvent[] | undefined) =>
    [...(events ?? [])]
      .reverse()
      .find(
        (event) =>
          !observationId ||
          (current && parseDecimal64(event.sequence) <= parseDecimal64(current.sequence)),
      );
  const primaryEvent = eventAtSelection(primary?.events);
  const eventDisplay = (event: TrajectoryEvent | undefined) =>
    event && (event.kind === 'model' || event.kind === 'tool' || event.kind === 'job')
      ? event.attributes.display
      : undefined;
  const primaryDisplay = eventDisplay(primaryEvent);
  const launchEvent = eventAtSelection(launch?.events);
  const launchDisplay = eventDisplay(launchEvent);
  const selectedTargetStatus = eventDisplay(current)?.observedStatus;
  const operationState = observationId ? (selectedTargetStatus ?? primaryEvent?.phase) : row.phase;
  return (
    <section
      className="trajectory-detail"
      aria-label="选中节点详情"
      data-thinking-content={thinkingContent || undefined}
    >
      <header className="trajectory-detail-heading">
        <div className="trajectory-detail-context">
          <span className="trajectory-type-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
          <span className="trajectory-detail-context-label">
            {runLabel ?? (step?.runId ? '原执行轮次' : '当前会话')} · #
            {current?.sequence ?? row.firstSequence}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="关闭节点详情"
          title="关闭节点详情"
        >
          <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
        </Button>
      </header>
      {excluded && (
        <p className="trajectory-material-notice" role="status">
          此记录不在当前筛选结果中。
        </p>
      )}
      {collapsed && (
        <p className="trajectory-material-notice" role="status">
          此记录当前被折叠，详情仍保留原选择。
        </p>
      )}
      <Tabs
        className="trajectory-detail-tabs"
        value={tab}
        onValueChange={(value) => onTabChange(value as TrajectoryDetailTab)}
        activationMode="manual"
      >
        <TabsList aria-label="节点详情">
          {tabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {tabLabels[value]}
            </TabsTrigger>
          ))}
        </TabsList>
        <ScrollArea
          className="trajectory-detail-scroll"
          nativeScrollbars
          chainScroll
          viewportRef={viewport}
          viewportProps={{
            'aria-label': '详情正文',
            tabIndex: 0,
            onScroll: (e) => onScroll(e.currentTarget.scrollTop),
          }}
        >
          {tabs.map((value) => (
            <TabsContent
              key={value}
              value={value}
              data-detail-tab={value}
              className="trajectory-detail-content"
            >
              {row.virtualPart ? (
                <>
                  {['system', 'thinking', 'reply'].includes(row.virtualPart.kind) && (
                    <ModelRetries
                      row={row}
                      current={current}
                      observationId={observationId}
                      onObservationChange={onObservationChange}
                      collapsible
                    />
                  )}
                  {observationId && !current ? (
                    <p role="status">此版本不在当前历史范围中。</p>
                  ) : thinkingContent ? (
                    <section className="trajectory-thinking-content" aria-label="思考内容">
                      <h4>思考内容</h4>
                      <VirtualPartContent
                        row={row}
                        targets={targets}
                        materials={materials}
                        onRetry={onRetry}
                        phase={current?.phase ?? row.phase}
                        tab={value}
                      />
                    </section>
                  ) : (
                    <VirtualPartContent
                      row={row}
                      targets={targets}
                      materials={materials}
                      onRetry={onRetry}
                      phase={current?.phase ?? row.phase}
                      tab={value}
                    />
                  )}
                </>
              ) : value === 'overview' ? (
                <>
                  {!modelOverview && !approvalCheck && display?.summary && (
                    <p className="trajectory-operation-summary">{display.summary}</p>
                  )}
                  {modelOverview && (
                    <TrajectoryRequestMetrics
                      row={row}
                      observationId={observationId}
                      modelName={modelNameLabel}
                    />
                  )}
                  {!modelOverview &&
                    !isCompression &&
                    !['shell', 'child'].includes(operation?.type ?? '') && (
                      <dl className="trajectory-metadata">
                        {!['shell', 'child'].includes(operation?.type ?? '') &&
                          messageStatus !== 'complete' && (
                            <>
                              <dt>{row.kind === 'interaction' ? '交互状态' : '状态'}</dt>
                              <dd>
                                {trajectoryPhaseLabels[
                                  modelOverview && row.requestPhase
                                    ? row.requestPhase
                                    : (current?.phase ?? (observationId ? '' : (row.phase ?? '')))
                                ] ?? (observationId ? '此版本不在当前历史范围中' : '结构分组')}
                              </dd>
                            </>
                          )}
                        {messageStatus === 'incomplete' && (
                          <>
                            <dt>正文完整性</dt>
                            <dd>尚未完整结束</dd>
                          </>
                        )}
                      </dl>
                    )}
                  {row.kind === 'run' && row.summary && (
                    <section aria-label="本轮过程摘要">
                      <dl className="trajectory-metadata">
                        {(
                          [
                            ['model', 'Agent 处理'],
                            ['tool', '工具操作'],
                            ['child', '子任务'],
                            ['approval', '审批'],
                            ['compression', '压缩'],
                            ['userMessages', '用户消息'],
                            ['assistantMessages', 'Agent 回复'],
                          ] as const
                        ).map(([key, label]) =>
                          row.summary![key] > 0 ? (
                            <div className="trajectory-metadata-pair" key={key}>
                              <dt>{label}</dt>
                              <dd>{row.summary![key]} 次</dd>
                            </div>
                          ) : null,
                        )}
                      </dl>
                    </section>
                  )}
                  {operation?.type === 'model' && !approvalCheck && (
                    <section aria-label="模型请求准备">
                      <h4>输入准备</h4>
                      {requestContext ? (
                        <p>
                          系统指令 {requestContext.systemMessages} 条 · 对话与结果{' '}
                          {requestContext.historyMessages} 条 · 可用工具 {requestContext.tools} 个
                        </p>
                      ) : (
                        <p>此记录没有轻量输入统计；可在预览中读取当次保存的完整请求。</p>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => onTabChange('preview')}>
                        查看系统提示词与模型输入
                      </Button>
                    </section>
                  )}
                  {approvalCheck && (
                    <Button size="xs" variant="ghost" onClick={() => onTabChange('preview')}>
                      查看检查请求与结果
                    </Button>
                  )}
                  {modelOverview && (
                    <section aria-label="决策步骤内容">
                      <h4>过程内容</h4>
                      {output ? (
                        <dl className="trajectory-metadata">
                          <dt>思考</dt>
                          <dd>
                            {typeof output.reasoning === 'string' && output.reasoning
                              ? '已保存公开思考'
                              : '未保存可展示的思考'}
                          </dd>
                          <dt>发起工具请求</dt>
                          <dd>
                            {Array.isArray(output.toolCalls)
                              ? `${output.toolCalls.length} 次；执行结果见对应工具`
                              : '未记录'}
                          </dd>
                          <dt>本次输出</dt>
                          <dd>
                            {typeof output.content === 'string' && output.content
                              ? Array.isArray(output.toolCalls) && output.toolCalls.length > 0
                                ? '已保存 Agent 说明'
                                : '已保存正文'
                              : '没有保存正文'}
                          </dd>
                        </dl>
                      ) : (
                        <p>公开输出尚未读取；只按当次已保存材料展示。</p>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => onTabChange('preview')}>
                        查看思考与本次输出
                      </Button>
                    </section>
                  )}
                  <ModelRetries
                    row={row}
                    current={current}
                    observationId={observationId}
                    onObservationChange={onObservationChange}
                  />
                  {operation?.type === 'shell' && (
                    <section aria-label="命令与观察结果">
                      <h4>命令执行</h4>
                      <dl className="trajectory-metadata">
                        <dt>命令状态</dt>
                        <dd>{trajectoryPhaseLabels[operationState ?? ''] ?? '尚未核实'}</dd>
                        {primaryDisplay?.exitCode !== undefined && (
                          <>
                            <dt>退出码</dt>
                            <dd>{primaryDisplay.exitCode}</dd>
                          </>
                        )}
                        {primaryDisplay?.cancelRequested && (
                          <>
                            <dt>停止请求</dt>
                            <dd>已请求；以命令终态确认是否停止</dd>
                          </>
                        )}
                      </dl>
                      <p className="trajectory-material-notice">
                        参数默认为原启动请求。读取和等待工具的成功不表示命令完成，等待超时不会停止命令。
                      </p>
                    </section>
                  )}
                  {operation?.type === 'child' && (
                    <section aria-label="子 Agent 工作与返回">
                      <h4>子 Agent 工作</h4>
                      <dl className="trajectory-metadata">
                        <dt>委派受理</dt>
                        <dd>
                          {launchDisplay?.accepted === true
                            ? '已受理'
                            : launchDisplay?.accepted === false
                              ? '未受理'
                              : launchEvent?.phase === 'failed'
                                ? '本次委派失败'
                                : '按原回执查看'}
                        </dd>
                        <dt>工作状态</dt>
                        <dd>{trajectoryPhaseLabels[operationState ?? ''] ?? '尚未核实'}</dd>
                        <dt>结果交付</dt>
                        <dd>
                          {(() => {
                            const delivered = [...visibleOperationEvents]
                              .reverse()
                              .find((event) => event.kind === 'job' && event.attributes.delivery);
                            return delivered?.kind === 'job'
                              ? (
                                  {
                                    pending: '等待交付',
                                    consumed: '父级已接收',
                                    suppressed: '未交付',
                                  } as const
                                )[delivered.attributes.delivery!]
                              : '未单独记录';
                          })()}
                        </dd>
                      </dl>
                      <p className="trajectory-material-notice">
                        委派已受理、工作已结束与父级收到结果分别记录；预览保留原委派与结果材料。
                      </p>
                    </section>
                  )}
                  {operation && operation.observations.length > 0 && (
                    <details>
                      <summary>相关读取与观察 · {operation.observations.length} 次</summary>
                      <ol>
                        {operation.observations.map((observed) => {
                          const last = observed.events.at(-1),
                            label = observed.step?.display?.operation;
                          return (
                            <li key={observed.nodeId}>
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-pressed={last?.eventId === current?.eventId}
                                disabled={!last || !onObservationChange}
                                onClick={() => last && onObservationChange?.(last.eventId)}
                              >
                                {(label && observationLabels[label]) || observed.label} ·{' '}
                                {trajectoryPhaseLabels[last?.phase ?? observed.phase ?? ''] ??
                                  '状态未记录'}
                              </Button>
                              {observed.step?.display?.timedOut && (
                                <p>本次等待超时；不表示目标任务结束。</p>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                      <p>选择后可在参数或结果中查看该次观察的已保存内容。</p>
                    </details>
                  )}
                  {observationId && operation && (
                    <p role="status">
                      正在查看选定原记录。
                      <Button size="xs" variant="ghost" onClick={() => onObservationChange?.(null)}>
                        返回当前工作结果
                      </Button>
                    </p>
                  )}
                  {relatedRows.length > 0 && (
                    <section>
                      <h4>关联记录</h4>
                      {relatedRows.map((related) => (
                        <Button
                          key={related.id}
                          size="xs"
                          variant="ghost"
                          onClick={() => onRelated(related.nodeId)}
                        >
                          {related.label} · #{related.firstSequence}
                        </Button>
                      ))}
                    </section>
                  )}
                  {node.relationNotice && <p role="status">{node.relationNotice}</p>}
                  {step?.compressionId && (
                    <section className="trajectory-compression">
                      <p>{compressionStatus}</p>
                      {compression?.adopted && compression.accounting ? (
                        <>
                          <p>
                            上下文容量（本地估算）{' '}
                            <strong>
                              {compression.accounting.beforeTokens} →{' '}
                              {compression.accounting.afterTokens} Token
                            </strong>
                          </p>
                          <p>
                            {compression.accounting.beforeTokens >=
                            compression.accounting.afterTokens
                              ? '减少'
                              : '增加'}{' '}
                            {Math.abs(
                              compression.accounting.beforeTokens -
                                compression.accounting.afterTokens,
                            )}{' '}
                            Token
                            {compression.accounting.beforeTokens > 0 &&
                              ` · ${(Math.abs(1 - compression.accounting.afterTokens / compression.accounting.beforeTokens) * 100).toFixed(1)}%`}
                          </p>
                        </>
                      ) : (
                        <p>
                          {compression?.adopted
                            ? '未记录同口径的压前／压后容量'
                            : '未采用，不能计算实际压后容量'}
                        </p>
                      )}
                      {(compression?.accounting ||
                        compression?.triggerTokens !== undefined ||
                        compression?.thresholdTokens !== undefined) && (
                        <details>
                          <summary>压缩信息</summary>
                          <dl className="trajectory-metadata">
                            {compression.accounting && (
                              <>
                                <dt>计数口径</dt>
                                <dd>压前与压后使用同一方法的本地上下文估算</dd>
                              </>
                            )}
                            {compression.triggerTokens !== undefined && (
                              <>
                                <dt>触发时用量</dt>
                                <dd>{compression.triggerTokens} Token</dd>
                                <dt>触发计数口径</dt>
                                <dd>
                                  {compression.triggerBasis === 'reported_baseline'
                                    ? '实测基线加估算'
                                    : '本地估算'}
                                </dd>
                              </>
                            )}
                            {compression.measuredInputTokens !== undefined && (
                              <>
                                <dt>触发实测基线</dt>
                                <dd>{compression.measuredInputTokens} Token</dd>
                              </>
                            )}
                            {compression.estimatedInputTokens !== undefined && (
                              <>
                                <dt>触发估算部分</dt>
                                <dd>{compression.estimatedInputTokens} Token</dd>
                              </>
                            )}
                            {compression.thresholdTokens !== undefined && (
                              <>
                                <dt>触发阈值</dt>
                                <dd>{compression.thresholdTokens} Token</dd>
                              </>
                            )}
                          </dl>
                        </details>
                      )}
                    </section>
                  )}
                  {usage && !modelOverview && (
                    <section aria-label="模型调用用量">
                      <h4>
                        {isCompression
                          ? '压缩请求用量'
                          : approvalCheck
                            ? '检查请求用量'
                            : '模型调用用量'}
                      </h4>
                      <p>
                        输入 {usage.inputTokens ?? '未记录'} · 输出 {usage.outputTokens ?? '未记录'}{' '}
                        · 缓存 {usage.cachedInputTokens ?? '未记录'} Token
                      </p>
                    </section>
                  )}
                  {current?.occurredAt != null && (
                    <details>
                      <summary>记录信息</summary>
                      <dl className="trajectory-metadata">
                        <dt>记录时间</dt>
                        <dd>{new Date(current.occurredAt).toLocaleString()}</dd>
                      </dl>
                    </details>
                  )}
                  {['model', 'tool', 'job'].includes(row.kind) && (
                    <TrajectoryExecutionTiming
                      row={row}
                      observationId={observationId}
                      kind={
                        modelOverview || approvalCheck || isCompression ? 'request' : 'execution'
                      }
                    />
                  )}
                </>
              ) : (
                <>
                  {value === 'preview' && isCompression && (
                    <p className="trajectory-preview-status">
                      {compression?.adopted ? '已采用的压缩摘要' : compressionStatus}
                    </p>
                  )}
                  {onRetry && materials.some((material) => material.status === 'unavailable') && (
                    <Button variant="ghost" size="xs" onClick={onRetry}>
                      重试读取材料
                    </Button>
                  )}
                  {targets.length === 0 && (
                    <p role="status">
                      {node.step?.identityConfidence === 'legacy_local'
                        ? '旧格式记录未保存可读取的材料。'
                        : value === 'parameters'
                          ? '未封存该次执行请求 JSON。'
                          : value === 'result'
                            ? '此范围未保存工具结果。'
                            : '此节点没有已保存的公开材料。'}
                    </p>
                  )}
                  {targets.map(({ event, reference }) => {
                    const deferredReceipt =
                      !observationId &&
                      reference.kind === 'tool_result' &&
                      ((operation?.type === 'shell' &&
                        value === 'result' &&
                        (targets.some((target) => target.reference.kind === 'job_output') ||
                          targets.filter((target) => target.reference.kind === 'tool_result').at(-1)
                            ?.event.eventId !== event.eventId)) ||
                        (operation?.type === 'child' &&
                          value === 'preview' &&
                          event.kind === 'tool' &&
                          targets.some(
                            (target) =>
                              target.reference.kind === 'tool_result' &&
                              target.event.kind === 'job' &&
                              ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(
                                target.event.phase,
                              ),
                          )));
                    const material = (
                      <section
                        className="trajectory-material"
                        aria-label="轨迹证据"
                        key={`${event.eventId}:${reference.evidenceId}:${reference.contentVersion}`}
                        title={`材料版本：${reference.contentVersion}`}
                      >
                        {tab !== 'content' && reference.kind !== 'tool_input' && (
                          <h4>
                            {approvalCheck && reference.kind === 'model_input'
                              ? '检查请求'
                              : approvalCheck && reference.kind === 'model_output'
                                ? '检查结果'
                                : isCompression && reference.kind === 'model_output'
                                  ? '压缩摘要'
                                  : (materialLabels[reference.kind] ?? reference.kind)}
                          </h4>
                        )}
                        <PublicMaterial
                          compression={isCompression}
                          delegation={operation?.type === 'child'}
                          approvalCheck={approvalCheck}
                          reference={reference}
                          materialEvent={event}
                          view={materials.find(
                            (material) =>
                              material.eventId === event.eventId &&
                              material.evidenceId === reference.evidenceId &&
                              material.contentVersion === reference.contentVersion,
                          )}
                        />
                      </section>
                    );
                    return deferredReceipt ? (
                      <details
                        key={`${event.eventId}:${reference.evidenceId}:${reference.contentVersion}`}
                      >
                        <summary>
                          {operation?.type === 'child' ? '原委派回执' : '原启动回执'}
                        </summary>
                        {material}
                      </details>
                    ) : (
                      material
                    );
                  })}
                </>
              )}
            </TabsContent>
          ))}
        </ScrollArea>
      </Tabs>
    </section>
  );
}
