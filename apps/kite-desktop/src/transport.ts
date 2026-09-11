import type { RuntimeClientConnection, RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_PROTOCOL_LIMITS,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import { invoke } from '@tauri-apps/api/core';

export interface DesktopConnectionInfo {
  connectionId: number;
  workspace: string;
  expectedServerVersion: string;
}

export type DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Pull one bounded frame per IPC call: no UI timers or unbounded event queue. */
export function desktopTransport(
  info: DesktopConnectionInfo,
  call: DesktopInvoke = invoke,
): RuntimeClientTransport {
  let used = false;
  return {
    async connect(): Promise<RuntimeClientConnection> {
      if (used) throw new Error('请关闭旧连接，再明确重新连接项目。');
      used = true;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      let writeTail = Promise.resolve();
      const close = () => {
        closed = true;
        closePromise ??= call<void>('runtime_detach', { connectionId: info.connectionId });
        return closePromise;
      };
      return {
        send(message) {
          if (closed) return Promise.reject(new Error('连接已关闭。'));
          const decoded = safeDecodeRuntimeProtocolMessage(message);
          if (!decoded.success) return Promise.reject(new Error('无效的 Runtime 消息。'));
          const frame = JSON.stringify(decoded.data);
          if (new TextEncoder().encode(frame).byteLength > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes)
            return Promise.reject(new Error('消息超过大小限制。'));
          const sending = writeTail.then(async () => {
            if (closed) throw new Error('连接已关闭。');
            await call<void>('runtime_send', { connectionId: info.connectionId, frame });
          });
          writeTail = sending.catch(() => {
            void close().catch(() => undefined);
          });
          return sending;
        },
        async *messages() {
          try {
            while (!closed) {
              const frame = await call<string>('runtime_receive', {
                connectionId: info.connectionId,
              });
              if (closed) return;
              if (
                new TextEncoder().encode(frame).byteLength > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes
              )
                throw new Error('服务消息超过大小限制。');
              const decoded = safeDecodeRuntimeProtocolMessage(JSON.parse(frame));
              if (!decoded.success) throw new Error('服务返回无效的 Runtime 消息。');
              yield decoded.data;
            }
          } finally {
            await close();
          }
        },
        close,
      };
    },
  };
}
