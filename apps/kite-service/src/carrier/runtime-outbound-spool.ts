import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerOutboundSpool } from '@kite-ai/runtime-server';

/** Connection-owned disk backing for reliable frames awaiting logical transport capacity. */
export function createRuntimeOutboundSpool(): RuntimeServerOutboundSpool {
  let directory: string | undefined;
  let closed = false;
  const references = new Set<string>();
  return {
    write(message: RuntimeProtocolMessage): string {
      if (closed) throw new Error('Runtime outbound spool is closed.');
      if (!directory) {
        directory = mkdtempSync(join(tmpdir(), 'kite-runtime-outbound-'));
        chmodSync(directory, 0o700);
      }
      const reference = randomUUID();
      writeFileSync(join(directory, reference), JSON.stringify(message), {
        flag: 'wx',
        mode: 0o600,
      });
      references.add(reference);
      return reference;
    },
    read(reference: string): RuntimeProtocolMessage {
      if (closed || !directory || !references.has(reference)) {
        throw new Error('Runtime outbound spool reference is unavailable.');
      }
      return JSON.parse(readFileSync(join(directory, reference), 'utf8')) as RuntimeProtocolMessage;
    },
    remove(reference: string): void {
      if (!directory || !references.delete(reference)) return;
      rmSync(join(directory, reference), { force: true });
    },
    close(): void {
      if (closed) return;
      closed = true;
      references.clear();
      if (directory) rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    },
  };
}
