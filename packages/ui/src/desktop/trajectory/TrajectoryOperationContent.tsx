import { parseDecimal64 } from '@kite-ai/trajectory';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion';
import { MessageContent } from '../MessageContent';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const sequence = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    parseDecimal64(value);
    return value;
  } catch {
    return undefined;
  }
};

/** A readable view of the original delegated prompt, never a reconstructed child task. */
export function TrajectoryDelegation({ data }: { data: unknown }) {
  const input = record(data);
  if (typeof input?.prompt !== 'string') return null;
  return (
    <Accordion type="multiple" defaultValue={['task']} className="trajectory-content-accordion">
      <AccordionItem value="task">
        <AccordionTrigger>委派任务</AccordionTrigger>
        <AccordionContent>
          <dl className="trajectory-metadata">
            {typeof input.taskName === 'string' && (
              <>
                <dt>任务名称</dt>
                <dd>{input.taskName}</dd>
              </>
            )}
            {typeof input.preset === 'string' && (
              <>
                <dt>预设角色</dt>
                <dd>{input.preset}</dd>
              </>
            )}
          </dl>
          {input.prompt.length ? (
            <MessageContent text={input.prompt} streaming={false} />
          ) : (
            <p>已保存的委派正文为空。</p>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/** Sequence numbers belong to the saved message selection, not trajectory event cursors. */
export function TrajectoryContextSelection({ data }: { data: unknown }) {
  const body = record(data),
    selection = record(body?.selection),
    compression = record(body?.compression);
  const covered = sequence(compression?.coveredThroughSeq),
    published = sequence(compression?.publishedSeq);
  const boundary = sequence(selection?.boundarySeq),
    tail = sequence(selection?.tailFromSeq);
  const ranges = Array.isArray(selection?.ranges) ? selection.ranges : [];
  const savedRanges = ranges.flatMap((value) => {
    const range = record(value),
      after = sequence(range?.afterSeq),
      through = sequence(range?.throughSeq);
    return after !== undefined && through !== undefined && BigInt(after) <= BigInt(through)
      ? [{ after, through }]
      : [];
  });
  return (
    <Accordion
      type="multiple"
      defaultValue={['selection']}
      className="trajectory-content-accordion"
    >
      <AccordionItem value="selection">
        <AccordionTrigger>
          {covered !== undefined || published !== undefined
            ? '压缩覆盖与摘要发布'
            : '压缩后保留的消息范围'}
        </AccordionTrigger>
        <AccordionContent>
          {covered !== undefined || published !== undefined ? (
            <dl className="trajectory-metadata">
              {covered !== undefined && (
                <>
                  <dt>压缩覆盖上界</dt>
                  <dd>消息／上下文序号 {covered}</dd>
                </>
              )}
              {published !== undefined && (
                <>
                  <dt>摘要发布</dt>
                  <dd>{published === '0' ? '尚未发布' : `消息／上下文序号 ${published}`}</dd>
                </>
              )}
            </dl>
          ) : null}
          {boundary !== undefined || tail !== undefined || savedRanges.length ? (
            <>
              <dl className="trajectory-metadata">
                {boundary !== undefined && (
                  <>
                    <dt>压缩边界消息</dt>
                    <dd>消息序号 {boundary}</dd>
                  </>
                )}
                {tail !== undefined && (
                  <>
                    <dt>保留尾部消息</dt>
                    <dd>从消息序号 {tail} 开始</dd>
                  </>
                )}
              </dl>
              {savedRanges.length > 0 && (
                <ul>
                  {savedRanges.map((range, index) => (
                    <li key={index}>
                      消息序号大于 {range.after}，至 {range.through}（含）
                    </li>
                  ))}
                </ul>
              )}
              {savedRanges.length !== ranges.length && (
                <p role="status">部分已保存消息范围格式无法识别。</p>
              )}
            </>
          ) : covered === undefined && published === undefined ? (
            <p>此版本未保存可识别的消息范围；压缩摘要见该次已保存内容。</p>
          ) : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
