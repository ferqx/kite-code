import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { estimateModelContext } from '@kite-ai/agent/context-estimate';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createWorkspaceAssembly } from '../../src/assembly';
import { createSummaryCompressor } from '../../src/compression-configuration';

async function skillFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-skill-window-')));
  const workspace = join(root, 'workspace');
  const skill = join(workspace, 'guide');
  mkdirSync(skill, { recursive: true });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  return {
    root,
    skill,
    profile,
    store,
    scope: { expectedStoreId, sessionId: 's', subjectId: 'owner' },
    createAssembly: () =>
      createWorkspaceAssembly({
        workspaceRoot: workspace,
        profile,
        skills: [{ id: 'guide', path: skill }],
        selectedSkills: ['guide'],
        toolIds: ['skills.load', 'skills.resource'],
      }),
    async start(runtime: ReturnType<typeof createRuntime>, content: string) {
      const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Fixture',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...scope,
        workspaceId: 'w',
        commandId: 'create',
        title: 'Fixture',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: { kind: 'run.start', content },
      });
      const work = await runtime.waitForCommand('work', { timeoutMs: 10_000 });
      expect(work.receipt).toMatchObject({ runId: expect.any(String) });
      return work;
    },
  };
}

const permissions = { authorize: async () => ({ allowed: true, revision: 'owned' }) };

