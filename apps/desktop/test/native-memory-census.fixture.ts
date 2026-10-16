import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeShellProcessEvidence } from '@kite-ai/agent/jobs/shell';
import {
  type OwnedProcessIdentity,
  observeOwnedProcessIdentity,
} from '@kite-ai/agent/process-observation';
import type { MixedShellLedger } from '../../service/test/isolated/multi-session-shell-load.shared';

type Role =
  | 'service'
  | 'broker'
  | 'guardian'
  | 'workload'
  | 'descendant'
  | 'desktop-main'
  | 'desktop-renderer'
  | 'desktop-gpu'
  | 'desktop-utility'
  | 'desktop-helper';
type Row = {
  pid: number;
  parent: number;
  rssKiB: number;
  cpuPercent: number;
  cpuTimeMs: number;
  command: string;
};
type Binding = { role: Role; identity: OwnedProcessIdentity; label?: string; executionId?: string };
type PhysicalProcess = {
  pid: number;
  footprint?: number;
  auxiliary?: { phys_footprint?: number; phys_footprint_peak?: number };
};
const sameBirth = (a: OwnedProcessIdentity, b: OwnedProcessIdentity) =>
  !!a.birth &&
  !!b.birth &&
  a.pid === b.pid &&
  a.birth.seconds === b.birth.seconds &&
  a.birth.microseconds === b.birth.microseconds;

