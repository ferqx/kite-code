import { expect, test } from '#kite-test';
import {
  decodeTrajectoryEvidence,
  formatTrajectoryEvidence,
} from '../src/trajectory-evidence-view';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test('original tool JSON preserves scalar, array, null and formatted raw bytes without a wrapper', () => {
  for (const value of [
    null,
    false,
    42,
    'text',
    [1, '值'],
    { path: 'a', nested: { enabled: true } },
  ]) {
    const view = decodeTrajectoryEvidence('tool_input', 'application/json', bytes(value));
    expect(view.data).toEqual(value);
    expect(view.rawText).toBe(JSON.stringify(value));
  }
});

test('typed result renders only the public presentation union, with future fields falling back to original text', () => {
  const value = {
    outcome: 'succeeded',
    content: '原结果',
    presentation: { kind: 'file', operation: 'read', path: 'a', text: '原文件' },
    details: { secret: 'private' },
  };
  const view = decodeTrajectoryEvidence('tool_result', 'application/json', bytes(value));
  expect(view.data).toEqual({
    outcome: 'succeeded',
    content: '原结果',
    presentation: value.presentation,
  });
  const future = decodeTrajectoryEvidence(
    'tool_result',
    'application/json',
    bytes({ ...value, presentation: { kind: 'future', private: true } }),
  );
  expect(future.data).toEqual({ outcome: 'succeeded', content: '原结果' });
  expect(future.text).toBe('原结果');
  expect(future.notice).toContain('格式不可识别');
});

test('message evidence displays the saved conversation text and public attachment names', () => {
  const view = formatTrajectoryEvidence(
    'message',
    'application/json',
    bytes({
      messageId: 'message',
      revision: '23',
      role: 'user',
      status: 'complete',
      content: '你好\n请查看附件',
      attachments: [{ name: 'report.pdf', mediaType: 'application/pdf' }],
    }),
  );
  expect(view).toEqual({
    text: '你好\n请查看附件',
    details: [{ label: '消息附件', text: 'report.pdf' }],
  });
  expect(view.text).not.toContain('messageId');
  const partial = formatTrajectoryEvidence(
    'message',
    'application/json',
    bytes({
      role: 'assistant',
      status: 'incomplete',
      content: '原回复前缀',
    }),
  );
  expect(partial.text).toBe('原回复前缀');
  expect(partial.notice).toBe('此版本消息尚未完整结束。');
  for (const value of [
    { role: 'tool', status: 'complete', content: 'not a reply' },
    { role: 'assistant', status: 'complete', content: { secret: 'private' } },
    { role: 'user', status: 'future', content: 'unsupported' },
  ])
    expect(() => formatTrajectoryEvidence('message', 'application/json', bytes(value))).toThrow(
      'trajectory_evidence_format_invalid',
    );
});

test('verified model body displays actual newlines; tool calls and reasoning start in separate disclosures', () => {
  const result = formatTrajectoryEvidence(
    'model_output',
    'application/json',
    bytes({
      content: 'first\nsecond 👋',
      contentVersion: 'private-wrapper-not-a-label',
      reasoning: 'saved thought',
      toolCalls: [{ id: 'call', name: 'files.read', arguments: '{"path":"file"}' }],
    }),
  );
  expect(result.text).toBe('first\nsecond 👋');
  expect(result.text).not.toContain('contentVersion');
  expect(result.text).not.toContain('saved thought');
  expect(result.details).toEqual([
    { label: '工具调用（1）', text: 'files.read\n{"path":"file"}' },
    { label: '已保存思考（默认收起）', text: 'saved thought' },
  ]);
});

test('Tool result only formats the closed public outcome/content shape', () => {
  expect(
    formatTrajectoryEvidence(
      'tool_result',
      'application/json',
      bytes({ outcome: 'failed', content: 'original\nerror' }),
    ).text,
  ).toBe('original\nerror');
  expect(() =>
    formatTrajectoryEvidence(
      'tool_result',
      'application/json',
      bytes({ outcome: 'anything', content: 'text' }),
    ),
  ).toThrow('trajectory_evidence_format_invalid');
});

test('Shell display preserves original stream/Decimal64 range and gap counters as a retained preview', () => {
  const result = formatTrajectoryEvidence(
    'job_output',
    'application/json',
    bytes({
      upperOutputSeq: '9007199254740993',
      contentMode: 'retained_preview',
      truncated: true,
      items: [{ seq: '9007199254740990', stream: 'stdout', content: 'actual\nline' }],
      gaps: [
        {
          stream: 'stderr',
          fromSeq: '9007199254740991',
          throughSeq: '9007199254740993',
          droppedBytes: '9007199254740993',
        },
      ],
    }),
  );
  expect(result.text).toBe(
    '[stdout #9007199254740990]\nactual\nline\n\n[stderr 缺口 #9007199254740991–#9007199254740993，丢弃 9007199254740993 字节]',
  );
  expect(result.notice).toContain('预览（已截断）');
  expect(() =>
    formatTrajectoryEvidence(
      'job_output',
      'application/json',
      bytes({
        upperOutputSeq: '1',
        contentMode: 'retained_preview',
        truncated: false,
        items: [{ seq: '2', stream: 'stdout', content: 'future' }],
        gaps: [],
      }),
    ),
  ).toThrow();
});

test('Artifact JSON remains inspectable while unsupported binary is not decoded as text', () => {
  expect(
    formatTrajectoryEvidence(
      'artifact',
      'application/json',
      bytes({ content: 'keep wrapper for generic Artifact' }),
    ).text,
  ).toBe('{\n  "content": "keep wrapper for generic Artifact"\n}');
  expect(formatTrajectoryEvidence('artifact', 'image/png', Uint8Array.of(0xff, 0)).text).toBe(
    '已核实 2 字节的 image/png 材料。',
  );
});
