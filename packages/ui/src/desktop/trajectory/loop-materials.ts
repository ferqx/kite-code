import { trajectoryOutputState } from './output-presence';
import type { TrajectoryEvidenceView } from './TrajectoryPanel';
import type { WorkbenchRow } from './workbench';
import {
  trajectoryMaterialTargets,
  trajectoryModelRequestGroups,
  trajectoryRequestUserMessages,
} from './workbench-details';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Inspect only a bounded prefix and stop before a later message/body is requested. */
function excerpt(parts: Iterable<string>, limit = 160): string {
  let result = '',
    count = 0;
  for (const content of parts) {
    const prefix = content.slice(0, 4096),
      clipped = prefix.length < content.length;
    const compact = prefix.replace(/\s+/gu, ' ').trim();
    if (!compact) {
      if (clipped) return `${result.trimEnd()}…`;
      continue;
    }
    if (result) {
      if (count + 3 >= limit) return `${result.trimEnd()}…`;
      result += ' · ';
      count += 3;
    }
    for (const part of graphemes.segment(compact)) {
      // A bounded prefix may end inside a joined emoji/combining sequence: omit that last cluster.
      if (clipped && !/\s$/u.test(prefix) && part.index + part.segment.length === compact.length)
        return `${result.trimEnd()}…`;
      if (count === limit) return `${result.trimEnd()}…`;
      result += part.segment;
      count++;
    }
    if (clipped) return `${result.trimEnd()}…`;
  }
  return result.trimEnd();
}
function* systemParts(value: unknown) {
  const messages = object(value)?.messages;
  if (!Array.isArray(messages)) return;
  for (const value of messages) {
    const message = object(value);
    if (message && message.role === 'system' && typeof message.content === 'string')
      yield message.content;
  }
}

/** A list excerpt is drawn only from the exact already-authorized original material. */
export function loopMaterial(
  row: WorkbenchRow,
  materials: readonly TrajectoryEvidenceView[],
  kind: 'model_input' | 'model_output',
) {
  const targets = row.virtualPart?.targets ?? trajectoryMaterialTargets(row, 'preview');
  const target = targets.find((value) => value.reference.kind === kind);
  return target
    ? materials.find(
        (view) =>
          view.eventId === target.event.eventId &&
          view.evidenceId === target.reference.evidenceId &&
          view.contentVersion === target.reference.contentVersion,
      )
    : undefined;
}

export function loopModelName(row: WorkbenchRow, materials: readonly TrajectoryEvidenceView[]) {
  if (row.step?.display?.modelName) return row.step.display.modelName;
  const input = loopMaterial(row, materials, 'model_input');
  if (!input || !['available', 'partial', 'truncated'].includes(input.status)) return undefined;
  const adapter = object(object(object(input.data)?.metadata)?.adapter);
  const provider = object(adapter?.provider);
  return adapter?.availability === 'available' &&
    provider?.availability === 'available' &&
    typeof provider.modelId === 'string'
    ? provider.modelId
    : undefined;
}

export function loopModelLabel(row: WorkbenchRow, materials: readonly TrajectoryEvidenceView[]) {
  const name = loopModelName(row, materials);
  if (name) return name;
  const target = trajectoryMaterialTargets(row, 'preview').find(
    (value) => value.reference.kind === 'model_input',
  );
  if (!target || ['missing', 'empty'].includes(target.reference.availability))
    return '模型名称未保存';
  const view = loopMaterial(row, materials, 'model_input');
  if (!view || view.status === 'loading') return '正在读取模型名称…';
  return ['available', 'partial', 'truncated', 'empty', 'missing'].includes(view.status)
    ? '模型名称未保存'
    : '模型名称暂不可读';
}

