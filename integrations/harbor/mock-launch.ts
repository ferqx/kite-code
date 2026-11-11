/** Isolated smoke artifact only. The real Kite runtime, not this fixture, writes the task output. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionTitleInstructions } from '../../packages/agent/src/business/session-title/title';
import { parseLaunchArguments, runKiteTask } from './runtime';

const args = parseLaunchArguments(process.argv.slice(2));
mkdirSync(args.output, { recursive: true, mode: 0o700 });
let businessRequests = 0,
  titleRequests = 0,
  writeCalls = 0;
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions')
      return new Response('Unknown local fixture route', { status: 404 });
    const input = (await request.json()) as {
      messages: { role: string; content: unknown }[];
      tools?: { function: { name: string } }[];
    };
    const isTitle = input.messages.some(
      (message) => message.role === 'system' && message.content === sessionTitleInstructions,
    );
    if (isTitle) titleRequests++;
    else businessRequests++;
    appendFileSync(
      join(args.output, 'fixture-requests.jsonl'),
      `${JSON.stringify({ isTitle, input })}\n`,
      { mode: 0o600 },
    );
    let delta: unknown;
    let finish = 'stop';
    if (isTitle) delta = { content: 'Harbor Kite adapter smoke' };
    else if (businessRequests === 1) {
      if (!input.tools?.some((tool) => tool.function.name === 'write_file'))
        return new Response('Real write_file tool was not advertised', { status: 500 });
      writeCalls++;
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'harbor-smoke-write',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'answer.txt',
                content: 'Kite Harbor adapter smoke passed\n',
              }),
            },
          },
        ],
      };
      finish = 'tool_calls';
    } else if (businessRequests === 2 && input.messages.some((message) => message.role === 'tool'))
      delta = { content: 'Created answer.txt using the real Kite file-writing tool.' };
    else return new Response('Unexpected fixture request; no fallback answer', { status: 500 });
    const frame = (value: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'harbor-local-fixture', object: 'chat.completion.chunk', model: 'deterministic-tool-fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    return new Response(`${frame(delta, null) + frame({}, finish)}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});
try {
  const report = await runKiteTask(args, {
    configuration: {
      modelId: 'harbor-local-fixture',
      models: [
        {
          id: 'harbor-local-fixture',
          provider: 'compatible',
          model: 'deterministic-tool-fixture',
          baseURL: `${provider.url.href}v1`,
          modelCapabilities: { contextWindowTokens: 32768 },
        },
      ],
    },
    classification: 'deterministic-mock-plumbing-only',
    beforeExport: () => businessRequests + titleRequests,
    afterExport: (before) => {
      if (before !== businessRequests + titleRequests)
        throw Error('export_triggered_model_request');
    },
  });
  const evidence = {
    classification: 'deterministic-mock-plumbing-only',
    businessRequests,
    titleRequests,
    writeCalls,
    outputProducedByRealKiteTool:
      existsSync(join(args.workspace, 'answer.txt')) &&
      readFileSync(join(args.workspace, 'answer.txt'), 'utf8') ===
        'Kite Harbor adapter smoke passed\n',
  };
  writeFileSync(
    join(args.output, 'fixture-summary.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (
    report.status !== 'succeeded' ||
    businessRequests !== 2 ||
    writeCalls !== 1 ||
    !evidence.outputProducedByRealKiteTool
  )
    process.exitCode = 1;
  console.log(JSON.stringify(report));
} finally {
  provider.stop(true);
}
