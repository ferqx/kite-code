import { expect, test } from 'bun:test';
import type {
  NativeProcessObservation,
  NativeProcessResources,
} from '../../../scripts/runtime/unified-soak-native';
import {
  type PairedServiceResources,
  verifyPairedServiceResources,
} from '../../../scripts/runtime/unified-soak-service-resources';

function packet(version: 1 | 2): PairedServiceResources {
  const ownerPid = 50;
  const services = [60, 61].map((pid, index) => {
    const spawn: NativeProcessObservation = {
      collector: version === 1 ? 'darwin-libproc' : 'linux-procfs',
      pid,
      parentPid: ownerPid,
      startIdentity: {
        kind: version === 1 ? 'darwin-start-time' : 'linux-boot-start-ticks',
        value: version === 1 ? `${pid}:123` : `12345678-1234-1234-1234-123456789abc:${pid}`,
      },
      fileDescriptors: 4,
      unavailable: [],
    };
    const sample = (observedAt: number): NativeProcessResources => ({
      version,
      pid,
      observedAt,
      before: structuredClone(spawn),
      after: structuredClone(spawn),
      rssBytes: 1024,
      fileDescriptors: 4,
      activeResources: null,
      handles: null,
      unsupported: ['activeResources', 'handles'],
      unavailable: [],
    });
    return {
      instanceId: `service-${index}`,
      pid,
      spawn,
      ready: sample(100),
      preclose: sample(200),
      exit: {
        exitCode: 0,
        originalExited: true as const,
        reaped: true,
        kernelState: 'absent' as const,
      },
    };
  });
  return {
    version,
    coverage: 'paired-services-only',
    storeId: 'original-store',
    candidateDigest: 'a'.repeat(64),
    ownerPid,
    services,
    cold: {
      storeId: 'original-store',
      cursor: '123',
      unchanged: true,
      providerCallsBefore: 2,
      providerCallsAfter: 2,
    },
  };
}
const expected = {
  storeId: 'original-store',
  candidateDigest: 'a'.repeat(64),
  instanceIds: ['service-0', 'service-1'],
  coldRead: true,
};

test('paired boundary versions preserve Mac v1 and independently require Linux v2 original identities and complete exits', () => {
  expect(verifyPairedServiceResources(packet(1), expected)).toEqual([]);
  expect(verifyPairedServiceResources(packet(2), { ...expected, platform: 'linux' })).toEqual([]);
  expect(verifyPairedServiceResources(packet(2), expected)).toContain(
    'continuous_service_resources_unqualified',
  );
  expect(verifyPairedServiceResources(packet(1), { ...expected, platform: 'linux' })).toContain(
    'continuous_service_resources_unqualified',
  );
  expect(verifyPairedServiceResources(packet(2), { ...expected, platform: 'win32' })).toContain(
    'continuous_service_resources_unqualified',
  );
  const reject = (change: (value: PairedServiceResources) => void) => {
    const value = packet(2);
    change(value);
    expect(verifyPairedServiceResources(value, { ...expected, platform: 'linux' })).toContain(
      'continuous_service_resources_unqualified',
    );
  };
  reject((value) => {
    value.services[0]!.ready.rssBytes = null;
  });
  reject((value) => {
    value.services[0]!.ready.after.startIdentity!.value += '1';
  });
  reject((value) => {
    value.services[0]!.spawn!.parentPid = 99;
  });
  reject((value) => {
    value.services[0]!.preclose!.observedAt = 99;
  });
  reject((value) => {
    value.services[0]!.exit!.kernelState = 'alive';
  });
  reject((value) => {
    value.services[0]!.exit!.reaped = false;
  });
  reject((value) => {
    value.cold!.providerCallsAfter++;
  });
  reject((value) => {
    Object.assign(value.services[0]!.ready, { unknown: true });
  });
});
