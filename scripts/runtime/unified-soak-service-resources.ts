import type { NativeProcessObservation, NativeProcessResources } from './unified-soak-native';
import { sameNativeProcess } from './unified-soak-native';

/** Boundary evidence only; never substitutes the original nine-point resource qualification. */
export interface PairedServiceResources {
  version: 1 | 2;
  coverage: 'paired-services-only';
  storeId: string;
  candidateDigest: string;
  ownerPid: number;
  services: {
    instanceId: string;
    pid: number;
    spawn: NativeProcessObservation | null;
    ready: NativeProcessResources;
    preclose: NativeProcessResources | null;
    exit: {
      exitCode: number;
      originalExited: true;
      reaped: boolean;
      kernelState: 'absent' | 'reused' | 'alive' | 'unavailable';
    } | null;
  }[];
  cold: {
    storeId: string;
    cursor: string;
    unchanged: true;
    providerCallsBefore: number;
    providerCallsAfter: number;
  } | null;
}
const keys = (value: unknown, expected: string[]) =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === expected.sort().join(','),
  );
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function native(value: NativeProcessObservation, version: 1 | 2) {
  return (
    keys(value, [
      'collector',
      'pid',
      'parentPid',
      'startIdentity',
      'fileDescriptors',
      'unavailable',
    ]) &&
    value.collector === (version === 1 ? 'darwin-libproc' : 'linux-procfs') &&
    integer(value.pid) &&
    value.pid > 0 &&
    integer(value.parentPid) &&
    integer(value.fileDescriptors) &&
    keys(value.startIdentity, ['kind', 'value']) &&
    value.startIdentity?.kind ===
      (version === 1 ? 'darwin-start-time' : 'linux-boot-start-ticks') &&
    (version === 1
      ? /^[1-9][0-9]*:(?:0|[1-9][0-9]{0,5})$/
      : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9][0-9]*$/
    ).test(value.startIdentity.value) &&
    Array.isArray(value.unavailable) &&
    value.unavailable.length === 0
  );
}
function sample(value: NativeProcessResources, pid: number, ownerPid: number, version: 1 | 2) {
  return (
    keys(value, [
      'version',
      'pid',
      'observedAt',
      'before',
      'after',
      'rssBytes',
      'fileDescriptors',
      'activeResources',
      'handles',
      'unsupported',
      'unavailable',
    ]) &&
    value.version === version &&
    value.pid === pid &&
    integer(value.observedAt) &&
    value.observedAt > 0 &&
    integer(value.rssBytes) &&
    integer(value.fileDescriptors) &&
    value.activeResources === null &&
    value.handles === null &&
    Array.isArray(value.unsupported) &&
    value.unsupported.join(',') === 'activeResources,handles' &&
    Array.isArray(value.unavailable) &&
    value.unavailable.length === 0 &&
    native(value.before, version) &&
    native(value.after, version) &&
    value.before.pid === pid &&
    value.after.pid === pid &&
    value.before.parentPid === ownerPid &&
    value.after.parentPid === ownerPid &&
    value.after.fileDescriptors === value.fileDescriptors &&
    sameNativeProcess(value.before, value.after)
  );
}
/** Strict when present. Legacy v1/v2 absence retains all original verification. */
export function verifyPairedServiceResources(
  value: PairedServiceResources,
  expected: {
    storeId: string;
    candidateDigest: string;
    instanceIds: string[];
    coldRead: boolean;
    platform?: string;
  },
): string[] {
  try {
    const version = expected.platform === 'linux' ? 2 : 1;
    if (
      !keys(value, [
        'version',
        'coverage',
        'storeId',
        'candidateDigest',
        'ownerPid',
        'services',
        'cold',
      ]) ||
      value.version !== version ||
      !['darwin', 'linux'].includes(expected.platform ?? 'darwin') ||
      value.coverage !== 'paired-services-only' ||
      value.storeId !== expected.storeId ||
      value.candidateDigest !== expected.candidateDigest ||
      !integer(value.ownerPid) ||
      value.ownerPid < 1 ||
      !Array.isArray(value.services) ||
      value.services.length !== 2 ||
      new Set(value.services.map((row) => row.pid)).size !== 2 ||
      value.services.some(
        (row, index) =>
          !keys(row, ['instanceId', 'pid', 'spawn', 'ready', 'preclose', 'exit']) ||
          row.instanceId !== expected.instanceIds[index] ||
          !integer(row.pid) ||
          row.pid < 1 ||
          !row.spawn ||
          !native(row.spawn, version) ||
          row.spawn.parentPid !== value.ownerPid ||
          !sameNativeProcess(row.spawn, row.ready.before) ||
          !sample(row.ready, row.pid, value.ownerPid, version) ||
          !row.preclose ||
          !sample(row.preclose, row.pid, value.ownerPid, version) ||
          !sameNativeProcess(row.ready.before, row.preclose.after) ||
          row.preclose.observedAt < row.ready.observedAt ||
          !keys(row.exit, ['exitCode', 'originalExited', 'reaped', 'kernelState']) ||
          row.exit?.exitCode !== 0 ||
          row.exit.originalExited !== true ||
          row.exit.reaped !== true ||
          !['absent', 'reused'].includes(row.exit.kernelState),
      ) ||
      !keys(value.cold, [
        'storeId',
        'cursor',
        'unchanged',
        'providerCallsBefore',
        'providerCallsAfter',
      ]) ||
      value.cold?.storeId !== expected.storeId ||
      !/^(0|[1-9][0-9]*)$/.test(value.cold.cursor) ||
      value.cold.unchanged !== true ||
      !integer(value.cold.providerCallsBefore) ||
      value.cold.providerCallsAfter !== value.cold.providerCallsBefore ||
      !expected.coldRead
    )
      return ['continuous_service_resources_unqualified'];
    return [];
  } catch {
    return ['continuous_service_resources_structure_invalid'];
  }
}
