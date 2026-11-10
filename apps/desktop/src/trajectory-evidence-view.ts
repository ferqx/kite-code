import {
  parseDecimal64,
  type TrajectoryEvidenceRef,
  toolResultPresentationSchema,
} from '@kite-ai/trajectory';

export interface FormattedTrajectoryEvidence {
  text: string;
  notice?: string;
  details?: { label: string; text: string }[];
}
export interface DecodedTrajectoryEvidence extends FormattedTrajectoryEvidence {
  data?: unknown;
  rawText?: string;
}

/** Exact public bytes stay inspectable; typed results never acquire arbitrary details fields. */
export function decodeTrajectoryEvidence(
  kind: TrajectoryEvidenceRef['kind'],
  mediaType: string,
  bytes: Uint8Array,
): DecodedTrajectoryEvidence {
  const formatted = formatTrajectoryEvidence(kind, mediaType, bytes);
  if (!/^text\/|(?:json|xml)(?:;|$)/i.test(mediaType)) return formatted;
  const rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/(?:json)(?:;|$)/i.test(mediaType)) return { ...formatted, rawText };
  const value: unknown = JSON.parse(rawText);
  if (kind !== 'tool_result') return { ...formatted, rawText, data: value };
  const body = object(value);
  const data: Record<string, unknown> = { outcome: body.outcome, content: body.content };
  if (body.presentation !== undefined) {
    const presentation = toolResultPresentationSchema.safeParse(body.presentation);
    if (presentation.success) data.presentation = presentation.data;
    else
      return {
        ...formatted,
        rawText,
        data,
        notice: '结构化结果格式不可识别，已保留原文本。',
      };
  }
  return { ...formatted, rawText, data };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('trajectory_evidence_format_invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('trajectory_evidence_format_invalid');
  return value;
}
const stream = (value: unknown) => {
  if (value !== 'stdout' && value !== 'stderr' && value !== 'progress')
    throw Error('trajectory_evidence_format_invalid');
  return value;
};
/** Formatting follows the typed public view only after the caller has verified descriptor/ref/hash. */
export function formatTrajectoryEvidence(
  kind: TrajectoryEvidenceRef['kind'],
  mediaType: string,
  bytes: Uint8Array,
): FormattedTrajectoryEvidence {
  if (!/^text\/|(?:json|xml)(?:;|$)/i.test(mediaType))
    return { text: `已核实 ${bytes.byteLength} 字节的 ${mediaType} 材料。` };
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/(?:json)(?:;|$)/i.test(mediaType)) return { text: decoded };
  const value: unknown = JSON.parse(decoded);
  if (kind === 'message') {
    const body = object(value);
    if (
      !['user', 'assistant'].includes(String(body.role)) ||
      !['complete', 'incomplete'].includes(String(body.status))
    )
      throw Error('trajectory_evidence_format_invalid');
    const result: FormattedTrajectoryEvidence = { text: text(body.content) };
    if (Array.isArray(body.attachments) && body.attachments.length) {
      result.details = [
        {
          label: '消息附件',
          text: body.attachments
            .map((value) => {
              const attachment = object(value);
              return text(attachment.name);
            })
            .join('\n'),
        },
      ];
    }
    if (body.status === 'incomplete') result.notice = '此版本消息尚未完整结束。';
    return result;
  }
  if (kind === 'model_output' || kind === 'tool_result') {
    const body = object(value);
    const result: FormattedTrajectoryEvidence = { text: text(body.content) };
    const details: { label: string; text: string }[] = [];
    if (kind === 'model_output') {
      if (body.toolCalls !== undefined) {
        if (!Array.isArray(body.toolCalls)) throw Error('trajectory_evidence_format_invalid');
        const calls = body.toolCalls.map((value) => {
          const call = object(value);
          return { id: text(call.id), name: text(call.name), arguments: text(call.arguments) };
        });
        if (calls.length)
          details.push({
            label: `工具调用（${calls.length}）`,
            text: calls.map((call) => `${call.name}\n${call.arguments}`).join('\n\n'),
          });
      }
      if (typeof body.reasoning === 'string' && body.reasoning.length)
        details.push({ label: '已保存思考（默认收起）', text: body.reasoning });
    } else if (
      !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(body.outcome))
    )
      throw Error('trajectory_evidence_format_invalid');
    if (details.length) result.details = details;
    return result;
  }
  if (kind === 'job_output') {
    const body = object(value);
    const upper = parseDecimal64(body.upperOutputSeq);
    if (
      body.contentMode !== 'retained_preview' ||
      !Array.isArray(body.items) ||
      !Array.isArray(body.gaps) ||
      typeof body.truncated !== 'boolean'
    )
      throw Error('trajectory_evidence_format_invalid');
    let previous = -1n;
    const lines = body.items.map((value) => {
      const item = object(value),
        position = parseDecimal64(item.seq);
      if (position <= previous || position > upper)
        throw Error('trajectory_evidence_format_invalid');
      previous = position;
      return `[${stream(item.stream)} #${String(item.seq)}]\n${text(item.content)}`;
    });
    for (const value of body.gaps) {
      const gap = object(value),
        from = parseDecimal64(gap.fromSeq),
        through = parseDecimal64(gap.throughSeq);
      const dropped = parseDecimal64(gap.droppedBytes);
      if (from > through || through > upper) throw Error('trajectory_evidence_format_invalid');
      lines.push(
        `[${stream(gap.stream)} 缺口 #${String(gap.fromSeq)}–#${String(gap.throughSeq)}，丢弃 ${dropped} 字节]`,
      );
    }
    return {
      text: lines.join('\n\n'),
      notice: body.truncated
        ? '已保存输出预览（已截断）；未保存内容无法还原。'
        : '已保存输出预览；不代表完整 stdout/stderr。',
    };
  }
  return { text: JSON.stringify(value, null, 2) };
}
