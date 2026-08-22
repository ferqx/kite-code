#!/usr/bin/env bun

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { refreshSkillCatalog } from '@kite/builtin-runtime';
import { skillDirs } from '#app/config/paths';
import { openState25Store4ForTestV1 } from '../../scripts/support/runtime-storage';
import { runTestRuntimeAgentV1 } from '../helpers/runtime-model';

const skillName = process.env.SKILL_E2E_NAME;
const expectedScope = process.env.SKILL_E2E_EXPECTED_SCOPE;
const expectedMarker = process.env.SKILL_E2E_EXPECTED_MARKER;
const forbiddenMarker = process.env.SKILL_E2E_FORBIDDEN_MARKER;
const readPath = process.env.SKILL_E2E_READ_PATH;
const expectedContent = process.env.SKILL_E2E_EXPECTED_CONTENT;

if (!skillName || !expectedScope || !expectedMarker || !readPath || !expectedContent) {
  throw new Error('Missing Skill E2E client parameters.');
}

function generated(content: Array<Record<string, unknown>>, finishReason: 'stop' | 'tool-calls') {
  return {
    content,
    finishReason: {
      unified: finishReason,
      raw: finishReason === 'tool-calls' ? 'tool_calls' : 'stop',
    },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50 },
      totalTokens: 150,
    },
  };
}

function createAdaptiveSkillModel() {
  let callCount = 0;
  const prompts: string[] = [];
  const model = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'adaptive-skill-e2e',
    supportedUrls: {},
    async doGenerate(options: { prompt?: unknown }) {
      const prompt = JSON.stringify(options.prompt ?? []);
      prompts.push(prompt);
      if (callCount++ === 0) {
        return generated(
          [
            {
              type: 'tool-call',
              toolCallId: 'skill-read-file',
              toolName: 'read_file',
              input: { path: readPath },
            },
          ],
          'tool-calls',
        );
      }
      if (callCount === 2) {
        const activationId = prompt.match(
          /When finished, call complete_skill with this activation ID: ([0-9a-f-]{36})/,
        )?.[1];
        if (!activationId)
          throw new Error('Active Skill activation ID was not projected to the model.');
        return generated(
          [
            {
              type: 'tool-call',
              toolCallId: 'skill-complete',
              toolName: 'complete_skill',
              input: {
                activation_id: activationId,
                output: { scope: expectedScope, content: expectedContent },
              },
            },
          ],
          'tool-calls',
        );
      }
      return generated(
        [{ type: 'text', text: `${expectedScope} Skill execution completed.` }],
        'stop',
      );
    },
    async doStream() {
      throw new Error('Streaming is not used by the Skill E2E fixture.');
    },
  };
  return {
    binding: { model, capabilityMetadata: { streaming: false } },
    prompts,
  };
}

const workspace = process.cwd();
const options = skillDirs(workspace);
const catalog = refreshSkillCatalog(options);
const selected = catalog.entries.find(
  (entry) => !entry.shadowedBy && entry.descriptor.capabilityId === `skill:${skillName}`,
);
if (!selected?.contract) throw new Error(`Skill '${skillName}' was not loaded from disk.`);

const runtimeDir = join(workspace, '.kite-code');
mkdirSync(runtimeDir, { recursive: true });
const adaptive = createAdaptiveSkillModel();
const events: RuntimeEvent[] = [];
for await (const event of runTestRuntimeAgentV1(
  {
    task: `Run the ${expectedScope} scoped Skill.`,
    threadId: `skill-e2e-${expectedScope}`,
    userId: 'e2e',
    workspace,
    openState25SessionStorage: () =>
      openState25Store4ForTestV1(join(runtimeDir, `skill-e2e-${expectedScope}.db`)),
    // This fixture exercises Skill activation and completion, not plan authoring.
    // Keep its final answer outside an incomplete planning lifecycle.
    phase: 'building',
    model: adaptive.binding as never,
    skillOptions: options,
    initialSkillActivations: [{ skillId: `skill:${skillName}`, input: { scope: expectedScope } }],
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
      features: { skillWorkflowV1: true, skillActivationV2: true },
    },
  },
  { requestAction: async () => ({ type: 'cancel', interactionId: 'unexpected' }) },
)) {
  events.push(event);
}

const promptText = adaptive.prompts.join('\n');
console.log(
  JSON.stringify({
    provenance: selected.descriptor.provider.provenance,
    sourcePath: selected.sourcePath,
    eventTypes: events.map((event) => event.type),
    frameClosed: events.some(
      (event) => event.type === 'skill.frame_closed' && event.status === 'closed',
    ),
    sawExpectedMarker: promptText.includes(expectedMarker),
    sawForbiddenMarker: forbiddenMarker ? promptText.includes(forbiddenMarker) : false,
  }),
);
