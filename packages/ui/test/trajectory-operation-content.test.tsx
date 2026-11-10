import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TrajectoryContextSelection,
  TrajectoryDelegation,
} from '../src/desktop/trajectory/TrajectoryOperationContent';

function content(element: React.ReactNode) {
  const dom = new JSDOM(renderToStaticMarkup(element));
  return { dom, body: dom.window.document.body };
}

test('delegation presents only the saved prompt, task name and preset without borrowing a tool argument', () => {
  const input = {
    prompt: '核对 **权限拒绝**。',
    taskName: '权限检查',
    preset: 'reviewer',
    executionId: 'private-id',
  };
  const original = JSON.stringify(input);
  const { dom, body } = content(<TrajectoryDelegation data={input} />);
  expect(body.textContent).toContain('任务名称权限检查');
  expect(body.textContent).toContain('预设角色reviewer');
  expect(body.querySelector('strong')?.textContent).toBe('权限拒绝');
  expect(body.textContent).not.toContain('private-id');
  expect(body.textContent).not.toContain('来源');
  expect(JSON.stringify(input)).toBe(original);
  dom.window.close();
  expect(
    renderToStaticMarkup(
      <TrajectoryDelegation data={{ instructions: 'not a verified prompt field' }} />,
    ),
  ).toBe('');
});

test('compression selection preserves zero and distinct ranges as message sequence numbers without leaking IDs', () => {
  const data = {
    selectionId: 'private-selection',
    selection: {
      boundarySeq: '0',
      tailFromSeq: '17',
      boundaryMessageId: 'private-message',
      ranges: [
        { afterSeq: '0', throughSeq: '8' },
        { afterSeq: '12', throughSeq: '15' },
      ],
    },
  };
  const original = JSON.stringify(data);
  const { dom, body } = content(<TrajectoryContextSelection data={data} />);
  expect(body.textContent).toContain('压缩边界消息消息序号 0');
  expect(body.textContent).toContain('保留尾部消息从消息序号 17 开始');
  expect([...body.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    '消息序号大于 0，至 8（含）',
    '消息序号大于 12，至 15（含）',
  ]);
  expect(body.textContent).not.toContain('private-');
  expect(body.textContent).not.toContain('事件');
  expect(JSON.stringify(data)).toBe(original);
  dom.window.close();
});

test('missing and malformed selection data never become zero or an invented range', () => {
  const { dom, body } = content(
    <TrajectoryContextSelection
      data={{
        selection: {
          ranges: [
            { afterSeq: '9', throughSeq: '2' },
            { afterSeq: 'junk', throughSeq: '4' },
          ],
        },
      }}
    />,
  );
  expect(body.textContent).toContain('未保存可识别的消息范围');
  expect(body.querySelectorAll('li')).toHaveLength(0);
  expect(body.textContent).not.toContain('消息序号 0');
  dom.window.close();
});

test('actual compression coverage is distinct from a selected range and zero publication is pending', () => {
  const { dom, body } = content(
    <TrajectoryContextSelection
      data={{
        kind: 'compression',
        selection: {},
        compression: { coveredThroughSeq: '9007199254740993', publishedSeq: '9007199254740999' },
      }}
    />,
  );
  expect(body.textContent).toContain('压缩覆盖上界消息／上下文序号 9007199254740993');
  expect(body.textContent).toContain('摘要发布消息／上下文序号 9007199254740999');
  expect(body.textContent).not.toContain('未保存可识别');
  expect(body.textContent).not.toContain('保留尾部消息');
  dom.window.close();
  const pending = content(
    <TrajectoryContextSelection
      data={{ compression: { coveredThroughSeq: '0', publishedSeq: '0' } }}
    />,
  );
  expect(pending.body.textContent).toContain('压缩覆盖上界消息／上下文序号 0');
  expect(pending.body.textContent).toContain('摘要发布尚未发布');
  expect(pending.body.textContent).not.toContain('摘要发布消息／上下文序号 0');
  pending.dom.window.close();
});
