import type { NativeProcessObservation, NativeProcessResources } from './unified-soak-native';
import { sameNativeProcess } from './unified-soak-native';

/** Boundary evidence only; never substitutes the original nine-point resource qualification. */
export interface PairedServiceResources {
  version: 1;
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
function native(value: NativeProcessObservation) {
  return (
    keys(value, [
      'collector',
      'pid',
      'parentPid',
      'startIdentity',
      'fileDescriptors',
      'unavailable',
    ]) &&
    value.collector === 'darwin-libproc' &&
    integer(value.pid) &&
    value.pid > 0 &&
    integer(value.parentPid) &&
    integer(value.fileDescriptors) &&
    keys(value.startIdentity, ['kind', 'value']) &&
    value.startIdentity?.kind === 'darwin-start-time' &&
    /^[1-9][0-9]*:(?:0|[1-9][0-9]{0,5})$/.test(value.startIdentity.value) &&
    Array.isArray(value.unavailable) &&
    value.unavailable.length === 0
  );
}
function sample(value: NativeProcessResources, pid: number, ownerPid: number) {
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
    value.version === 1 &&
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
    native(value.before) &&
    native(value.after) &&
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
  },
): string[] {
  try {
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
      value.version !== 1 ||
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
          !native(row.spawn) ||
          row.spawn.parentPid !== value.ownerPid ||
          !sameNativeProcess(row.spawn, row.ready.before) ||
          !sample(row.ready, row.pid, value.ownerPid) ||
          !row.preclose ||
          !sample(row.preclose, row.pid, value.ownerPid) ||
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
