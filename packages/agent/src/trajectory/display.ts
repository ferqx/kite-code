import {
  type TrajectoryDisplay,
  trajectoryDisplaySchema,
  trajectoryMessageDisplaySchema,
} from '@kite-ai/trajectory';
import type { Json } from '../storage/types';

const object = (value: Json | undefined): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const bounded = (value: Json | undefined, limit: number): string | undefined =>
  typeof value === 'string' &&
  value.length > 0 &&
  Array.from(value).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  )
    ? value.slice(0, limit)
    : undefined;
const description = (value: Json | undefined) =>
  typeof value === 'string' ? bounded(value.replace(/\s+/gu, ' ').trim(), 320) : undefined;
function safeUrl(value: Json | undefined): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    // No query, fragment, user information, headers or request bodies enter the index.
    return bounded(url.origin + url.pathname, 320);
  } catch {
    return;
  }
}

/** The caller has already verified this public message version. Never inspect its checkpoint,
 * reasoning, attachments or an Artifact to construct a list snippet. */
export function messageTrajectoryDisplay(
  role: 'user' | 'assistant',
  body: Json,
): TrajectoryDisplay {
  const content = object(body)?.content;
  const text = typeof content === 'string' ? content.replace(/\s+/gu, ' ').trim() : '';
  let summary = '';
  for (const character of text) {
    if (summary.length + character.length > 159) break;
    summary += character;
  }
  if (summary.length < text.length) summary += '…';
  return trajectoryMessageDisplaySchema.parse({
    kind: 'message',
    title: role === 'user' ? '用户提示词' : 'Agent 回复',
    ...(summary && bounded(summary, 160) ? { summary } : {}),
  });
}

const sealedModelDisplaySchema = trajectoryDisplaySchema.pick({
  kind: true,
  operation: true,
  title: true,
  modelName: true,
  requestContext: true,
});
/** Only the closed, non-body summary captured before a Model metadata Artifact was sealed. */
export function sealedModelTrajectoryDisplay(
  value: Json | undefined,
): TrajectoryDisplay | undefined {
  const parsed = sealedModelDisplaySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.kind !== 'model' ||
    parsed.data.operation !== 'request' ||
    parsed.data.title !== '模型请求' ||
    (parsed.data.modelName !== undefined && !bounded(parsed.data.modelName, 160))
  )
    return;
  return parsed.data;
}

export function modelTrajectoryDisplay(input: Json, metadata: Json): TrajectoryDisplay {
  const request = object(input),
    snapshot = object(metadata);
  if (snapshot?.version === 1 && snapshot.body !== undefined) {
    const sealed = sealedModelTrajectoryDisplay(snapshot.display);
    if (sealed) return sealed;
  }
  const adapter = object(snapshot?.adapter),
    provider = object(adapter?.provider);
  const modelName =
    provider?.availability === 'available' ? bounded(provider.modelId, 160) : undefined;
  const surface = object(snapshot?.context)?.toolSurface;
  const messages = request?.messages,
    tools = Array.isArray(surface) ? surface : request?.tools;
  const roles = Array.isArray(messages)
    ? messages.map((message) => object(message)?.role)
    : undefined;
  return {
    kind: 'model',
    operation: 'request',
    title: '模型请求',
    ...(modelName ? { modelName } : {}),
    ...(roles?.every((role) => ['system', 'user', 'assistant', 'tool'].includes(String(role))) &&
    Array.isArray(tools)
      ? {
          requestContext: {
            systemMessages: roles.filter((role) => role === 'system').length,
            historyMessages: roles.filter((role) => role !== 'system').length,
            tools: tools.length,
          },
        }
      : {}),
  };
}

