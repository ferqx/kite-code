import { expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { taskQualityPresentedRead } from '../../../../tests/e2e/live/model/agent-task-quality-fixture';

type ProviderBody = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters: unknown } }[];
};

/** Real local SDK transport for the same read/update/create journey in each caller. */
export function createFileCheckpointProvider(
  additionalMarkers: Record<string, 'first' | 'second' | 'fork'> = {},
) {
  const requests: ProviderBody[] = [],
    steps = new Map<string, number>();
  const attachmentPrefix =
    '\n\nAttached file references (user-provided data; paths do not grant permissions):\n';
  const markers = new Map<string, 'first' | 'second' | 'fork'>([
    ['FIRST_ACTUAL_RUN: read then update original and create first file', 'first'],
    ['SECOND_ACTUAL_RUN: read then update original and create second file', 'second'],
    ...Object.entries(additionalMarkers),
  ]);
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as ProviderBody;
      requests.push(body);
      const key = body.messages
        .slice()
        .reverse()
        .filter((message) => message.role === 'user')
        .map((message) =>
          markers.get(message.content.split(attachmentPrefix, 1)[0]!.replace(/^New task: /, '')),
        )
        .find((marker) => marker !== undefined);
      if (!key) throw Error('actual_file_user_marker_unavailable');
      const step = steps.get(key) ?? 0;
      if (step >= (key === 'fork' ? 2 : 4)) throw Error('actual_file_model_route_exhausted');
      steps.set(key, step + 1);
      let call: { name: string; input: Json } | null = null;
      if (key === 'fork') {
        if (step === 0) {
          const selected = body.messages.find(
            (message) => message.role === 'user' && message.content.startsWith('FIRST_ACTUAL_RUN:'),
          );
          const projected = selected?.content.split(attachmentPrefix)[1];
          const [attachment] = JSON.parse(projected ?? '[]') as { uri: string }[];
          if (!attachment) throw Error('actual_fork_attachment_missing');
          call = { name: 'read_file', input: { path: fileURLToPath(attachment.uri) } };
        }
      } else if (step === 0)
        call = { name: 'read_file', input: { path: 'original.txt', limit: 10000 } };
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
            content: `${key} actual modified UTF8\r\n`,
          },
        };
      } else if (step === 2)
        call = {
          name: 'write_file',
          input: {
            path: `${key}-created.txt`,
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
