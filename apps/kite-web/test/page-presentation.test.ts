import { expect, test } from 'vitest';
import { pageMessages } from '@/presentation/page';

test('shared-page projection retains text, thought and terminal tool evidence without native fields', () => {
  const messages = pageMessages([
    {
      messageId: 'a',
      role: 'assistant',
      sequence: 2,
      blocks: [
        { kind: 'text', text: '## 结果' },
        { kind: 'thinking', text: '公开思考片段', complete: true },
        { kind: 'tool_rejected', toolId: 'rejected', label: '命令', summary: '本次未批准' },
        {
          kind: 'tool_result',
          toolId: 'done',
          label: '读取',
          ok: true,
          stdout: '文件内容',
          stderr: '',
        },
        { kind: 'error', code: 'unavailable', text: '读取失败' },
      ],
    },
  ]);
  expect(messages.map((message) => message.role)).toEqual([
    'assistant',
    'thinking',
    'tool',
    'tool',
    'system',
  ]);
  expect(messages[2]).toMatchObject({
    id: 'tool:rejected',
    status: 'rejected',
    text: '本次未批准',
    settled: true,
  });
  expect(messages[3]).toMatchObject({
    id: 'tool:done',
    status: 'completed',
    text: '文件内容',
    settled: true,
  });
  expect(messages[3]?.toolName).toBeUndefined();
  expect(messages[3]?.parentToolCallId).toBeUndefined();
  expect(messages[4]).toMatchObject({ title: 'unavailable', text: '读取失败' });
});