/** Called only after the frozen owner/definition/version binding has been verified. */
export function toolTrajectoryDisplay(input: {
  definitionId: string;
  definitionVersion: string;
  extensionId: string;
  input: Json;
}): TrajectoryDisplay | undefined {
  const { definitionId: id, definitionVersion: version, extensionId: extension } = input;
  const args = object(input.input) ?? {};
  let display: TrajectoryDisplay | undefined;
  if (
    extension === 'builtin.files' &&
    ((id === 'files.read' && ['4', '5'].includes(version)) ||
      (id === 'files.write' && version === '3') ||
      (id === 'files.edit' && version === '2'))
  ) {
    const operation = id.slice(6) as 'read' | 'write' | 'edit';
    display = {
      kind: 'file',
      operation,
      title: { read: '读取文件', write: '写入文件', edit: '修改文件' }[operation],
    };
    const path = bounded(args.path, 320);
    if (path) display.summary = path;
  } else if (
    extension === 'builtin.shell' &&
    version === '1' &&
    ['shell.execute', 'shell.launch', 'shell.read', 'shell.wait', 'shell.stop'].includes(id)
  ) {
    const operation = id.slice(6) as 'execute' | 'launch' | 'read' | 'wait' | 'stop';
    display = {
      kind: 'shell',
      operation,
      title: {
        execute: '执行 Shell 命令',
        launch: '后台 Shell 命令',
        read: '读取命令输出',
        wait: '等待命令完成',
        stop: '请求停止命令',
      }[operation],
    };
    if (operation === 'execute' || operation === 'launch') {
      const summary = description(args.description);
      if (summary) display.summary = summary;
    }
  } else if (
    extension === 'builtin.task' &&
    version === '1' &&
    [
      'task.spawn',
      'task.follow_up',
      'task.message',
      'task.events',
      'task.list',
      'task.interrupt',
    ].includes(id)
  ) {
    const operation = id.slice(5) as
      | 'spawn'
      | 'follow_up'
      | 'message'
      | 'events'
      | 'list'
      | 'interrupt';
    display = {
      kind: 'task',
      operation,
      title: {
        spawn: '委派子 Agent',
        follow_up: '继续子 Agent 工作',
        message: '发送 Agent 消息',
        events: '等待 Agent 事件',
        list: '查看 Agent 状态',
        interrupt: '请求停止子 Agent',
      }[operation],
    };
    if (operation === 'spawn') {
      const name = bounded(args.taskName, 120);
      if (name) display.summary = name;
    }
  } else if (extension === 'builtin.web' && version === '1' && id === 'web_fetch') {
    display = { kind: 'web', operation: 'fetch', title: '读取网页' };
    const url = safeUrl(args.url);
    if (url) display.summary = url;
  } else if (extension === 'builtin.browser' && version === '1') {
    const operation = id.startsWith('browser.') ? id.slice(8) : '';
    const parsed = trajectoryDisplaySchema.shape.operation.safeParse(operation);
    if (
      parsed.success &&
      [
        'execute',
        'open',
        'snapshot',
        'click',
        'fill',
        'scroll',
        'press',
        'hover',
        'select',
        'wait',
        'back',
        'forward',
        'reload',
        'close',
        'capture',
        'image',
        'view',
        'request_human',
      ].includes(operation)
    ) {
      display = { kind: 'browser', operation: parsed.data, title: '浏览器操作' };
      const url = safeUrl(args.url);
      if (url) display.summary = url;
    }
  } else if (extension === 'builtin.shell' && version === '1' && id === 'git.worktree') {
    const operation = args.action;
    if (operation === 'list' || operation === 'create' || operation === 'remove') {
      display = { kind: 'worktree', operation, title: 'Git 工作树' };
      const path = bounded(args.path, 320);
      if (path) display.summary = path;
    }
  } else if (
    extension === 'builtin.planning' &&
    version === '1' &&
    ['planning.read', 'planning.write', 'planning.update', 'planning.review'].includes(id)
  ) {
    display = {
      kind: 'plan',
      operation: id.slice(9) as 'read' | 'write' | 'update' | 'review',
      title: '计划操作',
    };
  } else if (
    extension === 'builtin.skills' &&
    version === '1' &&
    ['skills.load', 'skills.resource'].includes(id)
  ) {
    display = { kind: 'skill', operation: id.slice(7) as 'load' | 'resource', title: '读取技能' };
  }
  return display ? trajectoryDisplaySchema.parse(display) : undefined;
}