async function command(executable: string, args: string[], timeoutMs = 5000) {
  const child = Bun.spawn([executable, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { executable, args, exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Isolated test host only. No production IPC, permission changes or process signalling. */
export class NativeMemoryCensus {
  private readonly originals = new Map<number, Binding>();
  private input: {
    databasePath: string;
    evidenceDir: string;
  };
  constructor(input: {
    databasePath: string;
    evidenceDir: string;
  }) {
    this.input = input;
    mkdirSync(input.evidenceDir, { recursive: true });
  }

  /** Read-only postcondition, before a test owner could clean up a residual process. */
  async assertExited() {
    assert.ok(this.originals.size >= 69, 'complete original census required before exit');
    const deadline = Date.now() + 3000;
    for (;;) {
      const processes = [...this.originals.values()].map((row) => {
        const current = observeOwnedProcessIdentity(row.identity.pid);
        let absent = false;
        try {
          process.kill(row.identity.pid, 0);
        } catch (cause) {
          absent = (cause as NodeJS.ErrnoException).code === 'ESRCH';
        }
        return {
          ...row,
          current,
          status:
            absent && !current.birth
              ? 'absent'
              : current.birth && !sameBirth(row.identity, current)
                ? 'original-exited-pid-reused'
                : sameBirth(row.identity, current)
                  ? 'alive'
                  : 'unknown',
        };
      });
      const report = {
        collectedAt: new Date().toISOString(),
        total: processes.length,
        originalExited: processes.filter((row) =>
          ['absent', 'original-exited-pid-reused'].includes(row.status),
        ).length,
        processes,
      };
      writeFileSync(
        join(this.input.evidenceDir, 'original-identities-exit.json'),
        JSON.stringify(report, null, 2),
      );
      if (report.originalExited === report.total) return report;
      assert.ok(Date.now() < deadline, 'all original identities must exit without test cleanup');
      await Bun.sleep(25);
    }
  }

  async collectGpu(stage: string, pid: number) {
    assert.match(stage, /^[a-z0-9-]+$/);
    const original = this.originals.get(pid);
    assert.ok(original?.role === 'desktop-gpu', 'GPU must belong to the original full census');
    assert.ok(sameBirth(original.identity, observeOwnedProcessIdentity(pid)));
    const base = join(this.input.evidenceDir, stage);
    const footprint = await command('/usr/bin/footprint', [
      '-p',
      String(pid),
      '-f',
      'bytes',
      '-w',
      '-j',
      `${base}-gpu-footprint.json`,
    ]);
    writeFileSync(`${base}-gpu-footprint.txt`, footprint.stdout + footprint.stderr);
    const physical = JSON.parse(readFileSync(`${base}-gpu-footprint.json`, 'utf8')) as {
      processes?: PhysicalProcess[];
      errors?: unknown[];
      summary?: Record<string, { dirty?: number; reclaimable?: number; wired?: number }>;
      'total footprint'?: number;
    };
    assert.equal(footprint.exit, 0, 'GPU categorized footprint must be available');
    assert.ok(!physical.errors?.length, 'GPU footprint must have no sampling errors');
    assert.equal(physical.processes?.length, 1);
    assert.equal(physical.processes[0]!.pid, pid, 'GPU categorized PID must match original');
    assert.ok(
      typeof physical['total footprint'] === 'number' &&
        Number.isFinite(physical['total footprint']) &&
        physical['total footprint'] >= 0,
      'GPU categorized footprint must have a valid total',
    );
    assert.ok(physical.summary?.total, 'GPU OS category summary required');
    const vmmap = await command('/usr/bin/vmmap', ['-summary', '-wide', String(pid)]);
    writeFileSync(`${base}-gpu-vmmap.txt`, vmmap.stdout + vmmap.stderr);
    assert.ok(sameBirth(original.identity, observeOwnedProcessIdentity(pid)));
    const report = {
      stage,
      original,
      footprint: { exit: footprint.exit, path: `${base}-gpu-footprint.json` },
      jointDirtyFootprintBytes: physical['total footprint'],
      process: physical.processes[0],
      categories: physical.summary,
      vmmap: { exit: vmmap.exit, path: `${base}-gpu-vmmap.txt` },
      collectedAt: new Date().toISOString(),
    };
    writeFileSync(`${base}-gpu-os.json`, JSON.stringify(report, null, 2));
    assert.equal(vmmap.exit, 0, 'GPU vmmap must be available');
    return report;
  }

  async collect(input: {
    servicePid: number;
    electronPid: number;
    stage: string;
    shells: MixedShellLedger[];
    physical: boolean;
  }) {
    assert.match(input.stage, /^[a-z0-9-]+$/);
    assert.equal(input.shells.length, 16);
    const bindings: Binding[] = [];
    const launchd: { pid: number; target: string }[] = [];
    const add = (
      role: Role,
      identity: OwnedProcessIdentity,
      label?: string,
      executionId?: string,
    ) => {
      assert.ok(identity.birth && identity.unavailable.length === 0, `${role} birth unavailable`);
      assert.ok(
        sameBirth(identity, observeOwnedProcessIdentity(identity.pid)),
        `${role} original process is no longer alive`,
      );
      assert.ok(
        !bindings.some((row) => row.identity.pid === identity.pid),
        `duplicate census PID ${identity.pid}`,
      );
      bindings.push({ role, identity, label, executionId });
    };
    add('service', observeOwnedProcessIdentity(input.servicePid));
    const database = new Database(this.input.databasePath, { readonly: true });
    let jobs: { id: string; session_id: string; reference_json: string }[];
    try {
      jobs = database
        .query(
          "SELECT id,session_id,reference_json FROM execution WHERE adapter_id='shell.command' AND state='running'",
        )
        .all() as typeof jobs;
    } finally {
      database.close();
    }
    assert.equal(jobs.length, 16, 'all original real Shell Jobs must be running at census');
    for (const job of jobs) {
      const reference = JSON.parse(job.reference_json) as {
        nonce: string;
        ownedProcesses: unknown;
      };
      const proof = decodeShellProcessEvidence(
        reference.ownedProcesses,
        { sessionId: job.session_id, executionId: job.id, nonce: reference.nonce },
        input.servicePid,
      );
      assert.ok(proof?.version === 1, 'exact original macOS coalition proof required');
      const ledger = input.shells.find((row) => row.pid === proof.root.identity.pid);
      assert.ok(ledger && !ledger.complete, 'original workload PID must match live fixture ledger');
      add('broker', proof.broker, ledger.label, job.id);
      add('guardian', proof.guardian, ledger.label, job.id);
      launchd.push({
        pid: proof.guardian.pid,
        target: `${proof.coalition.domain}/${proof.coalition.label}`,
      });
      add('workload', proof.root.identity, ledger.label, job.id);
      const descendant = observeOwnedProcessIdentity(ledger.descendantPid);
      assert.equal(
        descendant.parentPid,
        ledger.pid,
        'ledger sleep belongs to the original workload',
      );
      add('descendant', descendant, ledger.label, job.id);
    }
    assert.equal(
      bindings.length,
      65,
      'complete Service+16 broker/guardian/workload/descendant census',
    );
    const ps = await command('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,rss=,%cpu=,time=,args=']);
    assert.equal(ps.exit, 0);
    const rows: Row[] = ps.stdout.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:.-]+)\s+(.*)$/);
      const time = match?.[5]?.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
      if (match) assert.ok(time, `invalid ps CPU time ${match[5]}`);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              rssKiB: Number(match[3]),
              cpuPercent: Number(match[4]),
              cpuTimeMs:
                (Number(time![1] ?? 0) * 86400 +
                  Number(time![2] ?? 0) * 3600 +
                  Number(time![3]) * 60 +
                  Number(time![4])) *
                1000,
              command: match[6]!,
            },
          ]
        : [];
    });
    const desktop = new Set([input.electronPid]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const row of rows)
        if (desktop.has(row.parent) && !desktop.has(row.pid)) {
          desktop.add(row.pid);
          changed = true;
        }
    }
    for (const row of rows.filter(
      (row) =>
        desktop.has(row.pid) && !bindings.some((binding) => binding.identity.pid === row.pid),
    )) {
      const role: Role =
        row.pid === input.electronPid
          ? 'desktop-main'
          : /--type=renderer(?:\s|$)/.test(row.command)
            ? 'desktop-renderer'
            : /--type=gpu-process(?:\s|$)/.test(row.command)
              ? 'desktop-gpu'
              : /--type=utility(?:\s|$)/.test(row.command)
                ? 'desktop-utility'
                : 'desktop-helper';
      add(role, observeOwnedProcessIdentity(row.pid));
    }
    const processes = bindings.map((binding) => {
      const row = rows.find((row) => row.pid === binding.identity.pid);
      assert.ok(row, `missing original process ${binding.identity.pid}`);
      assert.ok(
        sameBirth(binding.identity, observeOwnedProcessIdentity(row.pid)),
        'PID identity changed around ps sampling',
      );
      const original = this.originals.get(row.pid);
      assert.ok(!original || sameBirth(original.identity, binding.identity), 'census PID reused');
      this.originals.set(row.pid, binding);
      assert.equal(
        /(?:^|\s)--smol(?:\s|$)/.test(row.command),
        false,
        `default runtime arguments are required: ${binding.role}`,
      );
      return { ...binding, ...row };
    });
    const roleSummary = Object.fromEntries(
      [...new Set(processes.map((row) => row.role))].map((role) => {
        const selected = processes.filter((row) => row.role === role);
        return [
          role,
          {
            count: selected.length,
            rssKiB: selected.reduce((sum, row) => sum + row.rssKiB, 0),
            cpuTimeMs: selected.reduce((sum, row) => sum + row.cpuTimeMs, 0),
          },
        ];
      }),
    );
    const base = join(this.input.evidenceDir, input.stage);
    writeFileSync(
      `${base}-ps.txt`,
      processes
        .map(
          (row) =>
            `${row.pid}\t${row.parent}\t${row.rssKiB}\t${row.cpuPercent}\t${row.cpuTimeMs}\t${row.role}\t${row.command}`,
        )
        .join('\n'),
    );
    const report: Record<string, unknown> = {
      stage: input.stage,
      collectedAt: new Date().toISOString(),
      rssIsNotDeduplicatedPhysicalMemory: true,
      businessProcessCount: 65,
      excluded: ['test-driver', 'test-host-provider'],
      processes,
      roleSummary,
      shells: input.shells,
    };
    if (input.physical) {
      const jsonPath = `${base}-footprint.json`;
      const measured = await command(
        '/usr/bin/footprint',
        [
          ...processes.flatMap((row) => ['-p', String(row.pid)]),
          '-f',
          'bytes',
          '-w',
          '--noCategories',
          '-j',
          jsonPath,
        ],
        12000,
      );
      writeFileSync(`${base}-footprint.txt`, measured.stdout);
      writeFileSync(`${base}-footprint.stderr.txt`, measured.stderr);
      let physical:
        | {
            processes?: PhysicalProcess[];
            errors?: unknown[];
            warnings?: unknown[];
            summary?: unknown;
            'total footprint'?: number;
          }
        | undefined;
      let unavailable: string | undefined;
      try {
        physical = JSON.parse(readFileSync(jsonPath, 'utf8'));
      } catch (cause) {
        unavailable = String(cause);
      }
      if (
        measured.exit !== 0 ||
        physical?.errors?.length ||
        physical?.processes?.length !== processes.length
      )
        unavailable ??= 'footprint_incomplete_or_failed';
      const finiteBytes = (value: unknown): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (!finiteBytes(physical?.['total footprint']))
        unavailable ??= 'footprint_joint_total_unavailable';
      const expectedPids = processes.map((row) => row.pid).sort((a, b) => a - b);
      const actualPids = (physical?.processes ?? []).map((row) => row.pid).sort((a, b) => a - b);
      if (JSON.stringify(actualPids) !== JSON.stringify(expectedPids))
        unavailable ??= 'footprint_pid_set_mismatch';
      if (
        physical?.processes?.some(
          (row) =>
            !finiteBytes(row.footprint) ||
            !finiteBytes(row.auxiliary?.phys_footprint) ||
            !finiteBytes(row.auxiliary?.phys_footprint_peak),
        )
      )
        unavailable ??= 'footprint_per_process_counters_unavailable';
      for (const row of processes)
        if (!sameBirth(row.identity, observeOwnedProcessIdentity(row.pid)))
          unavailable ??= 'footprint_pid_identity_changed';
      report.physical = {
        status: unavailable ? 'unknown' : 'ok',
        error: unavailable,
        exit: measured.exit,
        rawJSON: jsonPath,
        rawText: `${base}-footprint.txt`,
        errors: physical?.errors,
        warnings: physical?.warnings,
        // Joint invocation deduplicates multiply-mapped objects. Per-process
        // lifetime peaks are not a simultaneous peak of the whole application.
        jointDeduplicatedFootprintBytes: physical?.['total footprint'] ?? null,
        summary: physical?.summary,
        perProcess: physical?.processes?.map((row) => ({
          pid: row.pid,
          role: processes.find((process) => process.pid === row.pid)?.role,
          footprintBytes: row.footprint ?? null,
          physFootprintBytes: row.auxiliary?.phys_footprint ?? null,
          lifetimePeakPhysFootprintBytes: row.auxiliary?.phys_footprint_peak ?? null,
        })),
      };
      const supervisors = processes.filter((row) => ['broker', 'guardian'].includes(row.role));
      const supervisorPath = `${base}-supervisors-footprint.json`;
      const supervisorMeasurement = await command(
        '/usr/bin/footprint',
        [
          ...supervisors.flatMap((row) => ['-p', String(row.pid)]),
          '-f',
          'bytes',
          '-w',
          '--noCategories',
          '-j',
          supervisorPath,
        ],
        12000,
      );
      writeFileSync(
        `${base}-supervisors-footprint.txt`,
        supervisorMeasurement.stdout + supervisorMeasurement.stderr,
      );
      let supervisorPhysical: typeof physical;
      let supervisorError: string | undefined;
      try {
        supervisorPhysical = JSON.parse(readFileSync(supervisorPath, 'utf8'));
      } catch (cause) {
        supervisorError = String(cause);
      }
      if (
        supervisors.length !== 32 ||
        supervisorMeasurement.exit !== 0 ||
        supervisorPhysical?.errors?.length ||
        !finiteBytes(supervisorPhysical?.['total footprint']) ||
        JSON.stringify(
          supervisorPhysical?.processes?.map((row) => row.pid).sort((a, b) => a - b),
        ) !== JSON.stringify(supervisors.map((row) => row.pid).sort((a, b) => a - b))
      )
        supervisorError ??= 'supervisor_joint_footprint_incomplete';
      for (const row of supervisors)
        if (!sameBirth(row.identity, observeOwnedProcessIdentity(row.pid)))
          supervisorError ??= 'supervisor_footprint_identity_changed';
      report.supervisorsPhysical = {
        status: supervisorError ? 'unknown' : 'ok',
        error: supervisorError,
        processCount: supervisors.length,
        jointDeduplicatedFootprintBytes: supervisorPhysical?.['total footprint'] ?? null,
        rawJSON: supervisorPath,
      };
      const receipts = [];
      for (const guardian of launchd) {
        const result = await command('/bin/launchctl', ['print', guardian.target]);
        const path = `${base}-launchd-${guardian.pid}.txt`;
        writeFileSync(path, result.stdout + result.stderr);
        assert.equal(result.exit, 0, 'exact original launchd label remains registered');
        assert.equal(Number(result.stdout.match(/^\tpid = (\d+)$/m)?.[1]), guardian.pid);
        const argumentsText = result.stdout.match(/\n\targuments = \{([\s\S]*?)\n\t\}/)?.[1];
        assert.ok(argumentsText, 'launchd actual arguments must be observable');
        assert.equal(
          /(?:^|\s)--smol(?:\s|$)/.test(argumentsText),
          false,
          'launchd guardian must retain default runtime arguments',
        );
        assert.ok(
          sameBirth(
            this.originals.get(guardian.pid)!.identity,
            observeOwnedProcessIdentity(guardian.pid),
          ),
          'launchd guardian identity changed during argv verification',
        );
        receipts.push({ ...guardian, path });
      }
      report.launchdArguments = receipts;
      const vmmap = [];
      for (const role of [
        'service',
        'broker',
        'guardian',
        'workload',
        'descendant',
        'desktop-renderer',
        'desktop-main',
        'desktop-gpu',
      ] as Role[]) {
        const representative = processes.find((row) => row.role === role);
        if (!representative) continue;
        const result = await command(
          '/usr/bin/vmmap',
          ['-summary', '-wide', String(representative.pid)],
          2500,
        );
        writeFileSync(`${base}-vmmap-${role}.txt`, result.stdout + result.stderr);
        vmmap.push({
          role,
          pid: representative.pid,
          status: result.exit === 0 ? 'ok' : 'unknown',
          exit: result.exit,
          raw: `${base}-vmmap-${role}.txt`,
        });
      }
      report.vmmap = vmmap;
      report.finishedAt = new Date().toISOString();
    }
    writeFileSync(`${base}-census.json`, JSON.stringify(report, null, 2));
    return report;
  }
}
