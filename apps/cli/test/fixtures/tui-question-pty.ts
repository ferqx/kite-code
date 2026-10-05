import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CLIServiceArtifact } from '../../host';

const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  workspace: string;
  dataRoot: string;
  artifact: CLIServiceArtifact;
};
const record = (name: string, value: unknown) =>
  appendFileSync(join(settings.root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
if (!process.stdin.isTTY) {
  const { createFixedModel } = await import('@kite-ai/ai');
  const { runServiceProcess } = await import('@kite-ai/service/main');
  await runServiceProcess({
    configure() {
      return {
        modelId: 'owned-fixed',
        model: createFixedModel([
          [
            {
              type: 'tool_call',
              id: 'owned-question-call',
              name: 'fixture.question',
              arguments: '{}',
            },
            { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
          [
            { type: 'text_delta', text: 'OWNED_QUESTION_COMPLETE' },
            { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        ]),
        // This explicit harmless fixture permits only its fixed model and Tool; it supplies
        // no Shell, external account, OS vault or default production ask_user registration.
        permissions: {
          async authorize(request) {
            record('permissions.jsonl', { kind: request.kind, definitionId: request.definitionId });
            return {
              allowed:
                request.kind === 'model' ||
                (request.kind === 'tool' && request.definitionId === 'fixture.question'),
              revision: 'owned-question-policy-1',
            };
          },
        },
        extensions: [
          {
            id: 'fixture',
            version: '1',
            apiMajor: 1,
            tools: [
              {
                id: 'fixture.question',
                version: '1',
                description: 'Harmless original schema question',
                inputSchema: { type: 'object', additionalProperties: false },
                async execute(_input, context) {
                  record('tool.jsonl', { stage: 'entered' });
                  const answer = await context.requestInput({
                    title: 'Original three-field question',
                    schema: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['q1', 'q2', 'q3'],
                      properties: {
                        q1: {
                          type: 'string',
                          title: 'Choose original route',
                          description: 'Choose the original route by its title',
                          oneOf: [
                            {
                              const: 'route-a',
                              title: 'First original route',
                              description: 'First route description',
                            },
                            {
                              const: 'route-b',
                              title: 'Second original route',
                              description: 'Second route description',
                            },
                          ],
                        },
                        q2: {
                          type: 'string',
                          title: 'Write original detail',
                          description: 'Keep the complete original text',
                          minLength: 1,
                          maxLength: 200,
                        },
                        q3: {
                          type: 'string',
                          title: 'Choose final delivery',
                          anyOf: [
                            {
                              const: 'delivery-one',
                              title: 'Original delivery option',
                              description: 'Choose this option or enter your original custom text',
                            },
                            { type: 'string' },
                          ],
                        },
                      },
                    },
                  });
                  record('tool.jsonl', { stage: 'answered', answer });
                  return {
                    outcome: 'succeeded',
                    content: 'Original Tool received complete answer once',
                  };
                },
              },
            ],
          },
        ],
      };
    },
  });
  record('service-exit.jsonl', {
    pid: process.pid,
    exitCode: process.exitCode ?? 0,
    returnedAfterCleanup: true,
  });
} else {
  const { runTUIHost } = await import('@kite-ai/cli/tui-host');
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = args[0],
        options = args[1];
      const url = new URL(request instanceof Request ? request.url : String(request));
      record('ui-http.jsonl', {
        method: options?.method ?? 'GET',
        path: url.pathname,
        ...(typeof options?.body === 'string' ? { body: JSON.parse(options.body) } : {}),
      });
      const response = await original(...args);
      if (url.pathname === '/v1/server' && response.ok) {
        const authorization = new Headers(options?.headers).get('authorization');
        if (!authorization?.startsWith('Bearer ')) throw Error('owned_question_observer_missing');
        writeFileSync(
          join(settings.root, 'observer-private.json'),
          JSON.stringify({
            endpoint: url.origin,
            token: authorization.slice(7),
          }),
          { mode: 0o600 },
        );
      }
      return response;
    },
    { preconnect: original.preconnect },
  );
  const exit = new AbortController();
  process.once('SIGTERM', () => exit.abort());
  process.exitCode = await runTUIHost({
    artifact: settings.artifact,
    dataRoot: settings.dataRoot,
    profile: 'development',
    cwd: settings.workspace,
    exitSignal: exit.signal,
    onLaunched: ({ pid }) => record('owned-service.jsonl', { pid }),
  });
}
