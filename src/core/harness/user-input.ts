import { ToolMessage } from '@langchain/core/messages';
import type { AgentResumeValue } from '@/core/types';
import type { PendingToolRequest } from './tool-requests';

/** 规范化用户输入恢复值 / Normalize user input resume value */
export function normalizeUserInputResume(resume: AgentResumeValue): {
  answer: string;
  answers?: Record<string, string>;
} {
  if (typeof resume === 'string') {
    return { answer: resume };
  }

  if (!resume || typeof resume !== 'object') {
    return { answer: '' };
  }

  // 多问题模式：answers map / Multi-question mode: answers map
  const answers = (resume as Record<string, unknown>).answers;
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    const map = answers as Record<string, string>;
    // 取第一个非空答案作为兼容 answer 字段
    const first = Object.values(map).find((v) => v.length > 0) ?? '';
    return { answer: first, answers: map };
  }

  // 用户取消（Esc / Ctrl+C）→ 标记为 Cancelled / User cancelled → mark as Cancelled
  if ((resume as Record<string, unknown>).type === 'cancel') {
    return { answer: 'Cancelled' };
  }

  for (const key of [
    'answer',
    'choice',
    'option_id',
    'optionId',
    'free_text',
    'freeText',
    'text',
  ]) {
    const value = resume[key as keyof typeof resume];
    if (typeof value === 'string') {
      return { answer: value };
    }
  }

  return { answer: '' };
}

/** 为 ask_user 恢复值创建工具消息 / Create ToolMessage for ask_user resume value */
export function userInputToolMessage(
  request: Extract<PendingToolRequest, { name: 'ask_user' }>,
  resume: AgentResumeValue,
): ToolMessage {
  const normalized = normalizeUserInputResume(resume);
  return new ToolMessage({
    content: JSON.stringify({
      ok: true,
      answer: normalized.answer,
      ...(normalized.answers ? { answers: normalized.answers } : {}),
    }),
    tool_call_id: request.id ?? 'missing-tool-call-id',
    name: 'ask_user',
    status: 'success',
  });
}
