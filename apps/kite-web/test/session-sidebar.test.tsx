// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SessionSidebar } from '@/components/session/session-sidebar';

test('keeps a long Session display name inside the sidebar item', () => {
  const displayName = '修复一个非常长的会话名称并确保它不会把左侧工作区列表横向撑出可视区域';
  const view = render(
    <SessionSidebar
      workspaces={[
        {
          workspaceId: 'workspace-1',
          label: 'Workspace',
          sessionCount: 1,
          sessionState: 'loaded',
          sessions: [
            {
              sessionId: 'session-1',
              displayName,
              updatedAt: Date.now(),
              lastSequence: 1,
              status: 'idle',
            },
          ],
        },
      ]}
      selectedSessionId={null}
      onSelect={() => undefined}
      onExpandWorkspace={() => undefined}
    />,
  );

  const label = view.getByText(displayName);
  expect(label.className).toContain('line-clamp-2');
  expect(label.className).toContain('break-all');
  expect(label.getAttribute('title')).toBe(displayName);
  expect(view.getByRole('button', { name: `View ${displayName}` })).toBeTruthy();
});
