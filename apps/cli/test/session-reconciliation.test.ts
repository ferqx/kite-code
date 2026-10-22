import { expect, test } from 'bun:test';
import { rmdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AgentClient, Session, Workspace } from '@kite-ai/client';
import { temporaryDirectory } from '../../../tests/fixtures/test-filesystem';
import { ensureSession } from '../host';

const workspace = {
  id: 'workspace',
  rootUri: pathToFileURL(process.cwd()).href,
} as Workspace;
const session = { id: 'session', workspaceId: workspace.id } as Session;
const args = {
  kind: 'resume' as const,
  thread: session.id,
  task: 'continue',
  trustWorkspace: false,
  skills: [],
};

function fixture() {
  const calls: string[] = [];
  const client = {
    serverInfo: { capabilities: ['session_reconciliation'] },
    async listAllSessions() {
      calls.push('sessions');
      return [session];
    },
    async listAllWorkspaces() {
      calls.push('workspaces');
      return [workspace];
    },
    async reconcileSessionState(id: string, options: { signal?: AbortSignal }) {
      expect(id).toBe(session.id);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      calls.push('reconcile');
    },
  } as unknown as AgentClient;
  return { client, calls };
}

test('CLI continuing an admitted existing session reconciles before returning it', async () => {
  const { client, calls } = fixture();
  const result = await ensureSession(
    args,
    client,
    'store',
    process.cwd(),
    () => {},
    new AbortController().signal,
  );
  expect(result).toEqual({ session, workspace });
  expect(calls).toEqual(['sessions', 'workspaces', 'reconcile']);
});

test('workspace mismatch is rejected before reconciliation and readonly TUI admission skips it', async () => {
  const { client, calls } = fixture();
  const otherWorkspace = temporaryDirectory('kite-cli-reconciliation-workspace-');
  try {
    await expect(
      ensureSession(
        { ...args, workspace: otherWorkspace },
        client,
        'store',
        process.cwd(),
        () => {},
      ),
    ).rejects.toThrow('workspace_identity_mismatch');
    expect(calls).toEqual(['sessions', 'workspaces']);
    calls.length = 0;
    await ensureSession(args, client, 'store', process.cwd(), () => {}, undefined, {
      reconcile: false,
    });
    expect(calls).toEqual(['sessions', 'workspaces']);
  } finally {
    rmdirSync(otherWorkspace);
  }
});

test('CLI does not continue after a failed state reconciliation', async () => {
  const { client } = fixture();
  client.reconcileSessionState = async () => {
    throw new Error('owner_inspection_failed');
  };
  await expect(ensureSession(args, client, 'store', process.cwd(), () => {})).rejects.toThrow(
    'owner_inspection_failed',
  );
});
