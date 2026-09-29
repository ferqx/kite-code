import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SuspendedSubagentSnapshot } from '@kite-ai/runtime-spi';
import { humanMessage } from '../src/model/messages';
import { SubagentCheckpointArtifactStore } from '../src/subagent/checkpoint-artifacts';
import {
  type SubagentContinuationArtifactOwner,
  SubagentContinuationArtifactStore,
} from '../src/subagent/continuation-artifacts';
import { subagentContinuationCursorId } from '../src/subagent/continuation-codec';
import {
  SubagentResultArtifactStore,
  SubagentTaskArtifactStore,
  SubagentTaskRequestArtifactStore,
} from '../src/subagent/task-artifacts';

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'kite-large-child-artifact-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('child task, queued request, and result roundtrip above their old 1 MiB limit', () => {
  withRoot((root) => {
    const task = 'x'.repeat(1024 * 1024 + 1);
    const taskStore = new SubagentTaskArtifactStore({ root: join(root, 'subagent-tasks') });
    const owner = {
      parentInvocationId: 'parent',
      parentAttempt: 1,
      parentToolCallId: 'call',
      childInvocationId: 'child',
    };
    const published = taskStore.write({ owner, task });
    expect(published.ref.byteLength).toBeGreaterThan(1024 * 1024);
    expect(taskStore.read(published.ref, { ...owner, taskDigest: published.taskDigest }).task).toBe(
      task,
    );

    const requestStore = new SubagentTaskRequestArtifactStore({
      root: join(root, 'subagent-tasks'),
    });
    const request = requestStore.write({
      parentModelInvocationId: 'model',
      parentToolCallId: 'call',
      name: `Review ${'x'.repeat(100)}`,
      role: 'review',
      task,
    });
    expect(request.byteLength).toBeGreaterThan(1024 * 1024);
    expect(
      requestStore.read(request, {
        parentModelInvocationId: 'model',
        parentToolCallId: 'call',
      }).task,
    ).toBe(task);

    const resultStore = new SubagentResultArtifactStore({ root: join(root, 'subagent-tasks') });
    const result = resultStore.write({
      ownerKey: 'owner',
      taskId: 'child',
      displayName: 'Review '.repeat(40),
      result: { summary: task },
    });
    expect(result.byteLength).toBeGreaterThan(1024 * 1024);
    expect(resultStore.read(result, 'child')).toEqual({ summary: task });
  });
});

test('child continuation roundtrips above its old 4 MiB limit', () => {
  withRoot((root) => {
    const content = 'x'.repeat(4 * 1024 * 1024 + 1);
    const snapshot: SuspendedSubagentSnapshot = {
      subagentId: 'child',
      role: 'review',
      name: 'Review',
      task: 'Inspect the task',
      messages: [{ type: 'human', content }],
      toolCallCount: 0,
      steps: [],
      toolRecovery: {},
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'call',
        toolName: 'read_file',
        args: {},
        command: 'read_file',
      },
    };
    const owner: SubagentContinuationArtifactOwner = {
      parentInvocationId: 'parent',
      parentAttempt: 1,
      parentToolCallId: 'parent-call',
      childInvocationId: 'child',
      continuationId: subagentContinuationCursorId(snapshot),
    };
    const store = new SubagentContinuationArtifactStore({
      root: join(root, 'subagent-continuations'),
    });
    const ref = store.write({ owner, snapshot });
    expect(ref.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(store.read(ref, owner).messages[0]?.content).toBe(content);
  });
});

test('child checkpoint roundtrips above its old 16 MiB limit', () => {
  withRoot((root) => {
    const content = 'x'.repeat(16 * 1024 * 1024 + 1);
    const store = new SubagentCheckpointArtifactStore({
      root: join(root, 'subagent-checkpoints'),
    });
    const ref = store.write({
      ownerKey: 'owner',
      taskId: 'child',
      modelInvocationOrdinal: 1,
      messages: [humanMessage(content)],
    });
    expect(ref.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(store.read(ref, 'owner', 'child').messages[0]?.content).toBe(content);
  });
});
