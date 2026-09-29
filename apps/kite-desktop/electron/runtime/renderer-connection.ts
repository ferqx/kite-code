import { Buffer } from 'node:buffer';
import { RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_ } from '@kite-ai/runtime-protocol';
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
  pendingSubscriptions: Set<string>;
  cancelledSubscriptions: Set<string>;
  subscriptionRequests: Map<string, string>;
  cancellationRequests: Map<string, string>;
}

export interface ServiceProcessCarrier {
  readonly finished: boolean;
  send(frame: string): Promise<void>;
  receive(signal?: AbortSignal): Promise<string>;
  waitForReceiver(): Promise<void>;
  close(): Promise<void>;
  forceTerminate?(): void;
  markInitialized?(): void;
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
    pendingSubscriptions: new Set(),
    cancelledSubscriptions: new Set(),
    subscriptionRequests: new Map(),
    cancellationRequests: new Map(),
  };
  #nextNativeRequest = 0;
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
    const { subscriptions, pendingSubscriptions } = await this.#lock.run(() => {
      this.#state.generation = generation;
      this.#state.reply = undefined;
      this.#state.initializeWaiter = undefined;
      const current = [...this.#state.subscriptions];
      const pending = [...this.#state.pendingSubscriptions];
      this.#state.subscriptions.clear();
      this.#state.pendingSubscriptions.clear();
      this.#state.cancelledSubscriptions.clear();
      this.#state.subscriptionRequests.clear();
      this.#state.cancellationRequests.clear();
      this.#notify();
      return { subscriptions: current, pendingSubscriptions: pending };
    });
    await this.#service.waitForReceiver();
    for (const subscription of subscriptions) await this.#unsubscribe(subscription);
    for (const requestId of pendingSubscriptions) await this.#cancelSubscriptionRequest(requestId);
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
      if (message.method === 'history/cancel' && !Object.hasOwn(message, 'id')) {
        if (!RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_.safeParse(message).success)
          throw new Error('无效的协议消息。');
        const params = message.params as { requestId: string };
        params.requestId = JSON.stringify([generation, params.requestId]);
        return JSON.stringify(message);
      }
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
          if (typeof subscription === 'string') {
            this.#state.subscriptions.delete(subscription);
            this.#state.subscriptionRequests.delete(subscription);
          }
          const subscribeRequestId = message.params.subscribeRequestId;
          if (typeof subscribeRequestId === 'string') {
            const wireRequestId = JSON.stringify([generation, subscribeRequestId]);
            message.params.subscribeRequestId = wireRequestId;
            this.#state.cancellationRequests.set(JSON.stringify([generation, id]), wireRequestId);
            if (
              this.#state.pendingSubscriptions.has(wireRequestId) ||
              [...this.#state.subscriptionRequests.values()].includes(wireRequestId)
            ) {
              this.#state.cancelledSubscriptions.add(wireRequestId);
              for (const [remoteId, requestId] of this.#state.subscriptionRequests) {
                if (requestId !== wireRequestId) continue;
                this.#state.subscriptionRequests.delete(remoteId);
                this.#state.subscriptions.delete(remoteId);
              }
            }
          }
        }
        message.id = JSON.stringify([generation, id]);
        if (message.method === 'runtime/subscribe')
          this.#state.pendingSubscriptions.add(message.id);
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
      const receiving = this.#service.receive(controller.signal).then(
        (frame) => ({ kind: 'frame' as const, frame }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      let outcome = await Promise.race([
        receiving,
        changed.promise.then(() => ({ kind: 'changed' as const })),
      ]);
      changed.cancel();
      if (outcome.kind === 'changed') {
        controller.abort();
        // Cancellation may race a frame that the Service already handed us.
        // Accept that frame before switching generations: dropping initialize
        // here leaves every later renderer waiting on an in-flight reply that
        // has already been consumed, and dropping a subscribe reply leaks it.
        outcome = await receiving;
        if (outcome.kind === 'error') continue;
      }
      controller.abort();
      if (outcome.kind === 'error') {
        const failure = asError(outcome.error);
        const reply = await this.#lock.run(() => {
          const waiter = this.#state.initializeWaiter;
          if (!waiter || waiter.generation !== generation || this.#state.initialized)
            return undefined;
          this.#state.initializeWaiter = undefined;
          this.#state.initializing = false;
          return JSON.stringify({
            jsonrpc: '2.0',
            id: waiter.id,
            error: {
              code: -32603,
              message: failure.message.slice(0, 256),
              data: { code: 'internal_error', retryable: false },
            },
          });
        });
        if (reply !== undefined) return reply;
        throw failure;
      }

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
      }
      if (action.retry) continue;
      if (action.error) throw new Error(action.error);
      if (action.frame !== undefined) return action.frame;
    }
  }

  close(): Promise<void> {
    return this.#service.close();
  }

  forceTerminate(): void {
    this.#service.forceTerminate?.();
  }

  #accept(
    generation: number,
    message: Record<string, Json>,
  ): { retry?: true; unsubscribe?: string; error?: string; frame?: string } {
    if (message.id === INITIALIZE_ID) {
      this.#state.initializing = false;
      if (isJsonRecord(message.result)) {
        this.#state.initialized = message.result;
        this.#service.markInitialized?.();
      }
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
      const cancelledRequestId = this.#state.cancellationRequests.get(message.id);
      if (cancelledRequestId !== undefined) {
        this.#state.cancellationRequests.delete(message.id);
        if (isJsonRecord(message.result) && message.result.unsubscribed === true) {
          // Server responses share one FIFO outbound queue. A successful
          // cancellation response follows any ACK already queued for the
          // original subscribe, so no late ACK can restore this identity.
          this.#state.pendingSubscriptions.delete(cancelledRequestId);
          this.#state.cancelledSubscriptions.delete(cancelledRequestId);
        }
      }
      const identity = parseIdentity(message.id);
      const subscription = isJsonRecord(message.result) ? message.result.subscriptionId : undefined;
      const wasPending = this.#state.pendingSubscriptions.delete(message.id);
      const wasCancelled = this.#state.cancelledSubscriptions.delete(message.id);
      let unsubscribe: string | undefined;
      if (typeof subscription === 'string') {
        if (identity?.generation === this.#state.generation && !wasCancelled) {
          this.#state.subscriptions.add(subscription);
          if (wasPending) this.#state.subscriptionRequests.set(subscription, message.id);
        } else unsubscribe = subscription;
      }
      if (!identity) return { retry: true };
      if (identity.generation !== this.#state.generation)
        return unsubscribe ? { unsubscribe } : { retry: true };
      message.id = identity.id;
      if (unsubscribe) return { frame: JSON.stringify(message), unsubscribe };
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
        id: `${UNSUBSCRIBE_ID}-${++this.#nextNativeRequest}`,
        method: 'runtime/unsubscribe',
        params: { subscriptionId },
      }),
    );
  }

  async #cancelSubscriptionRequest(subscribeRequestId: string): Promise<void> {
    await this.#service.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: `${UNSUBSCRIBE_ID}-${++this.#nextNativeRequest}`,
        method: 'runtime/unsubscribe',
        params: { subscribeRequestId },
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
