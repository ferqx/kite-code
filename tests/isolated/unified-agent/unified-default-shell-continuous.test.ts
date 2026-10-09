import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import type { ContinuousEvidence } from '../../../scripts/runtime/unified-soak-continuous';
import { verifyContinuousEvidence } from '../../../scripts/runtime/unified-soak-continuous';
import { verifyPairedServiceResources } from '../../../scripts/runtime/unified-soak-service-resources';

test.skipIf(process.platform !== 'darwin')(
  'two default packaged Services run twenty original Sessions with real Files, child Agents and Shell work; cold facts cannot qualify padded elapsed time',
  async () => {
    const root = realpathSync.native(mkdtempSync('/private/tmp/kite-default-shell-continuous-'));
    const candidate = await buildTerminalBundle({ destination: join(root, 'candidate') });
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'), 'dir');
    const workload = join(root, 'workload'),
      result = join(root, 'evidence.json');
    const entry = join(root, 'compiled-collection.ts');
    writeFileSync(
      entry,
      `import {writeFileSync} from 'node:fs';
import {openDefaultShellContinuousFixture} from ${JSON.stringify(join(import.meta.dir, '../../fixtures/unified-agent/soak/continuous-default-shell.ts'))};
const fixture=await openDefaultShellContinuousFixture(${JSON.stringify(workload)},process.argv[2]);
try {await fixture.cycle();await fixture.cycle();await fixture.confirmCold();writeFileSync(${JSON.stringify(result)},JSON.stringify(fixture.evidence()),{mode:0o600});}
finally {await fixture.close();}`,
      { mode: 0o600 },
    );
    const built = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    expect(built.success).toBe(true);
    const child = Bun.spawn(
      [
        join(candidate.root, candidate.manifest.entries.runtime),
        join(root, 'compiled-collection.js'),
        candidate.root,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 180000);
    let closed = false;
    try {
      const code = await child.exited;
      const [stdout, stderr] = await output;
      if (code !== 0)
        console.error(
          JSON.stringify({ caseId: 'compiled_default_continuous_failed', code, stdout, stderr }),
        );
      expect(code).toBe(0);
      closed = true;
      const evidence = JSON.parse(readFileSync(result, 'utf8')) as ContinuousEvidence;
      expect(evidence.shell!.candidateDigest).toBe(candidate.digest);
      const serviceResources = evidence.shell!.serviceResources;
      expect(serviceResources).toBeDefined();
      expect(serviceResources).toMatchObject({ version: 1, coverage: 'paired-services-only' });
      expect(
        verifyPairedServiceResources(serviceResources!, {
          storeId: evidence.storeId,
          candidateDigest: candidate.digest,
          instanceIds: evidence.serviceInstanceIds,
          coldRead: evidence.shell!.coldRead,
        }),
      ).toEqual([]);
      const resourceExpected = {
        storeId: evidence.storeId,
        candidateDigest: candidate.digest,
        instanceIds: evidence.serviceInstanceIds,
        coldRead: evidence.shell!.coldRead,
      };
      const missingRss = structuredClone(serviceResources!);
      missingRss.services[0]!.ready.rssBytes = null;
      expect(verifyPairedServiceResources(missingRss, resourceExpected)).toContain(
        'continuous_service_resources_unqualified',
      );
      const stillAlive = structuredClone(serviceResources!);
      stillAlive.services[0]!.exit!.kernelState = 'alive';
      expect(verifyPairedServiceResources(stillAlive, resourceExpected)).toContain(
        'continuous_service_resources_unqualified',
      );
      expect(existsSync(join(workload, 'candidate'))).toBe(false);
      expect(verifyContinuousEvidence(evidence, false)).toEqual([]);
      expect(evidence.sessionIds).toHaveLength(20);
      expect(evidence.serviceInstanceIds).toHaveLength(2);
      expect(evidence.commandIds).toHaveLength(40);
      expect(evidence.synchronousEffects).toBe(40);
      expect(evidence.childCalls).toBe(40);
      expect(evidence.shell!.jobs).toHaveLength(40);
      expect(evidence.shell).toMatchObject({ coldRead: true, noReplay: true });
      expect(evidence.slowEntered).toBe(true);
      expect(evidence.peerEvents).toBeGreaterThan(0);
      expect(evidence.reconnects).toBe(2);
      expect(verifyContinuousEvidence(evidence, true)).toContain('continuous_formal_unqualified');
      expect(
        verifyContinuousEvidence(
          {
            ...evidence,
            wallDurationMs: Math.max(evidence.wallDurationMs, 450000),
            activeWorkloadDurationMs: 450000,
          },
          true,
        ),
      ).toContain('continuous_busy_union_invalid');
      const jobs = structuredClone(evidence.shell!.jobs);
      jobs[0]!.processTreeStopped = false as true;
      expect(
        verifyContinuousEvidence({ ...evidence, shell: { ...evidence.shell!, jobs } }, false),
      ).toContain('continuous_background_shell_invalid');
      console.log(
        JSON.stringify({
          caseId: 'default_shell_continuous_short',
          commands: 40,
          busyMs: evidence.activeWorkloadDurationMs,
          candidate: evidence.shell!.candidateDigest,
        }),
      );
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await output;
      if (closed) rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
