export interface LoopbackMcpRequest {
  method: string;
  params: Record<string, unknown>;
}

type Source = 'alpha' | 'beta';

interface ToolResponse {
  source: Source;
  tool: string;
  httpStatus: number;
  rpcErrorCode: number | null;
  isToolError: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(source: Source, request: LoopbackMcpRequest) {
  const { method, params } = request;
  const args = params.arguments;
  const uri = `smoke://${source}/note`;
  const invalid = { error: { code: -32602, message: 'Invalid params' } };
  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: `smoke-${source}`, version: '1.0.0' },
          capabilities: { tools: {}, resources: {}, prompts: {} },
        },
      };
    case 'tools/list': {
      const noInput = { type: 'object', properties: {}, additionalProperties: false };
      const tools = [
        {
          name: 'echo',
          description: 'Echo a text value.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { source: { type: 'string', enum: [source] }, text: { type: 'string' } },
            required: ['source', 'text'],
            additionalProperties: false,
          },
        },
        { name: 'reject', description: 'Return a tool error.', inputSchema: noInput },
      ];
      if (source === 'alpha')
        tools.push({
          name: 'rpc_error',
          description: 'Return a protocol error.',
          inputSchema: noInput,
        });
      return { result: { tools } };
    }
    case 'tools/call':
      if (params.name === 'echo' && object(args) && typeof args.text === 'string')
        return {
          result: {
            content: [{ type: 'text', text: `${source}:${args.text}` }],
            structuredContent: { source, text: args.text },
          },
        };
      if (params.name === 'reject')
        return {
          result: { isError: true, content: [{ type: 'text', text: `${source}:rejected` }] },
        };
      if (source === 'alpha' && params.name === 'rpc_error')
        return { error: { code: -32603, message: 'alpha:rpc_error' } };
      return invalid;
    case 'resources/list':
      return { result: { resources: [{ uri, name: 'note', mimeType: 'text/plain' }] } };
    case 'resources/read':
      if (params.uri !== uri) return invalid;
      return { result: { contents: [{ uri, mimeType: 'text/plain', text: `${source}:note` }] } };
    case 'prompts/list':
      return {
        result: { prompts: [{ name: 'greeting', arguments: [{ name: 'name', required: true }] }] },
      };
    case 'prompts/get':
      if (params.name !== 'greeting' || !object(args) || typeof args.name !== 'string')
        return invalid;
      return {
        result: {
          messages: [
            { role: 'user', content: { type: 'text', text: `${source}:hello ${args.name}` } },
          ],
        },
      };
    default:
      return { error: { code: -32601, message: 'Method not found' } };
  }
}

/** Two independently addressed stateless MCP sources sharing an owned loopback listener. */
export function openLoopbackMcpSmoke() {
  const requests: Record<Source, LoopbackMcpRequest[]> = { alpha: [], beta: [] };
  const toolResponses: ToolResponse[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== '/alpha' && path !== '/beta') return new Response(null, { status: 404 });
      if (request.method !== 'POST')
        return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      const source = path === '/alpha' ? 'alpha' : 'beta';
      const rpc: unknown = await request.json().catch(() => null);
      if (!object(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
        return Response.json(
          { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
          { status: 400 },
        );
      const observed = { method: rpc.method, params: object(rpc.params) ? rpc.params : {} };
      requests[source].push(observed);
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      const response = Response.json({ jsonrpc: '2.0', id: rpc.id, ...result(source, observed) });
      if (observed.method === 'tools/call') {
        const reply: unknown = await response.clone().json();
        if (
          typeof observed.params.name !== 'string' ||
          !object(reply) ||
          reply.jsonrpc !== '2.0' ||
          reply.id !== rpc.id ||
          object(reply.result) === object(reply.error) ||
          (object(reply.error) && typeof reply.error.code !== 'number')
        )
          throw Error('invalid_loopback_mcp_tool_reply');
        toolResponses.push({
          source,
          tool: observed.params.name,
          httpStatus: response.status,
          rpcErrorCode: object(reply.error) ? Number(reply.error.code) : null,
          isToolError: object(reply.result) && reply.result.isError === true,
        });
      }
      return response;
    },
  });
  return {
    urls: { alpha: new URL('/alpha', server.url).href, beta: new URL('/beta', server.url).href },
    requests,
    toolResponses,
    async close() {
      await server.stop(true);
    },
  };
}