export function loopPartSnippet(row: WorkbenchRow, materials: readonly TrajectoryEvidenceView[]) {
  const part = row.virtualPart;
  if (!part) return '';
  if (part.kind === 'reply' && row.outputHistory)
    return '保留此前请求的输出，可选择一次请求查看原内容';
  const view = loopMaterial(row, materials, part.source);
  if (!part.targets.length) return '此版本未保存对应材料';
  const outputMember =
    row.operation?.members.find((member) => member.nodeId === row.operation?.primaryNodeId) ?? row;
  const outputState = part.kind === 'reply' ? trajectoryOutputState(outputMember) : undefined;
  if (!view || view.status === 'loading') {
    if (part.kind === 'reply')
      return outputState === 'empty'
        ? '已完成，无正文'
        : ['planned', 'dispatching', 'running'].includes(outputMember.phase ?? '')
          ? '正在生成输出，已保存前缀尚未读取…'
          : '已保存输出尚未读取';
    return '正在读取当次保存内容…';
  }
  if (!['available', 'partial', 'truncated'].includes(view.status))
    return view.notice ?? '此版本内容当前不可读取';
  const data = object(view.data);
  let content = '';
  if (part.kind === 'system' || part.kind === 'input') {
    const target = part.targets.find((value) => value.reference.kind === 'model_input');
    content = excerpt(
      part.kind === 'system'
        ? systemParts(data?.request)
        : (function* () {
            for (const message of trajectoryRequestUserMessages(data, {
              event: target?.event,
              complete:
                view.status === 'available' && target?.reference.availability === 'available',
            }))
              if (typeof message.content === 'string') yield message.content;
          })(),
    );
    if (!content) return part.kind === 'system' ? '原请求未含系统提示词' : '原请求未含用户文本';
  } else if (part.kind === 'thinking') {
    content = typeof data?.reasoning === 'string' ? excerpt([data.reasoning]) : '';
    if (!content) return '未保存可展示的思考';
  } else {
    content = typeof data?.content === 'string' ? excerpt([data.content]) : '';
    if (!content && typeof data?.content === 'string' && data.content.length > 0)
      return '正文仅包含空白字符（已保存）';
    if (
      !content &&
      (view.status === 'partial' || view.status === 'truncated' || data?.complete === false)
    )
      return ['planned', 'dispatching', 'running'].includes(outputMember.phase ?? '')
        ? '正在生成输出，当前已保存前缀尚无正文'
        : '已保存前缀尚无正文，不能据此判断完整输出为空';
    if (!content && outputState === 'empty') return '已完成，无正文';
    if (!content)
      return Array.isArray(data?.toolCalls) && data.toolCalls.length
        ? `发起 ${data.toolCalls.length} 个工具调用，没有单独文本`
        : '本次输出没有文本';
  }
  return `${content}${view.status !== 'available' ? ' · 已保存前缀' : ''}`;
}

export function loopPartLabel(row: WorkbenchRow, materials: readonly TrajectoryEvidenceView[]) {
  const kind = row.virtualPart?.kind;
  if (kind === 'reply' && row.outputHistory) return '历史输出';
  if (kind === 'system') return '系统提示词';
  if (kind === 'input') return '本次请求上下文';
  if (kind === 'thinking') return '思考';
  const output = object(loopMaterial(row, materials, 'model_output')?.data);
  return Array.isArray(output?.toolCalls) && output.toolCalls.length ? 'Agent 说明' : '本次输出';
}

/** Compare only already-admitted public preparation. Large/uncertain values stay unclassified. */
function samePreparation(left: unknown, right: unknown): boolean | undefined {
  const pending: [unknown, unknown][] = [[left, right]];
  let nodes = 0,
    characters = 0;
  while (pending.length) {
    if (++nodes > 20_000) return undefined;
    const [a, b] = pending.pop()!;
    if (typeof a === 'string' && typeof b === 'string') {
      characters += a.length + b.length;
      if (characters > 512_000) return undefined;
    }
    if (a === b) continue;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    const keys = Object.keys(a),
      otherKeys = Object.keys(b);
    if (keys.length !== otherKeys.length) return false;
    if (keys.length + pending.length + nodes > 20_000) return undefined;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
    }
  }
  return true;
}

/** No history prefetch or retained body/fingerprint cache; missing exact neighbors never imply reuse. */
export function loopSystemPreparations(
  rows: readonly WorkbenchRow[],
  materials: readonly TrajectoryEvidenceView[],
): ReadonlyMap<string, 'unchanged' | 'changed'> {
  const result = new Map<string, 'unchanged' | 'changed'>();
  const systems = new Map(
    rows
      .filter((row) => row.virtualPart?.kind === 'system')
      .map((row) => [row.virtualPart!.ownerId, row]),
  );
  const previous = new Map<string, WorkbenchRow>();
  for (const owner of rows) {
    if (owner.kind !== 'model' || owner.category !== 'model' || owner.virtualPart || owner.event)
      continue;
    if (!owner.runKey) continue;
    const prior = previous.get(owner.runKey);
    previous.set(owner.runKey, owner);
    const currentSystem = systems.get(owner.id),
      previousSystem = prior && systems.get(prior.id);
    if (!currentSystem || !previousSystem) continue;
    if (
      owner.step?.identityConfidence !== 'verified_origin' ||
      prior?.step?.identityConfidence !== 'verified_origin' ||
      currentSystem.virtualPart?.targets.find((target) => target.reference.kind === 'model_input')
        ?.reference.availability !== 'available' ||
      previousSystem.virtualPart?.targets.find((target) => target.reference.kind === 'model_input')
        ?.reference.availability !== 'available'
    )
      continue;
    const currentInput = loopMaterial(currentSystem, materials, 'model_input'),
      previousInput = loopMaterial(previousSystem, materials, 'model_input');
    if (currentInput?.status !== 'available' || previousInput?.status !== 'available') continue;
    const currentGroups = trajectoryModelRequestGroups(currentInput.data),
      previousGroups = trajectoryModelRequestGroups(previousInput.data);
    if (!currentGroups || !previousGroups) continue;
    const equal = samePreparation(
      { system: previousGroups.system, tools: previousGroups.tools },
      { system: currentGroups.system, tools: currentGroups.tools },
    );
    if (equal !== undefined) result.set(currentSystem.id, equal ? 'unchanged' : 'changed');
  }
  return result;
}
