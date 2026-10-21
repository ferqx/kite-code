import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { runServiceProcess } from '../../src/main';

const running = runServiceProcess({
  configure(startup) {
    const host = startup.hostConfiguration as {
      entered: string;
      cancelled: string;
      release: string;
      terminal: string;
      models: string;
    };
    const finish: ModelEvent = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const call = (name: string, input: unknown): ModelEvent[] => [
      { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
      { ...finish, reason: 'tool_calls' },
    ];
    const model = (actor: 'parent' | 'worker' | 'leaf'): ModelAdapter => {
      let calls = 0;
      return {
        async *stream() {
          appendFileSync(host.models, `${actor}:${calls}\n`);
          const stage = calls++;
          const events =
            actor === 'leaf'
              ? stage === 0
                ? call('fixture.hold', {})
                : [finish]
              : stage === 0
                ? call('spawn_agent', {
                    prompt: `${actor} delegates original work`,
                    ...(actor === 'worker' ? { preset: 'leaf' } : {}),
                  })
                : stage === 1
                  ? call('wait_agent_events', { after_seq: '0', wait_ms: 180000 })
                  : [finish];
          for (const event of events) yield event;
        },
      };
    };
    const hold: ToolDefinition = {
      id: 'fixture.hold',
      version: '1',
      description: 'Owned cancellation cleanup with an explicit release boundary',
      inputSchema: { type: 'object', additionalProperties: false },
      async execute(_input, context) {
        writeFileSync(host.entered, context.executionId);
        if (!context.signal.aborted)
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        writeFileSync(host.cancelled, context.executionId);
        while (!existsSync(host.release)) await Bun.sleep(10);
        writeFileSync(host.terminal, context.executionId);
        return { outcome: 'cancelled', content: 'Original owned cleanup confirmed' };
      },
    };
    const tasks = createTaskExtension({
      defaultRole: 'worker',
      presets: ['leaf'],
      roles: [
        { id: 'worker', configurationId: 'worker', description: 'Trusted worker' },
        { id: 'leaf', configurationId: 'leaf', description: 'Trusted leaf' },
      ],
    });
    return {
      model: model('parent'),
      modelId: 'parent',
      modelConcurrency: 1,
      maxConcurrentSubagents: 1,
      extensions: [{ ...tasks, tools: [...tasks.tools!, hold] }],
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: model('worker'),
          modelId: 'worker',
          toolIds: ['task.spawn', 'task.events', hold.id],
          snapshot: {},
        },
        {
          id: 'leaf',
          version: '1',
          model: model('leaf'),
          modelId: 'leaf',
          toolIds: [hold.id],
          snapshot: {},
        },
      ],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    };
  },
});

// This isolated fixture exposes readiness only to its direct incomplete-startup tests.
if (process.env.KITE_SHUTDOWN_FIXTURE_READY)
  writeFileSync(process.env.KITE_SHUTDOWN_FIXTURE_READY, 'startup reader installed');
await running;
