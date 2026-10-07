import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { verifyContinuousEvidence } from '../../../scripts/runtime/unified-soak-continuous';
import { openDefaultShellContinuousFixture } from '../../fixtures/unified-agent/soak/continuous-default-shell';

test.skipIf(process.platform !== 'darwin')(
  'two default packaged Services run twenty original Sessions with real Files, child Agents and Shell work; cold facts cannot qualify padded elapsed time',
  async () => {
    const root = realpathSync.native(mkdtempSync('/private/tmp/kite-default-shell-continuous-'));
    const fixture = await openDefaultShellContinuousFixture(root);
    let closed = false;
    try {
      await fixture.cycle();
      await fixture.cycle();
      await fixture.confirmCold();
      closed = true;
      const evidence = fixture.evidence();
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
      await fixture.close();
      if (closed) rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
