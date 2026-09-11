import type { Message, WorkspaceSummary } from '@kite-ai/kite-client-ui';
import type { WebPresentationMessage, WebWorkspaceSummary } from './types';

export function pageWorkspaces(
  workspaces: readonly WebWorkspaceSummary[],
): readonly WorkspaceSummary[] {
  return workspaces.map((workspace) => ({
    id: workspace.workspaceId,
    label: workspace.label,
    state: workspace.sessionState,
    sessionCount: workspace.sessionCount,
    sessions: workspace.sessions.map((session) => ({
      sessionId: session.sessionId,
      displayName: session.displayName,
      status: session.status,
      updatedAt: new Date(session.updatedAt).toISOString(),
    })),
  }));
}

/** Public history stays the only source; missing native fields are never synthesized. */
export function pageMessages(messages: readonly WebPresentationMessage[]): readonly Message[] {
  return messages.flatMap((message) =>
    message.blocks.map((block, index): Message => {
      const base = { id: `${message.messageId}:${index}`, settled: true };
      switch (block.kind) {
        case 'text':
          return { ...base, role: message.role, text: block.text };
        case 'thinking':
          return { ...base, role: 'thinking', text: block.text, settled: block.complete };
        case 'tool_activity':
          return {
            ...base,
            id: `tool:${block.toolId}`,
            role: 'tool',
            title: block.label,
            text: block.summary ?? '',
            status: 'running',
            settled: false,
          };
        case 'tool_result':
          return {
            ...base,
            id: `tool:${block.toolId}`,
            role: 'tool',
            title: block.label,
            text: [block.stdout, block.stderr].filter(Boolean).join('\n'),
            status: block.ok ? 'completed' : 'failed',
            toolResult: {
              ok: block.ok,
              stdout: block.stdout,
              stderr: block.stderr,
              exitCode: block.exitCode,
            },
          };
        case 'tool_rejected':
          return {
            ...base,
            id: `tool:${block.toolId}`,
            role: 'tool',
            title: block.label,
            text: block.summary ?? '命令在执行前已拒绝',
            status: 'rejected',
          };
        case 'error':
          return { ...base, role: 'system', title: block.code, text: block.text, status: 'failed' };
        case 'status':
          return { ...base, role: 'system', text: block.text ?? block.status };
        default: {
          const unreachable: never = block;
          throw new Error(`Unsupported presentation block: ${String(unreachable)}`);
        }
      }
    }),
  );
}
