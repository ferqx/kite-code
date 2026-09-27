import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BackgroundExecutions } from '../src/BackgroundExecutions';

test('environment information retains every child after one becomes unavailable', () => {
  const html = renderToStaticMarkup(
    <BackgroundExecutions
      currentOnly
      executions={[
        { executionId: 'child-a', kind: 'subagent', status: 'completed', cleanupConfirmed: true },
        { executionId: 'child-b', kind: 'subagent', status: 'completed', cleanupConfirmed: true },
        {
          executionId: 'child-c',
          kind: 'subagent',
          status: 'unavailable',
          cleanupConfirmed: false,
        },
      ]}
      subagentDetails={{
        sessionIdsByExecutionId: new Map([
          ['child-a', 'session-a'],
          ['child-b', 'session-b'],
          ['child-c', 'session-c'],
        ]),
        onOpen: () => undefined,
        onRefresh: () => undefined,
      }}
    />,
  );
  expect(html).toContain('child-c');
  expect(html).toContain('不可用');
  expect(html.match(/查看子 Agent 详情/g)).toHaveLength(3);
});
