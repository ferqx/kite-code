import { expect, test } from 'bun:test';
import type { ModelRequest } from '../src';
import { createCompatibleModelBinding, createSdkModelAdapter } from '../src/sdk';

for (const [protocol, families] of [
  ['chat-completions', ['openai', 'deepseek', 'kimi', 'glm', 'qwen', 'openai-compatible']],
  ['responses', ['openai', 'openai-compatible']],
] as const)
  for (const name of families)
    test(`${name}/${protocol} sends exact image parts and rejects image URLs`, async () => {
      const bodies: unknown[] = [];
      const transport = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
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
        protocol,
        name,
        fetch: transport,
      });
      const adapter = createSdkModelAdapter({ models: new Map([['fixture', model]]) });
      const request: ModelRequest = {
        requestId: 'image',
        modelId: 'fixture',
        tools: [],
        messages: [
          { role: 'user', content: 'caption', images: [{ mediaType: 'image/png', data: 'AQID' }] },
        ],
      };
      for await (const _ of adapter.stream(request, { signal: new AbortController().signal })) {
      }
      const wire = JSON.stringify(bodies);
      expect(wire).toContain('data:image/png;base64,AQID');
      expect(wire).toContain('caption');
      expect(wire).toContain(protocol === 'responses' ? 'input_image' : 'image_url');
      const body = bodies[0] as {
        input?: { content: unknown }[];
        messages?: { content: unknown }[];
      };
      expect((protocol === 'responses' ? body.input : body.messages)?.[0]?.content).toEqual(
        protocol === 'responses'
          ? [
              { type: 'input_text', text: 'caption' },
              { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
            ]
          : [
              { type: 'text', text: 'caption' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
            ],
      );
      const invalid: ModelRequest = {
        ...request,
        messages: [
          {
            role: 'user',
            content: 'caption',
            images: [{ mediaType: 'image/png', data: 'https://image.invalid/private' }],
          },
        ],
      };
      await expect(
        (async () => {
          for await (const _ of adapter.stream(invalid, { signal: new AbortController().signal })) {
          }
        })(),
      ).rejects.toThrow();
      expect(bodies).toHaveLength(1);
    });
