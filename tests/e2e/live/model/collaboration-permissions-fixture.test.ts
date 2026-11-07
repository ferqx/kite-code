import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { taskQualityPresentedRead } from './agent-task-quality-fixture';
import {
  isLivePermissionShellApproval,
  type LivePermissionOptions,
  livePermissionShellCommand,
  runLiveCollaborationPermissions,
} from './collaboration-permissions.live';
import { runLiveTreePermissions } from './collaboration-tree-permissions.live';

const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const jsonMatch = (text: string, prefix: string) => {
  const matched = new RegExp(`${prefix}(${quoted})`).exec(text);
  if (!matched) throw Error(`controlled_model_prompt_missing:${prefix}`);
  return JSON.parse(matched[1]!) as string;
};
function controlledModel(requests: ModelRequest[]): ModelAdapter {
  const steps = new Map<string, number>();
  return {
    async *stream(request) {
      requests.push(structuredClone(request));
      const prompt = request.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n');
      const parent = prompt.includes('Create exactly one default general collaborator');
      const explorer =
        request.tools.some((tool) => tool.id === 'read_file') &&
        !request.tools.some((tool) => tool.id === 'write_file');
      const key = parent ? 'parent' : explorer ? 'explore' : 'business';
      const step = (steps.get(key) ?? 0) + 1;
      steps.set(key, step);
      const matrix = !parent && !explorer && prompt.includes('owned synthetic permission probe');
      if (step > (matrix ? 2 : 1)) {
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      const calls: { name: string; arguments: Record<string, unknown> }[] = [];
      if (parent) {
        calls.push({
          name: 'spawn_agent',
          arguments: { prompt: jsonMatch(prompt, 'complete assignment: ') },
        });
        calls.push({
          name: 'spawn_agent',
          arguments: {
            preset: 'explore',
            prompt: jsonMatch(prompt, 'complete explore assignment: '),
          },
        });
      } else if (explorer) {
        const paths = [...prompt.matchAll(new RegExp(quoted, 'g'))]
          .slice(0, 2)
          .map((match) => JSON.parse(match[0]) as string);
        for (const path of paths) calls.push({ name: 'read_file', arguments: { path } });
        calls.push({
          name: 'shell_execute',
          arguments: {
            command: `cat '${paths[0]}'`,
            filesystem: 'workspace_write',
            network: 'none',
          },
        });
      } else if (matrix) {
        const reads = new RegExp(`Read both (${quoted}) and (${quoted}) using`).exec(prompt)!;
        const inside = JSON.parse(reads[1]!) as string;
        const outside = JSON.parse(reads[2]!) as string;
        calls.push(
          { name: 'read_file', arguments: { path: inside } },
          { name: 'read_file', arguments: { path: outside } },
        );
        for (const match of prompt.matchAll(
          new RegExp(`write_file path=(${quoted}), content=(${quoted}), omitting base_ref`, 'g'),
        ))
          calls.push({
            name: 'write_file',
            arguments: { path: JSON.parse(match[1]!), content: JSON.parse(match[2]!) },
          });
        const actualReads = request.messages
          .filter((message) => message.role === 'tool')
          .map((message) =>
            taskQualityPresentedRead(
              message.content.replace(
                'External file; outside workspace checkpoints. The reference does not grant write permission.\n',
                '',
              ),
            ),
          );
        if (step > 1)
          for (const path of [inside, outside]) {
            const read = actualReads.find(
              (read) => read?.path === path || (path === inside && read?.path === basename(inside)),
            );
            if (!read) continue;
            calls.push({
              name: 'edit_file',
              arguments: {
                path,
                base_ref: read.baseRef,
                old_text: 'field=0',
                new_text: 'field=1',
                expected_matches: 1,
              },
            });
          }
        calls.push({
          name: 'shell_execute',
          arguments: {
            command: jsonMatch(prompt, 'call shell_execute ONCE for '),
            filesystem: 'workspace_write',
            network: 'none',
          },
        });
        calls.push({
          name: 'shell_execute',
          arguments: {
            command: jsonMatch(prompt, 'and ONCE for '),
            filesystem: 'full_access',
            network: 'none',
          },
        });
        if (prompt.includes('Create exactly one explore collaborator'))
          calls.push({
            name: 'spawn_agent',
            arguments: {
              preset: 'explore',
              prompt: `Read ${JSON.stringify(inside)} and ${JSON.stringify(outside)} with read_file and report both real values. Use shell_execute only for a read-only cat of the inside file. Never write or delegate.`,
            },
          });
      } else {
        calls.push({
          name: 'shell_execute',
          arguments: {
            command: jsonMatch(prompt, 'with command '),
            filesystem: 'full_access',
            network: 'none',
          },
        });
      }
      const selectedCalls = matrix
        ? step === 1
          ? calls.filter((call) => call.name === 'read_file')
          : calls.filter((call) => call.name !== 'read_file')
        : calls;
      for (const [index, call] of selectedCalls.entries())
        yield {
          type: 'tool_call',
          id: `controlled-${step}-${index}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        };
      yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const modes = ['accept_edits', 'auto', 'full'] as const;
for (const mode of modes)
  test.skipIf(process.platform !== 'darwin')(
    `real default ${mode} Files/Shell fixture has exact effects and no fabricated approval route`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-live-permission-contract-'));
      const requests: ModelRequest[] = [];
      const reviewerRequests: Record<string, unknown>[] = [];
      const provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          reviewerRequests.push((await request.json()) as Record<string, unknown>);
          const content = JSON.stringify({
            risk: 'ordinary',
            reason: 'Writes one controlled local marker.',
          });
          const chunks = [
            {
              id: 'check',
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
            },
            {
              id: 'check',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ];
          return new Response(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
      });
      const options: LivePermissionOptions = {
        model: controlledModel(requests),
        modelId: 'live',
        requests: () => requests,
        signal: AbortSignal.timeout(15000),
        caseIds: [`permissions-files-${mode}`],
        evidenceRoot: join(root, 'case'),
        hostModel: {
          localCodex: false,
          configuration: {
            modelId: 'live',
            models: [
              {
                id: 'live',
                provider: 'compatible',
                model: 'controlled-loopback',
                baseURL: `${provider.url.href}v1`,
                options: { reasoningEffort: 'medium', maxOutputTokens: 4096 },
              },
            ],
          },
        },
      };
      let passed = false;
      try {
        const result = await runLiveCollaborationPermissions(options);
        expect(result.cases).toHaveLength(1);
        expect(result.cases[0]).toMatchObject({
          status: 'passed',
          canonicalEvidenceRetained: true,
        });
        expect(result.cases[0]!.checks).toMatchObject({
          exactFileInvocationCount: true,
          insideFileEffects: true,
          outsideFileEffects: true,
          noFileApprovals: true,
          exactManualRoute: true,
          fullHasNoCards: true,
          resourcesClosed: true,
        });
        expect(reviewerRequests).toHaveLength(mode === 'auto' ? 2 : 0);
        for (const body of reviewerRequests) {
          expect(body.reasoning_effort).toBe('low');
          expect(body.max_completion_tokens ?? body.max_tokens).toBe(256);
        }
        // The only on-disk test config is empty; connection details remain in memory.
        expect(readFileSync(join(root, 'case', 'configuration', 'empty-user.jsonc'), 'utf8')).toBe(
          '{}\n',
        );
        passed = true;
      } finally {
        provider.stop(true);
        if (passed) rmSync(root, { recursive: true, force: true });
        else console.error(`controlled_permission_evidence_retained:${root}`);
      }
    },
    20000,
  );

test('Shell permission probe preserves complete literal quotes and does not interpolate its target or content', () => {
  expect(livePermissionShellCommand("/owned/root'quoted/file", "line ' $() `data`")).toBe(
    "printf %s 'line '\\'' $() `data`' > '/owned/root'\\''quoted/file'",
  );
});

for (const variant of ['approve', 'deny', 'relax', 'tighten', 'untrusted'])
  test.skipIf(process.platform !== 'darwin')(
    `original ${variant} route uses one real external Shell invocation with the original effect oracle`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-live-original-permission-contract-'));
      const requests: ModelRequest[] = [];
      let passed = false;
      try {
        const result = await runLiveCollaborationPermissions({
          model: controlledModel(requests),
          modelId: 'live',
          requests: () => requests,
          signal: AbortSignal.timeout(15000),
          caseIds: [`permissions-${variant}`],
          evidenceRoot: join(root, 'case'),
          hostModel: {
            localCodex: false,
            configuration: {
              modelId: 'live',
              models: [
                {
                  id: 'live',
                  provider: 'compatible',
                  model: 'controlled-never-contacted',
                  baseURL: 'http://127.0.0.1:1/v1',
                },
              ],
            },
          },
        });
        expect(result.cases).toHaveLength(1);
        expect(result.cases[0]).toMatchObject({
          status: 'passed',
          canonicalEvidenceRetained: true,
        });
        expect(result.cases[0]!.checks).toMatchObject({
          exactlyOneInvocation: true,
          exactTarget: true,
          cardBoundToTarget: true,
          noUnexpectedTool: true,
          noUnknownTool: true,
          resourcesClosed: true,
          independentCustomCheckerNotDefaultAuto: true,
        });
        expect(
          result.cases[0]!.checks[
            variant === 'deny' || variant === 'untrusted' ? 'noEffect' : 'exactEffect'
          ],
        ).toBe(true);
        if (variant === 'relax')
          expect(result.cases[0]!.checks.oldAnswerNoExtraExecution).toBe(true);
        passed = true;
      } finally {
        if (passed) rmSync(root, { recursive: true, force: true });
        else console.error(`controlled_original_permission_evidence_retained:${root}`);
      }
    },
    20000,
  );

test.skipIf(process.platform !== 'darwin')(
  'default general and explore direct children keep their real Full role ceiling',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-live-tree-permission-contract-'));
    const requests: ModelRequest[] = [];
    let passed = false;
    try {
      const result = await runLiveTreePermissions({
        model: controlledModel(requests),
        modelId: 'live',
        requests: () => requests,
        signal: AbortSignal.timeout(15000),
        caseIds: ['tree-files-full'],
        evidenceRoot: join(root, 'case'),
        hostModel: {
          localCodex: false,
          configuration: {
            modelId: 'live',
            models: [
              {
                id: 'live',
                provider: 'compatible',
                model: 'controlled-never-contacted',
                baseURL: 'http://127.0.0.1:1/v1',
              },
            ],
          },
        },
      });
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({ status: 'passed', canonicalEvidenceRetained: true });
      expect(result.cases[0]!.checks).toMatchObject({
        exactGeneralExploreTree: true,
        exploreCatalogueReadOnly: true,
        exploreActuallyReadBoth: true,
        exploreNoMutation: true,
        rootNeverActsForChild: true,
        allInheritedModeScopes: true,
        resourcesClosed: true,
      });
      passed = true;
    } finally {
      if (passed) rmSync(root, { recursive: true, force: true });
      else console.error(`controlled_tree_permission_evidence_retained:${root}`);
    }
  },
  20000,
);

test('nested Shell approval oracle rejects foreign origin, work, parent, command and scope', () => {
  const parent = {
    id: 'tool',
    kind: 'tool',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    sessionId: 's',
    originStoreId: 'store',
    rootWorkCommandId: 'work',
    input: { command: 'printf marker', filesystem: 'full_access', network: 'none' },
  } as ExecutionRecord;
  const job = {
    ...parent,
    id: 'job',
    kind: 'job',
    definitionId: 'shell.command',
    parentExecutionId: parent.id,
    input: {
      command: 'printf marker',
      permissions: { filesystem: 'full_access', network: 'none' },
    },
  } as ExecutionRecord;
  expect(isLivePermissionShellApproval(job, parent, ['printf marker'])).toBe(true);
  for (const patch of [
    { originStoreId: 'foreign' },
    { sessionId: 'foreign' },
    { rootWorkCommandId: 'foreign' },
    { parentExecutionId: 'other' },
    { definitionVersion: '2' },
    {
      input: {
        command: 'printf other',
        permissions: { filesystem: 'full_access', network: 'none' },
      },
    },
    {
      input: {
        command: 'printf marker',
        permissions: { filesystem: 'full_access', network: 'internet' },
      },
    },
  ])
    expect(
      isLivePermissionShellApproval({ ...job, ...patch } as ExecutionRecord, parent, [
        'printf marker',
      ]),
    ).toBe(false);
});

for (const id of ['tree-descendant-mode-relax', 'tree-descendant-mode-tighten'])
  test(`historical ${id} is explicitly unqualified before constructing any model work`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-live-unsupported-topology-'));
    const requests: ModelRequest[] = [];
    try {
      const result = await runLiveTreePermissions({
        model: controlledModel(requests),
        modelId: 'live',
        requests: () => requests,
        signal: new AbortController().signal,
        caseIds: [id],
        evidenceRoot: join(root, 'case'),
      });
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({
        id,
        status: 'blocked',
        reason: 'default_child_creation_unavailable',
        canonicalEvidenceRetained: false,
        checks: { currentRootOnlyCreation: true, actualModelRequests: 0 },
      });
      expect(requests).toHaveLength(0);
      expect(
        JSON.parse(readFileSync(join(root, 'case', 'unsupported-topology.json'), 'utf8')),
      ).toEqual(result.cases[0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
