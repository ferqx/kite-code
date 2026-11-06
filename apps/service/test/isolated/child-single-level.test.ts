import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
import type { ModelAdapter } from '@kite-ai/ai';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

for (const mode of ['accept_edits', 'auto', 'full'] as const)
  for (const explicit of [false, true])
    test(`child model cannot create collaborators in ${mode} with ${explicit ? 'explicit' : 'default'} roles`, async () => {
      const root = temporaryDirectory('kite-single-child-service-');
      const workspace = join(root, 'project');
      const profile = selectProfile({ dataRoot: join(root, 'state'), profile: 'test' });
      privateDirectory(workspace);
      privateDirectory(profile.profilePath);
      writeFileSync(join(workspace, 'source.txt'), 'Original child work still completes.\n');
      const configurationPath = join(profile.profilePath, 'config.jsonc');
      writeFileSync(
        configurationPath,
        JSON.stringify({
          modelId: 'owned',
          models: [
            {
              id: 'owned',
              provider: 'compatible',
              model: 'not-dispatched',
              baseURL: 'http://127.0.0.1:1/v1',
            },
          ],
        }),
      );
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: configurationPath,
        ordinaryHostTools: true,
        localCodex: false,
        browser: false,
        credentialBackend: createTemporaryCredentialBackend(),
        ...(explicit
          ? {
              child: [
                {
                  id: 'explicit',
                  version: '1',
                  toolIds: [
                    'files.read',
                    'files.write',
                    'task.spawn',
                    'task.message',
                    'task.events',
                    'task.list',
                    'task.follow_up',
                    'task.interrupt',
                  ],
                },
              ],
            }
          : {}),
      });
      const store = await openSqliteStore(profile);
      const locks = createWorkspaceSerialLocks(profile);
      host.bindWorkspaceSerialLocks?.(locks);
      const expectedStoreId = (await store.getMetadata()).storeId;
      const parentDirectories: string[][] = [],
        childDirectories: string[][] = [];
      const childSelections: (readonly string[])[] = [];
      const model: ModelAdapter = {
        async *stream(request) {
          const execution = (await store.getExecution(request.requestId))!;
          const child = execution.sessionId !== 's';
          (child ? childDirectories : parentDirectories).push(request.tools.map((tool) => tool.id));
          const count = request.messages.filter((message) => message.role === 'tool').length;
          if ((!child && count) || (child && count >= 2)) {
            yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          }
          yield {
            type: 'tool_call',
            id: `${child ? 'child' : 'parent'}-${count}`,
            name: !child ? 'spawn_agent' : count ? 'write_file' : 'read_file',
            arguments: JSON.stringify(
              !child
                ? { prompt: 'Copy source.txt to the new result.txt without delegating.' }
                : count
                  ? {
                      path: 'result.txt',
                      content: 'Original child work still completes.\n',
                      base: null,
                    }
                  : { path: 'source.txt' },
            ),
          };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const runtime = createRuntime({
        ...host,
        store,
        permissions: host.permissions!,
        artifacts: createArtifactStore({ profile, store }),
        workspaceSerialLocks: locks,
        modelConcurrency: 2,
        async resolveRunConfiguration(input) {
          return { ...(await host.resolveRunConfiguration!(input)), model };
        },
        async resolveChildRunConfiguration(input) {
          const binding = await host.resolveChildRunConfiguration!(input);
          childSelections.push([...(binding.toolIds ?? [])]);
          return { ...binding, model };
        },
      });
      host.permissionManagement!(runtime);
      try {
        await runtime.createWorkspace({
          expectedStoreId,
          id: 'w',
          name: 'owned',
          rootUri: pathToFileURL(workspace).href,
        });
        await runtime.createSession({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'create',
          sessionId: 's',
          workspaceId: 'w',
          title: 'Single child level',
        });
        await initializeLivePermissionFixture({
          runtime,
          profile,
          expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
          workspaceId: 'w',
          mode,
          trusted: true,
        });
        await runtime.submitCommand({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'work',
          sessionId: 's',
          request: { kind: 'run.start', content: 'Delegate the file copy once.' },
        });
        const answered = new Set<string>();
        const deadline = Date.now() + 10000;
        let carrier: ExecutionRecord | undefined;
        for (;;) {
          const cards = await runtime.listInteractions({
            expectedStoreId,
            sessionId: 's',
            state: 'pending',
          });
          for (const card of cards.interactions) {
            if (answered.has(card.id)) continue;
            expect(card.kind).toBe('approval');
            expect(['task.spawn', 'agent/explicit', 'files.write']).toContain(card.definitionId);
            await runtime.answerInteraction({
              expectedStoreId,
              subjectId: 'owner',
              commandId: `approve-${card.id}`,
              presentationSessionId: 's',
              interactionId: card.id,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            answered.add(card.id);
          }
          carrier = (await store.listExecutions('s')).find((row) => row.childSessionId);
          if (
            carrier &&
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(carrier.status)
          )
            break;
          if (Date.now() >= deadline) throw Error('missing_single_level_child_completion');
          await Bun.sleep(5);
        }
        await runtime.waitForCommand('work', { timeoutMs: 5000 });
        expect(carrier).toBeDefined();
        expect(carrier.status).toBe('succeeded');
        await runtime.waitForCommand(`child-start-${carrier.id}`, { timeoutMs: 10000 });
        expect(parentDirectories[0]).toContain('spawn_agent');
        expect(childSelections).toHaveLength(1);
        // Preserve the internal frozen binding; the model catalogue and creation boundary narrow.
        expect(childSelections[0]).toContain('task.spawn');
        expect(childDirectories).toHaveLength(3);
        for (const tools of childDirectories) {
          expect(tools).not.toContain('spawn_agent');
          expect(tools).toContain('send_agent_message');
          expect(tools).not.toContain('wait_agent_events');
          expect(tools).toContain('list_agents');
          expect(tools).toContain('follow_up_agent');
          expect(tools).toContain('interrupt_agent');
        }
        const childRows = await store.listExecutions(carrier.childSessionId!);
        expect(childRows.filter((row) => row.childSessionId)).toEqual([]);
        expect(
          childRows.filter(
            (row) => row.definitionId === 'files.read' && row.status === 'succeeded',
          ),
        ).toHaveLength(1);
        expect(
          childRows.filter(
            (row) => row.definitionId === 'files.write' && row.status === 'succeeded',
          ),
        ).toHaveLength(1);
        expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe(
          'Original child work still completes.\n',
        );
        expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe(
          'Original child work still completes.\n',
        );
      } finally {
        await runtime.close();
        await locks.close();
        await store.close();
        removeTemporaryDirectory(root);
      }
    }, 15000);
