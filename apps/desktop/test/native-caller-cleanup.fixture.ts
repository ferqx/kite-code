import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import type { openNativeShellObservation } from './native-shell-observation.fixture';

type Observation = Pick<
  ReturnType<typeof openNativeShellObservation>,
  'observe' | 'present' | 'signal'
>;
export type NativeCallerCleanupRow = { pid: number; parent: number; command: string };
const readRows = (): NativeCallerCleanupRow[] =>
  String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command=']))
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
    });

/** Parent-side fallback for this caller fixture, including a killed Node driver. */
export async function cleanupNativeCaller(
  input: {
    root: string;
    kind: string;
    electronExecutable: string;
    serviceExecutable: string;
    serviceEntrypoint: string;
    observation: Observation;
  },
  rows: () => NativeCallerCleanupRow[] = readRows,
) {
  const { observation } = input;
  const base = `${input.root}-native-caller-window-${input.kind}`;
  const evidence = `${base}.cleanup.json`;
  const mainPath = realpathSync(input.electronExecutable);
  const servicePath = realpathSync(input.serviceExecutable);
  const helperRoot = join(dirname(dirname(mainPath)), 'Frameworks');
  const initial = rows();
  const related = (row: NativeCallerCleanupRow) => {
    const args = row.command.split(/\s+/);
    return (
      args.includes(`--user-data-dir=${join(input.root, 'caller-electron-data')}`) ||
      args.includes(input.serviceEntrypoint)
    );
  };
  const relevant = initial.filter(related);
  if (!relevant.length) {
    writeFileSync(
      evidence,
      JSON.stringify({ root: input.root, observed: [], remaining: [], confirmed: true }),
    );
    console.log(
      JSON.stringify({
        stage: 'native_caller_parent_cleanup',
        root: input.root,
        observed: [],
        remaining: [],
        confirmed: true,
      }),
    );
    return;
  }
  const pidFile = `${base}.pid.json`;
  let recorded: unknown;
  if (existsSync(pidFile)) recorded = JSON.parse(readFileSync(pidFile, 'utf8')).pid;
  if (!Number.isSafeInteger(recorded) || Number(recorded) <= 1) {
    writeFileSync(
      evidence,
      JSON.stringify({ root: input.root, unconfirmed: relevant, confirmed: false }),
    );
    throw Error(`native_caller_cleanup_pid_unconfirmed:${input.root}`);
  }
  const owned = new Set<number>();
  const unconfirmed: number[] = [];
  const identities = new Map<number, NonNullable<ReturnType<Observation['observe']>>>();
  const admit = (row: NativeCallerCleanupRow, descendant: boolean) => {
    const identity = observation.observe(row.pid);
    if (!identity) {
      try {
        process.kill(row.pid, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
    }
    const fresh = rows().find((current) => current.pid === row.pid);
    const parent = descendant && fresh ? identities.get(fresh.parent) : undefined;
    const parentPresent = !descendant || (parent && observation.present(parent));
    const args = fresh?.command.split(/\s+/) ?? [];
    const main =
      identity?.executable === mainPath &&
      row.pid === recorded &&
      args.includes(join(input.root, 'native')) &&
      args.includes(`--user-data-dir=${join(input.root, 'caller-electron-data')}`);
    const service = identity?.executable === servicePath && args.includes(input.serviceEntrypoint);
    const helper =
      identity?.executable.startsWith(`${helperRoot}/`) &&
      args.includes(`--user-data-dir=${join(input.root, 'caller-electron-data')}`);
    if (
      !identity ||
      !fresh ||
      identity.parent !== fresh.parent ||
      !parentPresent ||
      !observation.present(identity) ||
      (descendant && (!parent || !observation.present(parent))) ||
      (!descendant && !main && !service && !helper)
    ) {
      unconfirmed.push(row.pid);
      return;
    }
    identities.set(row.pid, identity);
    owned.add(row.pid);
  };
  for (const row of relevant) admit(row, false);
  for (let count = 0; count < initial.length; count++)
    for (const row of initial)
      if (owned.has(row.parent) && !owned.has(row.pid) && !unconfirmed.includes(row.pid))
        admit(row, true);
  const observed = [...identities.values()];
  const report = { root: input.root, recordedPid: recorded, observed, unconfirmed };
  writeFileSync(evidence, JSON.stringify({ ...report, confirmed: false }));
  if (unconfirmed.length) throw Error(`native_caller_cleanup_identity_unconfirmed:${input.root}`);
  const signals: { pid: number; signal: number }[] = [];
  for (const identity of observed)
    if (observation.present(identity)) {
      observation.signal(identity, 15);
      signals.push({ pid: identity.pid, signal: 15 });
    }
  const deadline = Date.now() + 2000;
  while (observed.some((identity) => observation.present(identity)) && Date.now() < deadline)
    await fixtureDelay(20);
  for (const identity of observed)
    if (observation.present(identity)) {
      observation.signal(identity, 9);
      signals.push({ pid: identity.pid, signal: 9 });
    }
  const stopped = Date.now() + 5000;
  while (observed.some((identity) => observation.present(identity)) && Date.now() < stopped)
    await fixtureDelay(20);
  const remaining = observed.filter((identity) => observation.present(identity));
  const remainingRows = rows().filter(related);
  const confirmed = !remaining.length && !remainingRows.length;
  writeFileSync(
    evidence,
    JSON.stringify({ ...report, signals, remaining, remainingRows, confirmed }),
  );
  console.log(
    JSON.stringify({
      stage: 'native_caller_parent_cleanup',
      root: input.root,
      observed: observed.map((identity) => identity.pid),
      signals,
      remaining: remaining.map((identity) => identity.pid),
      confirmed,
    }),
  );
  if (!confirmed) throw Error(`native_caller_cleanup_unconfirmed:${input.root}`);
}
