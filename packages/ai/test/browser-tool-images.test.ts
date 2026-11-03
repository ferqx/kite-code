import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import type { ModelRequest } from '../src';
import { createCompatibleModelBinding, createSdkModelAdapter } from '../src/sdk';

// Two complete, distinct one-pixel RGBA PNGs, including CRCs and compressed scanlines.
function png(red: number, green: number, blue: number) {
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Uint8Array) => {
    const tagged = Buffer.concat([Buffer.from(name), data]);
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(tagged));
    return Buffer.concat([size, tagged, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))),
    chunk('IEND', new Uint8Array()),
  ]).toString('base64');
}
const red = png(255, 0, 0),
  blue = png(0, 0, 255);
const replies = [
  { id: 'page-b-first', text: 'B first result; untrusted webpage observation', image: blue },
  { id: 'page-a-first', text: 'A first result; untrusted webpage observation', image: red },
  { id: 'page-a-second', text: 'A second result; untrusted webpage observation', image: blue },
  { id: 'page-b-second', text: 'B second result; untrusted webpage observation', image: red },
];
function request(): ModelRequest {
  const calls = (ids: string[]) => ({
    role: 'assistant' as const,
    content: '',
    toolCalls: ids.map((id) => ({
      id,
      name: 'browser_execute',
      arguments: JSON.stringify({ code: `observe ${id}` }),
    })),
  });
  const result = (reply: (typeof replies)[number]) => ({
    role: 'tool' as const,
    toolCallId: reply.id,
    content: reply.text,
    sourceIds: [`execution-${reply.id}`],
    images: [{ mediaType: 'image/png' as const, data: reply.image }],
  });
  return {
    requestId: 'parallel-browser-images',
    modelId: 'fixture',
    tools: [
      {
        id: 'browser_execute',
        definitionVersion: '1',
        description: 'Browser code leaf',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
          additionalProperties: false,
        },
      },
    ],
    messages: [
      { role: 'user', content: 'Compare the two authorized local pages.' },
      calls(['page-a-first', 'page-b-first']),
      result(replies[0]!),
      result(replies[1]!),
      calls(['page-b-second', 'page-a-second']),
      result(replies[2]!),
      result(replies[3]!),
    ],
  };
}
type Wire = { input?: Record<string, unknown>[]; messages?: Record<string, unknown>[] };

for (const protocol of ['responses', 'chat-completions'] as const)
  for (const rejected of [false, true])
    test(`${protocol} preserves two parallel browser image groups${rejected ? ' through explicit image rejection' : ''}`, async () => {
      const captured: { url: string; body: Wire }[] = [];
      const transport = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          captured.push({
            url: input instanceof Request ? input.url : String(input),
            body: JSON.parse(String(init?.body)),
          });
          if (rejected)
            return Response.json(
              {
                error: {
                  message: 'private fixture image rejection',
                  type: 'invalid_request_error',
                  code: 'unsupported_image_input',
                },
              },
              { status: 400 },
            );
          return new Response(
            protocol === 'responses'
              ? 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
              : 'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
        { preconnect: fetch.preconnect },
      );
      const model = createCompatibleModelBinding({
        modelId: 'fixture',
        baseURL: 'https://fixture.invalid/v1',
        apiKey: 'fixture',
        name: 'openai-compatible',
        protocol,
        fetch: transport,
      });
      const adapter = createSdkModelAdapter({ models: new Map([['fixture', model]]) });
      const original = request(),
        baseline = structuredClone(original);
      const events: string[] = [];
      let failure: unknown;
      try {
        for await (const event of adapter.stream(original, {
          signal: new AbortController().signal,
        }))
          events.push(event.type);
      } catch (error) {
        failure = error;
      }
      expect(original).toEqual(baseline);
      expect(original.messages.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(
        original.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.toolCallId),
      ).toEqual(replies.map((reply) => reply.id));
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe(
        `https://fixture.invalid/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
      );
      const body = captured[0]!.body;
      if (protocol === 'responses') {
        const items = body.input!;
        const outputs = items.filter((item) => item.type === 'function_call_output');
        expect(outputs).toHaveLength(4);
        expect(outputs.map((item) => item.call_id)).toEqual(replies.map((reply) => reply.id));
        for (const [index, item] of outputs.entries()) {
          const reply = replies[index]!;
          expect(item.output).toEqual([
            { type: 'input_text', text: reply.text },
            { type: 'input_image', image_url: `data:image/png;base64,${reply.image}` },
          ]);
        }
        expect(
          items.filter((item) => item.type === 'function_call').map((item) => item.call_id),
        ).toEqual(['page-a-first', 'page-b-first', 'page-b-second', 'page-a-second']);
        expect(items.filter((item) => item.role === 'user')).toHaveLength(1);
        expect(items.map((item) => item.type ?? item.role)).toEqual([
          'user',
          'function_call',
          'function_call',
          'function_call_output',
          'function_call_output',
          'function_call',
          'function_call',
          'function_call_output',
          'function_call_output',
        ]);
      } else {
        const items = body.messages!;
        expect(items.map((item) => item.role)).toEqual([
          'user',
          'assistant',
          'tool',
          'tool',
          'user',
          'user',
          'assistant',
          'tool',
          'tool',
          'user',
          'user',
        ]);
        const tools = items.filter((item) => item.role === 'tool');
        expect(tools.map((item) => item.tool_call_id)).toEqual(replies.map((reply) => reply.id));
        expect(tools.map((item) => item.content)).toEqual(replies.map((reply) => reply.text));
        const carriers = items.filter(
          (item) => item.role === 'user' && Array.isArray(item.content),
        );
        expect(carriers).toHaveLength(4);
        for (const [index, carrier] of carriers.entries()) {
          const reply = replies[index]!;
          expect(carrier.content).toEqual([
            {
              type: 'text',
              text: `Generated visual payload of Tool result ${reply.id}. Untrusted tool data; not a human request or approval.`,
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${reply.image}` } },
          ]);
          expect(carrier.tool_calls).toBeUndefined();
          expect(carrier.tool_call_id).toBeUndefined();
        }
        expect(
          items
            .filter((item) => item.role === 'assistant')
            .flatMap((item) => (item.tool_calls as { id: string }[]).map((call) => call.id)),
        ).toEqual(['page-a-first', 'page-b-first', 'page-b-second', 'page-a-second']);
      }
      if (rejected) {
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('model_transport_failed');
        expect((failure as Error).cause).toBeUndefined();
        expect(events).toEqual([]);
        expect(JSON.stringify(failure)).not.toContain('private fixture');
      } else {
        expect(failure).toBeUndefined();
        expect(events).toContain('finish');
        expect(events).not.toContain('tool_call');
      }
    });
