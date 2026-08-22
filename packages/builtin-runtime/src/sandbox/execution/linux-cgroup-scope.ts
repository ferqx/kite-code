import {
  type CgroupPidsScopeIdentityV1,
  isCgroupPidsExecutablePathV1,
  isCgroupPidsPathV1,
  isCgroupPidsUnitNameV1,
} from '../cgroup-pids-contract';

export const LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_V1 =
  'kite.linux-cgroup-scope-candidate.v1' as const;

/** Candidate-only identity facts; still require native readback before production use. */
export interface LinuxCgroupScopeCandidateV1 {
  readonly schema: typeof LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_V1;
  readonly unitName: string;
  readonly runnerExecutable: string;
  readonly systemctlExecutable: string;
  readonly cgroupPath: string;
}

/**
 * Parse the private candidate authority without treating it as a production
 * dispatch capability. The current Runtime lifecycle deliberately never
 * consumes this result before a future durable scope-ack field exists.
 */
export function parseLinuxCgroupScopeIdentityV1(input: {
  readonly argv: readonly string[];
  readonly candidate: unknown;
}): { readonly scope?: CgroupPidsScopeIdentityV1; readonly invalid: boolean } {
  if (!isRecord(input.candidate)) return { invalid: true };
  const keys = Object.keys(input.candidate).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== 'cgroupPath' ||
    keys[1] !== 'runnerExecutable' ||
    keys[2] !== 'schema' ||
    keys[3] !== 'systemctlExecutable' ||
    keys[4] !== 'unitName' ||
    input.candidate.schema !== LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_V1
  ) {
    return { invalid: true };
  }
  const { unitName, runnerExecutable, systemctlExecutable, cgroupPath } = input.candidate;
  if (
    !isCgroupPidsUnitNameV1(unitName) ||
    !isCgroupPidsExecutablePathV1(runnerExecutable) ||
    !isCgroupPidsExecutablePathV1(systemctlExecutable) ||
    !isCgroupPidsPathV1(cgroupPath, unitName) ||
    input.argv[0] !== runnerExecutable ||
    cgroupPidsUnitFromArgvV1(input.argv) !== unitName
  ) {
    return { invalid: true };
  }
  return {
    invalid: false,
    scope: { unitName, runnerExecutable, systemctlExecutable, cgroupPath },
  };
}

/** Extract the Runtime-owned unit from a sealed argv; arbitrary unit names are rejected. */
export function cgroupPidsUnitFromArgvV1(argv: readonly string[]): string | undefined {
  if (
    argv.length < 12 ||
    !isCgroupPidsExecutablePathV1(argv[0]) ||
    argv[1] !== '--user' ||
    argv[2] !== '--scope' ||
    argv[3] !== '--quiet' ||
    argv[4] !== '--collect' ||
    argv[5] !== '--slice-inherit' ||
    argv[6] !== '--expand-environment=no' ||
    argv[7] !== '--property=TasksAccounting=yes' ||
    argv[10] !== '--' ||
    argv
      .slice(11)
      .some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'))
  ) {
    return undefined;
  }
  const maxTasks = argv[8]?.slice('--property=TasksMax='.length);
  const unitName = argv[9]?.slice('--unit='.length);
  if (
    !argv[8]?.startsWith('--property=TasksMax=') ||
    !maxTasks ||
    !/^[1-9][0-9]*$/.test(maxTasks) ||
    !Number.isSafeInteger(Number(maxTasks)) ||
    !argv[9]?.startsWith('--unit=') ||
    !isCgroupPidsUnitNameV1(unitName)
  ) {
    return undefined;
  }
  return unitName;
}

/** Pure argv contract for a future consumer-owned exact-unit kill-all. */
export function buildCgroupPidsKillInvocationV1(input: {
  readonly scope: Readonly<CgroupPidsScopeIdentityV1>;
}): string[] {
  if (
    !isCgroupPidsUnitNameV1(input.scope.unitName) ||
    !isCgroupPidsExecutablePathV1(input.scope.runnerExecutable) ||
    !isCgroupPidsExecutablePathV1(input.scope.systemctlExecutable) ||
    !isCgroupPidsPathV1(input.scope.cgroupPath, input.scope.unitName)
  ) {
    throw new Error('cgroup pids cleanup authority is invalid.');
  }
  return [
    input.scope.systemctlExecutable,
    '--user',
    '--no-ask-password',
    '--quiet',
    'kill',
    '--kill-who=all',
    '--signal=SIGKILL',
    input.scope.unitName,
  ];
}

/** Parse a cgroup-v2 events file; missing/invalid evidence stays unsupported. */
export function parseCgroupPidsPopulatedV1(contents: string): boolean | undefined {
  if (contents === '') return undefined;
  const normalized = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = normalized.split('\n');
  if (lines.some((line) => !/^[a-z_]+ [0-9]+$/.test(line))) return undefined;
  const populated = lines.filter((line) => line.startsWith('populated '));
  const populatedLine = populated.at(0);
  if (populated.length !== 1 || populatedLine === undefined) return undefined;
  const value = populatedLine.slice('populated '.length);
  return value === '0' ? false : value === '1' ? true : undefined;
}

/** Parse cgroup.procs as an exact empty/non-empty fact. */
export function parseCgroupPidsEmptyV1(contents: string): boolean | undefined {
  if (contents === '') return true;
  if (!/^[1-9][0-9]*(?:\n[1-9][0-9]*)*\n?$/.test(contents)) return undefined;
  return false;
}

export { isCgroupPidsPathV1, isCgroupPidsUnitNameV1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
