import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { readProcessStartIdentity, inspectProcess } = require(
  resolve(import.meta.dir, '../../service/src/daemon/process-identity.ts'),
) as {
  readProcessStartIdentity(pid: number): string | undefined;
  inspectProcess(pid: number, birth: string): 'alive' | 'dead' | 'uncertain';
};
type OwnedProcess = { pid: number; birth: string; parent: number; depth: number };

/** Private test owner. Bind while the exact Node driver is alive at an existing launch receipt. */
export class NativeOwnedProcesses {
  readonly errors: Error[] = [];
  confirmed = false;
  private readonly owned = new Map<number, OwnedProcess>();
  private settling?: Promise<void>;
  constructor(anchor: { pid: number; nodeExecutable: string; driverPath: string; root: string }) {
    const deadline = performance.now() + 1000;
    try {
      const root = realpathSync(anchor.root),
        driver = realpathSync(anchor.driverPath),
        node = realpathSync(anchor.nodeExecutable);
      if (dirname(driver) !== root || [root, driver, node].some((path) => /\s/.test(path)))
        throw Error('native_owned_anchor_path_invalid');
      const parentBirth = readProcessStartIdentity(process.pid),
        birth = readProcessStartIdentity(anchor.pid);
      if (!parentBirth || !birth) throw Error('native_owned_anchor_birth_unavailable');
      const command = this.ps(['-p', String(anchor.pid), '-o', 'comm='], deadline).trim(),
        args = this.ps(['-p', String(anchor.pid), '-o', 'args='], deadline).trim();
      if (
        command !== node ||
        !args.startsWith(`${node} ${driver} `) ||
        !args.split(/\s+/).includes(root) ||
        this.rows(deadline).find((row) => row.pid === anchor.pid)?.parent !== process.pid ||
        readProcessStartIdentity(process.pid) !== parentBirth ||
        readProcessStartIdentity(anchor.pid) !== birth
      )
        throw Error('native_owned_anchor_mismatch');
      this.owned.set(anchor.pid, { pid: anchor.pid, birth, parent: process.pid, depth: 0 });
    } catch (error) {
      this.record(error);
    }
  }
  get metadata() {
    return { confirmed: this.confirmed, processes: [...this.owned.values()] };
  }
  private record(error: unknown) {
    const value = error instanceof Error ? error : Error('native_owned_observation_failed');
    if (!this.errors.some((item) => item.message === value.message)) this.errors.push(value);
  }
  private ps(args: string[], deadline: number) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw Error('native_owned_observation_deadline');
    return execFileSync('/bin/ps', ['-ww', ...args], {
      encoding: 'utf8',
      timeout: remaining,
      maxBuffer: 8 * 1048576,
    });
  }
  private rows(deadline: number) {
    return this.ps(['-axo', 'pid=,ppid='], deadline)
      .split('\n')
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]) }] : [];
      });
  }
  private status(item: OwnedProcess, deadline: number) {
    if (performance.now() >= deadline) throw Error('native_owned_observation_deadline');
    const current = readProcessStartIdentity(item.pid);
    if (current !== undefined && current !== item.birth)
      throw Error(`native_owned_identity_changed:${item.pid}`);
    if (performance.now() >= deadline) throw Error('native_owned_observation_deadline');
    const status = inspectProcess(item.pid, item.birth);
    if (performance.now() >= deadline) throw Error('native_owned_observation_deadline');
    const after = readProcessStartIdentity(item.pid);
    if (after !== undefined && after !== item.birth)
      throw Error(`native_owned_identity_changed:${item.pid}`);
    if (status === 'alive' && current === item.birth && after === item.birth) return 'alive';
    if (status === 'dead' && after === undefined) return 'dead';
    return 'uncertain';
  }
  /** Call on existing launch/run phase receipts; cached live descendants remain independent roots. */
  capture(deadline = performance.now() + 1000) {
    try {
      if (!this.owned.size) throw Error('native_owned_anchor_unbound');
      const queue = [...this.owned.values()],
        visited = new Set<number>();
      for (const parent of queue) {
        if (visited.has(parent.pid)) continue;
        visited.add(parent.pid);
        try {
          if (this.status(parent, deadline) !== 'alive') continue;
          for (const row of this.rows(deadline).filter((row) => row.parent === parent.pid)) {
            try {
              const birth = readProcessStartIdentity(row.pid);
              if (!birth) {
                if (inspectProcess(row.pid, '') === 'dead') continue;
                throw Error(`native_owned_child_birth_unavailable:${row.pid}`);
              }
              const fresh = this.rows(deadline).find((item) => item.pid === row.pid);
              const after = readProcessStartIdentity(row.pid);
              if (!fresh && after === undefined && inspectProcess(row.pid, birth) === 'dead')
                continue;
              if (
                birth !== after ||
                fresh?.parent !== parent.pid ||
                readProcessStartIdentity(parent.pid) !== parent.birth
              )
                throw Error(`native_owned_child_observation_changed:${row.pid}`);
              const previous = this.owned.get(row.pid);
              if (previous && previous.birth !== birth)
                throw Error(`native_owned_identity_changed:${row.pid}`);
              const child = previous ?? {
                pid: row.pid,
                birth,
                parent: parent.pid,
                depth: parent.depth + 1,
              };
              this.owned.set(row.pid, child);
              queue.push(child);
            } catch (error) {
              this.record(error);
            }
          }
        } catch (error) {
          this.record(error);
        }
      }
    } catch (error) {
      this.record(error);
    }
  }
  /** Cleanup never turns residual processes on a successful business path into success. */
  settle(normalExit: boolean): Promise<void> {
    this.settling ??= this.cleanup(normalExit);
    return this.settling;
  }
  private async cleanup(normalExit: boolean) {
    const deadline = performance.now() + 2000,
      signalled = new Set<number>();
    this.capture(deadline);
    const ordered = [...this.owned.values()].sort((a, b) => b.depth - a.depth);
    for (;;) {
      let allDead = this.owned.size > 0;
      for (const item of ordered) {
        try {
          const status = this.status(item, deadline);
          if (status === 'dead') continue;
          allDead = false;
          if (status !== 'alive') continue;
          if (normalExit) this.record(Error(`native_owned_success_left_alive:${item.pid}`));
          if (signalled.has(item.pid)) continue;
          if (performance.now() >= deadline) throw Error('native_owned_cleanup_deadline');
          if (readProcessStartIdentity(item.pid) !== item.birth) {
            this.status(item, deadline);
            continue;
          }
          signalled.add(item.pid);
          try {
            process.kill(item.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        } catch (error) {
          this.record(error);
          allDead = false;
        }
      }
      if (allDead) {
        this.confirmed = this.errors.length === 0;
        return;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        this.record(Error('native_owned_cleanup_not_confirmed'));
        return;
      }
      await Bun.sleep(Math.min(20, remaining));
    }
  }
}
