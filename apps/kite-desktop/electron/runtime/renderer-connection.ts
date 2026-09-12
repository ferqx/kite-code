import { Buffer } from 'node:buffer';
import { AsyncMutex } from '../async-mutex';
import { MAX_FRAME_BYTES } from './service-process';

const INITIALIZE_ID = 'desktop-native-initialize';
const UNSUBSCRIBE_ID = 'desktop-native-unsubscribe';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RequestIdentity = { generation: number; id: Json };

interface Attachment {
  generation: number;
  initialized?: Record<string, Json>;
  initializing: boolean;
  initializeWaiter?: RequestIdentity;
  reply?: string;
  subscriptions: Set<string>;
}

export interface ServiceProcessCarrier {
  readonly finished: boolean;
  send(frame: string): Promise<void>;
  receive(signal?: AbortSignal): Promise<string>;
  waitForReceiver(): Promise<void>;
  close(): Promise<void>;
}

/** One protocol peer survives renderer reloads while its paired Service remains alive. */
export class RendererConnection {
  readonly serverVersion: string;
  readonly #service: ServiceProcessCarrier;
  readonly #lock = new AsyncMutex();
  readonly #state: Attachment = {
    generation: 0,
    initializing: false,
    subscriptions: new Set(),
  };
  #version = 0;
  readonly #changes = new Set<() => void>();

  constructor(service: ServiceProcessCarrier, serverVersion: string) {
    this.#service = service;
    this.serverVersion = serverVersion;
  }

  get finished(): boolean {
    return this.#service.finished;
  }

  async attach(generation: number): Promise<void> {
    const subscriptions = await this.#lock.run(() => {
      this.#state.generation = generation;
      this.#state.reply = undefined;
      this.#state.initializeWaiter = undefined;
      const current = [...this.#state.subscriptions];
      this.#state.subscriptions.clear();
      this.#notify();
      return current;
    });
    await this.#service.waitForReceiver();
    for (const subscription of subscriptions) await this.#unsubscribe(subscription);
  }

  async send(generation: number, frame: string): Promise<void> {
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('消息超过大小限制。');
    let message: Record<string, Json>;
    try {
      const value = JSON.parse(frame) as unknown;
      if (!isJsonRecord(value)) throw new Error();
      message = value;
    } catch {
      throw new Error('无效的协议消息。');
    }
    const outbound = await this.#lock.run(() => {
      this.#check(generation);
      if (!Object.hasOwn(message, 'id')) throw new Error('协议请求缺少身份。');
      const id = message.id as Json;
      if (message.method === 'initialize') {
        if (this.#state.initialized) {
          const params = isJsonRecord(message.params) ? message.params : undefined;
          if (params?.protocolVersion !== this.#state.initialized.protocolVersion)
            throw new Error('页面与运行中的服务协议版本不一致。');
          this.#state.reply = JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: this.#state.initialized,
          });
          this.#notify();
          return undefined;
        }
        this.#state.initializeWaiter = { generation, id };
        if (this.#state.initializing) return undefined;
        this.#state.initializing = true;
        message.id = INITIALIZE_ID;
      } else {
        if (message.method === 'runtime/unsubscribe' && isJsonRecord(message.params)) {
          const subscription = message.params.subscriptionId;
          if (typeof subscription === 'string') this.#state.subscriptions.delete(subscription);
        }
        message.id = JSON.stringify([generation, id]);
      }
      return JSON.stringify(message);
    });
    if (outbound !== undefined) await this.#service.send(outbound);
  }

  async receive(generation: number): Promise<string> {
    for (;;) {
      const prepared = await this.#lock.run(() => {
        this.#check(generation);
        if (this.#state.reply !== undefined) {
          const reply = this.#state.reply;
          this.#state.reply = undefined;
          return { reply };
        }
        return { version: this.#version };
      });
      if (prepared.reply !== undefined) return prepared.reply;

      const controller = new AbortController();
      const changed = this.#waitForChange(prepared.version);
      const outcome = await Promise.race([
        this.#service.receive(controller.signal).then(
          (frame) => ({ kind: 'frame' as const, frame }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        changed.promise.then(() => ({ kind: 'changed' as const })),
      ]);
      changed.cancel();
      if (outcome.kind === 'changed') {
        controller.abort();
        await this.#service.waitForReceiver();
        continue;
      }
      controller.abort();
      if (outcome.kind === 'error') throw asError(outcome.error);

      let message: Record<string, Json>;
      try {
        const value = JSON.parse(outcome.frame) as unknown;
        if (!isJsonRecord(value)) throw new Error();
        message = value;
      } catch {
        throw new Error('无效的服务消息。');
      }
      const action = await this.#lock.run(() => this.#accept(generation, message));
      if (action.unsubscribe !== undefined) {
        await this.#unsubscribe(action.unsubscribe);
        continue;
      }
      if (action.retry) continue;
      if (action.error) throw new Error(action.error);
      if (action.frame !== undefined) return action.frame;
    }
  }

  close(): Promise<void> {
    return this.#service.close();
  }

  #accept(
    generation: number,
    message: Record<string, Json>,
  ): { retry?: true; unsubscribe?: string; error?: string; frame?: string } {
    if (message.id === INITIALIZE_ID) {
      this.#state.initializing = false;
      if (isJsonRecord(message.result)) this.#state.initialized = message.result;
      const waiter = this.#state.initializeWaiter;
      this.#state.initializeWaiter = undefined;
      if (waiter && waiter.generation === this.#state.generation) {
        message.id = waiter.id;
        this.#state.reply = JSON.stringify(message);
        this.#notify();
      }
      return { retry: true };
    }

    if (typeof message.id === 'string') {
      const identity = parseIdentity(message.id);
      const subscription = isJsonRecord(message.result) ? message.result.subscriptionId : undefined;
      if (typeof subscription === 'string') {
        if (identity?.generation === this.#state.generation)
          this.#state.subscriptions.add(subscription);
        else return { unsubscribe: subscription };
      }
      if (!identity) return { retry: true };
      if (identity.generation !== this.#state.generation) return { retry: true };
      message.id = identity.id;
    } else if (message.method === 'runtime/subscription') {
      const subscription = isJsonRecord(message.params) ? message.params.subscriptionId : undefined;
      if (typeof subscription !== 'string' || !this.#state.subscriptions.has(subscription))
        return { retry: true };
    }

    const frame = JSON.stringify(message);
    if (this.#state.generation !== generation) {
      this.#state.reply = frame;
      this.#notify();
      return { error: '页面连接已被替换。' };
    }
    return { frame };
  }

  async #unsubscribe(subscriptionId: string): Promise<void> {
    await this.#service.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: UNSUBSCRIBE_ID,
        method: 'runtime/unsubscribe',
        params: { subscriptionId },
      }),
    );
  }

  #check(generation: number): void {
    if (this.#state.generation !== generation) throw new Error('页面连接已被替换。');
  }

  #notify(): void {
    this.#version += 1;
    for (const resolve of [...this.#changes]) resolve();
  }

  #waitForChange(version: number): { promise: Promise<void>; cancel: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    if (this.#version !== version) {
      resolve();
      return { promise, cancel: () => undefined };
    }
    this.#changes.add(resolve);
    return { promise, cancel: () => this.#changes.delete(resolve) };
  }
}

function parseIdentity(value: string): RequestIdentity | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      parsed[0] < 0 ||
      !isJson(parsed[1])
    )
      return undefined;
    return { generation: parsed[0], id: parsed[1] };
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, Json> {
  return isJson(value) && typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJson);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('连接已关闭。');
}
