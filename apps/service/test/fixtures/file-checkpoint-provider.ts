import { expect } from 'bun:test';
import type { Json } from '@kite-ai/agent/extensions';
import { taskQualityPresentedRead } from '../../../../tests/e2e/live/model/agent-task-quality-fixture';

type ProviderBody = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters: unknown } }[];
};

/** Real local SDK transport for the same read/update/create journey in each caller. */
export function createFileCheckpointProvider(
  additionalMarkers: Record<string, 'first' | 'second'> = {},
) {
  const requests: ProviderBody[] = [],
    steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as ProviderBody;
      requests.push(body);
      const user = body.messages
        .slice()
        .reverse()
        .find(
          (message) =>
            message.role === 'user' &&
            /^(?:New task: )?(FIRST|SECOND)_ACTUAL_RUN:/.test(message.content),
        )?.content;
      const markers: Record<string, string> = {
        'FIRST_ACTUAL_RUN: read then update original and create first file': 'first',
        'SECOND_ACTUAL_RUN: read then update original and create second file': 'second',
        ...additionalMarkers,
      };
      const key = user === undefined ? undefined : markers[user.replace(/^New task: /, '')];
      if (!key) throw Error('actual_file_user_marker_unavailable');
      const step = steps.get(key) ?? 0;
      if (step >= 4) throw Error('actual_file_model_route_exhausted');
      steps.set(key, step + 1);
      let call: { name: string; input: Json } | null = null;
      if (step === 0)
        call = { name: 'read_file', input: { path: 'original.txt', max_lines: 10000 } };
      else if (step === 1) {
        const read = body.messages.filter((message) => message.role === 'tool').at(-1);
        if (!read) throw Error('actual_file_read_baseline_missing');
        const actual = taskQualityPresentedRead(read.content);
        if (!actual) throw Error('actual_file_read_result_invalid');
        expect(actual.path).toBe('original.txt');
        call = {
          name: 'write_file',
          input: {
            path: 'original.txt',
            base: actual.baseline,
            content: `${key} actual modified UTF8\r\n`,
          },
        };
      } else if (step === 2)
        call = {
          name: 'write_file',
          input: {
            path: `${key}-created.txt`,
            base: null,
            content: `${key} actual created bytes\r\n`,
          },
        };
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `files-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: `${key} complete` },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    provider,
    requests,
    steps,
    model: {
      id: 'fixed',
      provider: 'compatible',
      model: 'fixed',
      baseURL: `${provider.url.href}v1`,
      // This finite provider implements Files steps, not the summary algorithm.
      // Declare its synthetic window so automatic compression has its own fixture.
      modelCapabilities: { contextWindowTokens: 1_000_000 },
    },
  };
}
