import { expect, test } from 'bun:test';
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { shellProcessEvidenceEnded } from '@kite-ai/agent/jobs/shell';
import { WebFetchError } from '@kite-ai/agent/web-fetch';
import { resolveModelTransport } from '../../../apps/service/src/model-transport';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import type { ContinuousEvidence } from '../../../scripts/runtime/unified-soak-continuous';
import { verifyContinuousEvidence } from '../../../scripts/runtime/unified-soak-continuous';
import { verifyPairedServiceResources } from '../../../scripts/runtime/unified-soak-service-resources';
import { loopbackModelEnvironment } from '../../fixtures/loopback-model-environment';
import { temporaryDirectory } from '../../fixtures/test-filesystem';

test('the continuous local Provider route excludes unsupported OS proxy discovery without changing production transport', async () => {
  let discoveries = 0;
  const systemProxy = async () => {
    discoveries++;
    throw new WebFetchError('web_proxy_protocol_unsupported');
  };
  await expect(resolveModelTransport({ env: {}, systemProxy })).rejects.toMatchObject({
    code: 'model_proxy_protocol_unsupported',
  });
  const before = { ...process.env };
  const env = loopbackModelEnvironment(new URL('http://127.0.0.1:43123/'));
  const transport = await resolveModelTransport({ env, systemProxy });
  expect(transport.fetch).toBe(fetch);
  expect(discoveries).toBe(1);
  expect(env.NO_PROXY).toBe('127.0.0.1,localhost');
  expect(env.no_proxy).toBe(env.NO_PROXY);
  expect(env.HTTP_PROXY).toBe('http://127.0.0.1:43123');
  expect(env.http_proxy).toBe(env.HTTP_PROXY);
  expect(env.ALL_PROXY).toBe(env.HTTP_PROXY);
  expect(env.all_proxy).toBe(env.HTTP_PROXY);
  expect(process.env).toEqual(before);
  for (const url of ['https://127.0.0.1', 'http://remote.test', 'http://user:secret@127.0.0.1'])
    expect(() => loopbackModelEnvironment(new URL(url))).toThrow(
      'loopback_model_provider_required',
    );
});

test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'two default packaged Services run twenty original Sessions with real Files, child Agents and Shell work; cold facts cannot qualify padded elapsed time',
  async () => {
    const root = realpathSync.native(temporaryDirectory('kite-default-shell-continuous-'));
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
      expect(serviceResources).toMatchObject({
        version: process.platform === 'linux' ? 2 : 1,
        coverage: 'paired-services-only',
      });
      expect(
        verifyPairedServiceResources(serviceResources!, {
          platform: process.platform,
          storeId: evidence.storeId,
          candidateDigest: candidate.digest,
          instanceIds: evidence.serviceInstanceIds,
          coldRead: evidence.shell!.coldRead,
        }),
      ).toEqual([]);
      const resourceExpected = {
        platform: process.platform,
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
      expect(verifyContinuousEvidence(evidence, false, process.platform)).toEqual([]);
      expect(evidence.sessionIds).toHaveLength(20);
      expect(evidence.serviceInstanceIds).toHaveLength(2);
      expect(evidence.commandIds).toHaveLength(40);
      expect(evidence.synchronousEffects).toBe(40);
      expect(evidence.childCalls).toBe(40);
      expect(evidence.shell!.jobs).toHaveLength(40);
      expect(
        evidence.shell!.jobs.every((job) =>
          process.platform === 'linux'
            ? job.ownedProcesses?.coverage === 'shell-owned-pid-namespace' &&
              shellProcessEvidenceEnded(job.ownedProcesses)
            : job.ownedProcesses?.coverage === 'shell-owned-coalition' &&
              shellProcessEvidenceEnded(job.ownedProcesses),
        ),
      ).toBe(true);
      const unreaped = structuredClone(evidence);
      const proof = unreaped.shell!.jobs[0]!.ownedProcesses!;
      if (proof.coverage === 'shell-owned-pid-namespace') proof.owner.wrapper.exit = null;
      else proof.broker.exit = null;
      expect(verifyContinuousEvidence(unreaped, false, process.platform)).toContain(
        'continuous_shell_process_handoff_invalid',
      );
      expect(evidence.shell).toMatchObject({ coldRead: true, noReplay: true });
      expect(evidence.slowEntered).toBe(true);
      expect(evidence.peerEvents).toBeGreaterThan(0);
      expect(evidence.reconnects).toBe(2);
      expect(verifyContinuousEvidence(evidence, true, process.platform)).toContain(
        'continuous_formal_unqualified',
      );
      expect(
        verifyContinuousEvidence(
          {
            ...evidence,
            wallDurationMs: Math.max(evidence.wallDurationMs, 450000),
            activeWorkloadDurationMs: 450000,
          },
          true,
          process.platform,
        ),
      ).toContain('continuous_busy_union_invalid');
      const stoppedTree = structuredClone(evidence);
      stoppedTree.shell!.jobs[0]!.processTreeStopped = false as true;
      expect(verifyContinuousEvidence(stoppedTree, false, process.platform)).toContain(
        'continuous_background_shell_invalid',
      );
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
