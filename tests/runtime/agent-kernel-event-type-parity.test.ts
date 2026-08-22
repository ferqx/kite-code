import { describe, expect, test } from 'bun:test';
import type {
  RuntimeEvent as CoreRuntimeEvent,
  KernelEvent as PackageKernelEvent,
} from '@kite/agent-kernel';

type Assert<T extends true> = T;
type CoreToPackage = Assert<CoreRuntimeEvent extends PackageKernelEvent ? true : false>;
type PackageToCore = Assert<PackageKernelEvent extends CoreRuntimeEvent ? true : false>;

function acceptPackageEvent(event: PackageKernelEvent): PackageKernelEvent {
  return event;
}

acceptPackageEvent({ type: 'turn.started', turnId: 'turn-1' });
// @ts-expect-error State25 rejects a non-string required field.
acceptPackageEvent({ type: 'turn.started', turnId: 42 });
// @ts-expect-error State25 rejects an unknown discriminant.
acceptPackageEvent({ type: 'turn.not-a-real-event', turnId: 'turn-1' });
acceptPackageEvent({
  type: 'tool.finished',
  toolCallId: 'tool-1',
  name: 'shell_execute',
  // @ts-expect-error State25 rejects the wrong nested result type.
  result: { ok: true, command: 'echo ok', exitCode: '0', stdout: '', stderr: '' },
});

const parity: [CoreToPackage, PackageToCore] = [true, true];

describe('State25 package event type parity', () => {
  test('keeps the root and package unions bidirectionally assignable', () => {
    expect(parity).toEqual([true, true]);
  });
});