for (const edit of ['unread body', 'description'] as const) {
  test(`a sealed Model decision tracks the visible Skill directory when changing ${edit}`, async () => {
    const fixture = await skillFixture();
    const { store, profile, skill } = fixture;
    const path = join(skill, 'SKILL.md');
    const writeGuide = (description: string, body: string) => {
      writeFileSync(path, `---\nname: Guide\ndescription: ${description}\n---\n${body}\n`);
    };
    writeGuide('Original description', 'Original guide body.');
    const planned: string[] = [];
    const dispatched: ModelRequest[] = [];
    const observed = new Proxy(store, {
      get(target, key) {
        if (key === 'planExecution')
          return async (input: Parameters<typeof store.planExecution>[0]) => {
            const result = await store.planExecution(input);
            if (result.kind === 'model') {
              planned.push(result.id);
              if (planned.length === 1)
                writeGuide(
                  edit === 'description' ? 'New description' : 'Original description',
                  'Updated guide body.',
                );
            }
            return result;
          };
        return Reflect.get(target, key);
      },
    });
    const model: ModelAdapter = {
      async *stream(request) {
        dispatched.push(request);
        yield { type: 'text_delta', text: 'Done.' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const runtime = createRuntime({
      store: observed,
      artifacts: createArtifactStore({ profile, store }),
      permissions,
      resolveRunConfiguration: async () => ({
        ...(await fixture.createAssembly()),
        model,
        modelId: 'fixture',
        snapshot: { fixture: 'catalogue' },
      }),
    });
    try {
      await fixture.start(runtime, 'Review the available guide.');
      expect((await store.getView('s')).runs[0]?.status).toBe('completed');
      expect(planned).toHaveLength(edit === 'description' ? 2 : 1);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.requestId).toBe(planned.at(-1)!);
      expect(
        dispatched[0]?.messages.some(({ content }) =>
          content.includes(edit === 'description' ? 'New description' : 'Original description'),
        ),
      ).toBe(true);
      expect(
        dispatched[0]?.messages.some(({ content }) => content.includes('Updated guide body.')),
      ).toBe(false);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test('a sealed Skill directory can still verify its exact legacy digest', async () => {
  const fixture = await skillFixture();
  const { scope, skill, store } = fixture;
  const content = '---\nname: Guide\ndescription: A guide\n---\nOriginal guide body.\n';
  writeFileSync(join(skill, 'SKILL.md'), content);
  const assembly = await fixture.createAssembly();
  try {
    const request = { ...scope, workspaceId: 'w', definitionId: 'fixture', input: null };
    const capture = async (sealedSkillCatalogueDigest?: string) =>
      (
        await assembly.sources.capture(request, {
          skillReads: [],
          skillResourceIds: new Set(),
          sealedSkillCatalogueDigest,
        })
      ).find(({ kind }) => kind === 'skill_catalogue')!;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const originalVisible = await capture();
    const legacy = hash(
      JSON.stringify(
        assembly.snapshotFacts.skills.map(({ id, version, requiredCapabilities }) => ({
          id,
          version,
          name: 'Guide',
          description: 'A guide',
          requiredCapabilities,
        })),
      ),
    );
    expect(originalVisible.digest).toBe(hash(originalVisible.content));
    expect((await capture(legacy)).digest).toBe(legacy);
    writeFileSync(join(skill, 'SKILL.md'), content.replace('Original', 'Updated'));
    expect(await capture(legacy)).toEqual(originalVisible);
  } finally {
    await assembly.dispose();
    await store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the published minimum compression window keeps optional covered Skill resources out of business requests', async () => {
  const fixture = await skillFixture();
  const { profile, scope, skill, store } = fixture;
  const original = `Keep my exact original request.${' working'.repeat(3500)}`;
  const correction = `Keep the latest correction exactly.${' correct'.repeat(400)}`;
  const resource = `OPTIONAL_GUIDE_REFERENCE${' memo'.repeat(320)}`;
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: Guide\ndescription: A guide\n---\nGuide body.\n[Note](note.txt)\n',
  );
  writeFileSync(join(skill, 'note.txt'), resource);
  const business: ModelRequest[] = [];
  let summaries = 0;
  let afterTokens = 0;
  const compressor = createSummaryCompressor({
    automatic: { contextWindowTokens: 7624, maxOutputTokens: 600 },
    shouldCompress: async (input) =>
      summaries === 0 &&
      business.length === 2 &&
      input.messages.some(({ content }) => content === correction),
  });
  const observed = new Proxy(store, {
    get(target, key) {
      if (key === 'finishExecution')
        return async (input: Parameters<typeof store.finishExecution>[0]) => {
          const result = await store.finishExecution(input);
          if (result.definitionId === 'skills.load' && result.status === 'succeeded') {
            const run = (await store.getRun(result.runId!))!;
            await runtime.submitCommand({
              ...scope,
              commandId: 'correction',
              request: {
                kind: 'input.steer',
                targetRunId: run.id,
                contextSelectionId: run.contextSelectionId,
                content: correction,
              },
            });
          }
          return result;
        };
      return Reflect.get(target, key);
    },
  });
  const model: ModelAdapter = {
    async *stream(request) {
      const summarizing = !request.tools.length;
      const inputTokens = estimateModelContext(request).estimate.totalInputTokens;
      if (summarizing) {
        summaries++;
        yield { type: 'text_delta', text: `Original notes settled.${' summary'.repeat(160)}` };
      } else {
        business.push(request);
        if (business.length === 1)
          yield {
            type: 'tool_call',
            id: 'read',
            name: 'read_skill_resource',
            arguments: '{"skill_id":"guide","path":"note.txt"}',
          };
        else if (business.length === 2)
          yield {
            type: 'tool_call',
            id: 'load',
            name: 'load_skill',
            arguments: '{"skill_id":"guide"}',
          };
        else yield { type: 'text_delta', text: 'Done.' };
      }
      yield {
        type: 'finish',
        reason: !summarizing && business.length < 3 ? 'tool_calls' : 'stop',
        usage: { inputTokens, outputTokens: 5 },
      };
    },
  };
  const runtime = createRuntime({
    store: observed,
    artifacts: createArtifactStore({ profile, store }),
    permissions,
    async resolveRunConfiguration(): Promise<RunConfiguration> {
      return {
        ...(await fixture.createAssembly()),
        model,
        modelId: 'fixture',
        snapshot: { fixture: 'compression-window' },
        compressor: {
          ...compressor,
          async validateSummary(input) {
            expect(
              input.replacementMessages?.some(({ content }) => content.includes(resource)),
            ).toBe(false);
            afterTokens = estimateModelContext({
              messages: [
                ...input.replacementMessages!,
                { role: 'user', content: input.renderedSummary ?? input.summary },
              ],
              tools: input.tools ?? [],
            }).estimate.totalInputTokens;
            return compressor.validateSummary!(input);
          },
        },
      };
    },
  });
  try {
    try {
      await fixture.start(runtime, original);
      expect((await store.getView('s')).runs[0]?.status).toBe('completed');
      expect(summaries).toBe(1);
      expect(business).toHaveLength(3);
      expect(business[1]!.messages.some(({ content }) => content.includes(resource))).toBe(true);
      const successor = business[2]!;
      expect(successor.messages.some(({ content }) => content.includes(resource))).toBe(false);
      expect(successor.messages.some(({ content }) => content === original)).toBe(true);
      expect(successor.messages.some(({ content }) => content === correction)).toBe(true);
      expect(
        successor.messages.some(({ toolCalls }) => toolCalls?.some(({ id }) => id === 'load')),
      ).toBe(true);
      expect(
        successor.messages.some(({ role, toolCallId }) => role === 'tool' && toolCallId === 'load'),
      ).toBe(true);
      expect(afterTokens).toBeGreaterThan(0);
      expect(afterTokens).toBeLessThanOrEqual(compressor.windowBudget!.usableInputTokens!);
    } finally {
      await runtime.close();
      await store.close();
    }
    const reopened = await openSqliteStore(profile);
    try {
      const compression = (await reopened.getModelContext(scope)).compression;
      expect(compression?.recentHistoryTokens).toBe(0);
      expect(
        (await reopened.getCompressionOrigin({ ...scope, compressionId: compression!.id }))
          .recentHistoryTokens,
      ).toBe(0);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
