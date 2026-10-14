import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import TaskProgressBlock from '../../src/tui/ink/TaskProgressBlock';

test('failed, blocked and compensated steps retain their actual status and hidden rows are not declared completed', () => {
  const ui = render(
    <TaskProgressBlock
      plan={{
        steps: [
          { step: 'Hidden failed step', status: 'failed' },
          { step: 'Other pending', status: 'pending' },
          { step: 'Third pending', status: 'pending' },
          { step: 'Still failed', status: 'failed' },
          { step: 'Blocked original', status: 'blocked' },
          { step: 'Compensated original', status: 'compensated' },
          { step: 'Current', status: 'in_progress' },
        ],
      }}
    />,
  );
  try {
    const frame = ui.lastFrame()!;
    expect(frame).toContain('✗');
    expect(frame).toContain('Blocked original');
    expect(frame).toContain('↶');
    expect(frame).toContain('earlier steps');
    expect(frame).not.toContain('completed');
  } finally {
    ui.unmount();
  }
});
