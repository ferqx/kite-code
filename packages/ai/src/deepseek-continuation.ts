import type { Json, ModelMessage, ModelRequest, ModelToolCall } from './index';

const format = 'deepseek-chat-reasoning-v1';
const encoder = new TextEncoder();
// No partial provider history. This bound is checked before encoding and again after encryption.
const maxBytes = 4 * 1024 * 1024;
const maxEncoded = 4 * Math.ceil((maxBytes + 16) / 3);

function encode64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function decode64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function anchor(
  route: string,
  execution: string,
  content: string,
  calls: readonly ModelToolCall[],
) {
  // Recorded tool projections can reserialize or reorder object properties. Array order is significant.
  const projection = calls.map(({ id, name, arguments: args }) => {
    try {
      const normalized = JSON.stringify(JSON.parse(args), (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            )
          : value,
      );
      return [id, name, 'json', normalized];
    } catch {
      return [id, name, 'invalid', args];
    }
  });
  return encoder.encode(JSON.stringify([format, route, execution, content, projection]));
}

export class DeepSeekHistory {
  private readonly material: Promise<{ key: CryptoKey; binding: string }>;

  constructor(endpoint: string, model: string, account: string | undefined, apiKey: string) {
    this.material = (async () => {
      const seed = await crypto.subtle.importKey('raw', encoder.encode(apiKey), 'HKDF', false, [
        'deriveBits',
      ]);
      const bits = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode(format),
            info: encoder.encode(
              JSON.stringify(['deepseek', 'chat-completions', endpoint, model, account ?? null]),
            ),
          },
          seed,
          512,
        ),
      );
      return {
        key: await crypto.subtle.importKey('raw', bits.subarray(0, 32), 'AES-GCM', false, [
          'encrypt',
          'decrypt',
        ]),
        binding: encode64(bits.subarray(32)),
      };
    })();
  }

  async binding() {
    return (await this.material).binding;
  }

  async seal(
    route: string,
    execution: string,
    content: string,
    calls: readonly ModelToolCall[],
    reasoning: string,
  ): Promise<Json> {
    const bytes = encoder.encode(JSON.stringify(reasoning));
    if (bytes.length > maxBytes) throw new Error('model_continuation_limit');
    const { key, binding } = await this.material;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: anchor(route, execution, content, calls),
      },
      key,
      bytes,
    );
    return { format, binding, route, iv: encode64(iv), sealed: encode64(new Uint8Array(sealed)) };
  }

  async restore(request: ModelRequest): Promise<Map<ModelMessage, string>> {
    const result = new Map<ModelMessage, string>();
    if (!request.tools.length || !request.messages.some((m) => m.continuation !== undefined))
      return result;
    const { key, binding } = await this.material;
    const sources = new Set<string>(),
      callIds = new Set<string>(),
      resultIds = new Set<string>();
    const repeatedSources = new Set<string>(),
      repeatedCalls = new Set<string>(),
      repeatedResults = new Set<string>();
    function remember(value: string, seen: Set<string>, duplicates: Set<string>) {
      if (seen.has(value)) duplicates.add(value);
      seen.add(value);
    }
    for (const msg of request.messages) {
      if (msg.role === 'tool' && msg.toolCallId)
        remember(msg.toolCallId, resultIds, repeatedResults);
      if (msg.role !== 'assistant') continue;
      for (const id of msg.sourceIds ?? []) remember(id, sources, repeatedSources);
      for (const call of msg.toolCalls ?? []) remember(call.id, callIds, repeatedCalls);
    }
    for (const [index, msg] of request.messages.entries()) {
      const value = msg.continuation;
      if (
        msg.role !== 'assistant' ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.format !== format ||
        value.binding !== binding ||
        value.route !== request.modelId ||
        typeof value.iv !== 'string' ||
        value.iv.length !== 16 ||
        typeof value.sealed !== 'string' ||
        value.sealed.length > maxEncoded ||
        msg.sourceIds?.length !== 1
      )
        continue;
      const source = msg.sourceIds[0]!;
      const calls = msg.toolCalls ?? [];
      if (
        !source ||
        repeatedSources.has(source) ||
        calls.some((c) => repeatedCalls.has(c.id) || repeatedResults.has(c.id))
      )
        continue;
      const expected = new Set(calls.map((c) => c.id));
      for (
        let position = index + 1;
        position < request.messages.length && expected.size;
        position++
      ) {
        const reply = request.messages[position]!;
        if (reply.role !== 'tool' || !reply.toolCallId || !expected.delete(reply.toolCallId)) break;
      }
      if (expected.size) continue;
      try {
        const bytes = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: decode64(value.iv),
            additionalData: anchor(request.modelId, source, msg.content, calls),
          },
          key,
          decode64(value.sealed),
        );
        const text: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (typeof text === 'string' && text.length) result.set(msg, text);
      } catch {
        // Corrupt or reattributed evidence cannot supply private wire history.
      }
    }
    return result;
  }
}

export class DeepSeekReasoning {
  private value = '';
  observe(chunk: unknown) {
    const choices = (
      chunk as { choices?: { index?: unknown; delta?: { reasoning_content?: unknown } }[] } | null
    )?.choices;
    if (!Array.isArray(choices) || choices.length !== 1 || choices[0]?.index !== 0) return;
    const text = choices[0]?.delta?.reasoning_content;
    if (typeof text === 'string' && text.length) {
      if (this.value.length + text.length > maxBytes) throw new Error('model_continuation_limit');
      this.value += text;
    }
  }
  get text() {
    return this.value;
  }
}
