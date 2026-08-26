import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { buildCapabilityKillSwitchDecision } from '#kite-cli/release/capability-kill-switch';

describe('operations alerts and disable-only containment', () => {
  test('routes no-data and G0 to the real single-maintainer owner', () => {
    const document = parseDocument(
      readFileSync(resolve('ops/alerts/agent-production.yaml'), 'utf8'),
      { uniqueKeys: true },
    );
    expect(document.errors).toHaveLength(0);
    const policy = document.toJS() as {
      owner: string;
      backup: string;
      noData: string;
      remoteAutomaticKillSwitch: boolean;
      controlPlaneFailure: string;
      routes: { id: string; actions: string[] }[];
    };
    expect(policy.owner).toBe('github:@ferqx');
    expect(policy.backup).toBe('none_single_maintainer');
    expect(policy.noData).toBe('alert');
    expect(policy.remoteAutomaticKillSwitch).toBe(false);
    expect(policy.controlPlaneFailure).toBe('cohort_zero');
    expect(policy.routes.find((route) => route.id === 'g0-immediate')?.actions).toEqual([
      'capability_off',
      'cohort_zero',
      'preserve_metadata_evidence',
    ]);
  });

  test('can only disable capabilities, zero the cohort, and preserve evidence', () => {
    const decision = buildCapabilityKillSwitchDecision({
      version: 1,
      reason: 'g0_incident',
      disableCapabilities: ['mcp_write', 'shell', 'mcp_write'],
      cohortPercent: 0,
      rollbackArtifactDigest: `sha256:${'a'.repeat(64)}`,
      preserveMetadataEvidence: true,
    });
    expect(decision.cohortPercent).toBe(0);
    expect(decision.preserveMetadataEvidence).toBe(true);
    expect(decision.restrictionLayer.restrictions.capabilities).toEqual({
      mcp_write: { enabled: false, maxRollout: 'off' },
      shell: { enabled: false, maxRollout: 'off' },
    });
    expect(decision.restrictionLayer.restrictions.safety?.networkMode).toBe('off');
    expect(decision.restrictionLayer.restrictions.telemetry?.allowed).toBe(false);
  });

  test('rejects malformed artifact identity and unknown capability input', () => {
    expect(() =>
      buildCapabilityKillSwitchDecision({
        version: 1,
        reason: 'operator_containment',
        disableCapabilities: ['shell'],
        cohortPercent: 0,
        rollbackArtifactDigest: 'sha256:not-canonical',
        preserveMetadataEvidence: true,
      }),
    ).toThrow('canonical sha256');
    expect(() =>
      buildCapabilityKillSwitchDecision({
        version: 1,
        reason: 'operator_containment',
        disableCapabilities: ['unknown' as 'shell'],
        cohortPercent: 0,
        preserveMetadataEvidence: true,
      }),
    ).toThrow('Unknown release capability');
  });
});
