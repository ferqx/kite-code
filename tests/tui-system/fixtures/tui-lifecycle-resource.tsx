import { randomUUID } from 'node:crypto';
import { appendFileSync, readdirSync } from 'node:fs';
import { cleanup, render } from 'ink-testing-library';
import InputLine from '#kite-cli/tui/components/InputLine';
import { terminalFocusStore } from '#kite-cli/tui/hooks/terminal-focus-store';
import { readOsProcessStartIdentity } from '../../../scripts/runtime/process-start-identity';

const telemetryFile = process.env.KITE_FAULT_SOAK_TELEMETRY_FILE;
const requestedRepeats = Number(process.env.KITE_FAULT_SOAK_REPEAT_COUNT);
const repeatCount =
  Number.isInteger(requestedRepeats) && requestedRepeats > 0 ? requestedRepeats : 1;
const requestedDeadline = Number(process.env.KITE_FAULT_SOAK_LIFECYCLE_DEADLINE_MS);
const deadlineMs =
  Number.isInteger(requestedDeadline) && requestedDeadline > 0 ? requestedDeadline : 180_000;
const lifecycleGroupNonce = randomUUID();
const processStartNonce = `${process.env.KITE_FAULT_SOAK_PROCESS_NONCE ?? 'unbound'}:${process.pid}`;

interface ResourceSample {
  rssBytes: number;
  activeResources: number;
  fileDescriptors?: number;
  listeners: number;
  handles?: number;
}

function fileDescriptorCount(): number | undefined {
  if (process.platform === 'win32') return undefined;
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  try {
    return readdirSync(directory).length;
  } catch {
    return undefined;
  }
}

function activeHandleCount(): number | undefined {
  const getActiveHandles = (
    process as typeof process & { _getActiveHandles?: () => readonly unknown[] }
  )._getActiveHandles;
  return typeof getActiveHandles === 'function' ? getActiveHandles().length : undefined;
}

function sample(): ResourceSample {
  return {
    rssBytes: process.memoryUsage.rss(),
    activeResources: process.getActiveResourcesInfo().length,
    fileDescriptors: fileDescriptorCount(),
    listeners: process
      .eventNames()
      .reduce((total, eventName) => total + process.listenerCount(eventName), 0),
    handles: activeHandleCount(),
  };
}

function descendantPids(rootPid: number): number[] | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const listing = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (listing.exitCode !== 0) return undefined;
    const children = new Map<number, number[]>();
    for (const line of listing.stdout.toString().split('\n')) {
      const [pidText, parentText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      if (pid === listing.pid) continue;
      children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const descendants: number[] = [];
    const visit = (parent: number): void => {
      for (const child of children.get(parent) ?? []) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(rootPid);
    return descendants.sort((left, right) => left - right);
  } catch {
    return undefined;
  }
}

for (let sequence = 1; sequence <= repeatCount; sequence += 1) {
  const startedAt = performance.now();
  const before = sample();
  const view = render(
    <InputLine mode="prompt" onSubmit={() => {}} workspace={process.cwd()} disabled />,
  );
  await Bun.sleep(5);
  const mountedDiagnostics = terminalFocusStore.diagnostics();
  if (!mountedDiagnostics.reportingEnabled || mountedDiagnostics.subscriberCount === 0) {
    throw new Error(`TUI focus reporting did not activate: ${JSON.stringify(mountedDiagnostics)}`);
  }
  if (process.stdin.listenerCount('data') !== 0) {
    throw new Error('TUI focus reporting attached a competing process.stdin data listener');
  }
  view.unmount();
  view.cleanup();
  cleanup();
  await Bun.sleep(5);
  const diagnostics = terminalFocusStore.diagnostics();
  if (diagnostics.subscriberCount !== 0 || diagnostics.reportingEnabled) {
    throw new Error(`TUI listener cleanup failed: ${JSON.stringify(diagnostics)}`);
  }
  const after = sample();
  const descendants = descendantPids(process.pid);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (durationMs > deadlineMs) {
    throw new Error(`TUI lifecycle exceeded ${deadlineMs}ms`);
  }
  if (telemetryFile) {
    appendFileSync(
      telemetryFile,
      `${JSON.stringify({
        version: 2,
        kind: 'process_resource',
        pid: process.pid,
        parentPid: process.ppid,
        sequence,
        caseId: process.env.KITE_FAULT_SOAK_CASE_ID ?? 'tui_lifecycle_churn',
        lifecycleId: 'tui-input-focus-lifecycle',
        processStartNonce,
        osProcessStartIdentity: readOsProcessStartIdentity(process.pid),
        lifecycleGroupNonce,
        durationMs,
        deadlineMs,
        cleanup: {
          confirmed: descendants !== undefined && descendants.length === 0,
          descendantInspectionSupported: descendants !== undefined,
          descendantPidsAfter: descendants ?? [],
        },
        before,
        after,
      })}\n`,
      { mode: 0o600 },
    );
  }
}

process.stdout.write(`TUI_LIFECYCLE_COMPLETE ${repeatCount}\n`);
