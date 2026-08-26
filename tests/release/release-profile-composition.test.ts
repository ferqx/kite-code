import { describe, expect, test } from 'bun:test';
import {
  composeReleaseProfile,
  EMBEDDED_RELEASE_PROFILES_,
  parseReleaseProfile,
  RELEASE_CAPABILITIES,
  type ReleaseCapability,
  type ReleaseProfile,
  ReleaseProfileEscalationError,
  type ReleaseProfileRestrictionLayer,
} from '#kite-cli/config';

function broadProfile(): ReleaseProfile {
  const profile = structuredClone(EMBEDDED_RELEASE_PROFILES_['limited-production']);
  profile.capabilities = Object.fromEntries(
    RELEASE_CAPABILITIES.map((capability) => [
      capability,
      { maturity: 'stable', maxRollout: 'general' },
    ]),
  ) as Record<ReleaseCapability, { maturity: 'stable'; maxRollout: 'general' }>;
  profile.safety = {
    ...profile.safety,
    requireSandbox: false,
    sandboxUnavailable: 'verified_in_process_read_only',
    maxInteractionMode: 'full',
    maxFilesystemScope: 'full_access',
    networkMode: 'allowlist',
    networkAllowlist: ['api.example.test', 'mcp.example.test', 'shared.example.test'],
    networkDenylist: [],
    protectedPathPolicy: 'prompt',
    protectedPaths: [],
    mcpProviderAllowlist: ['mcp-a', 'mcp-b'],
    mcpProviderDenylist: [],
  };
  profile.resources = {
    maxRunDurationMs: 10_000,
    maxTurns: 100,
    maxModelRequests: 100,
    maxToolInvocations: 100,
    maxRunInputTokens: 100_000,
    maxRunOutputTokens: 20_000,
    maxConcurrentSubagents: 4,
    maxConcurrentWriters: 2,
    maxConcurrentToolInvocations: 4,
    maxConcurrentShellInvocations: 2,
    maxProcessTreeSizePerShellInvocation: 16,
    maxConcurrencyWaitMs: 5_000,
    maxArtifactBytes: 1_000_000,
  };
  profile.data = {
    providerRouteAllowlist: ['route-a', 'route-b'],
    providerRouteDenylist: [],
    maxWorkspaceDataClassification: 'confidential',
    allowProductionContentEvaluation: false,
  };
  profile.logging = {
    defaultMode: 'metadata',
    allowContentOptIn: true,
    retentionDays: 30,
    maxTotalBytes: 1_000_000,
    maxSessionBytes: 100_000,
  };
  profile.telemetry = {
    allowed: true,
    requiresConsent: true,
    endpointPolicy: 'user_configured',
  };
  profile.requirements = {
    minimumApproval: 'none',
    minimumVerification: 'not_required',
  };
  return parseReleaseProfile(profile);
}

const ADMIN_RESTRICTION: ReleaseProfileRestrictionLayer = {
  source: 'admin',
  restrictions: {
    capabilities: {
      shell: { maxRollout: 'canary' },
      mcp_write: { enabled: false },
    },
    safety: {
      requireSandbox: true,
      maxInteractionMode: 'auto',
      maxFilesystemScope: 'workspace_write',
      networkAllowlist: ['api.example.test', 'shared.example.test'],
      networkDenylist: ['blocked.example.test'],
      protectedPaths: ['/admin-protected'],
      mcpProviderAllowlist: ['mcp-a'],
      mcpProviderDenylist: ['mcp-blocked'],
    },
    resources: { maxTurns: 60, maxToolInvocations: 50 },
    data: {
      providerRouteAllowlist: ['route-a'],
      providerRouteDenylist: ['route-denied'],
      maxWorkspaceDataClassification: 'internal',
    },
    logging: { retentionDays: 14, maxSessionBytes: 50_000 },
    telemetry: { endpointPolicy: 'admin_only' },
    requirements: { minimumApproval: 'auto_review', minimumVerification: 'best_effort' },
  },
};

const USER_RESTRICTION: ReleaseProfileRestrictionLayer = {
  source: 'user',
  restrictions: {
    capabilities: { shell: { enabled: false }, plan: { maxRollout: 'internal' } },
    safety: {
      networkAllowlist: ['mcp.example.test', 'shared.example.test'],
      networkDenylist: ['user-blocked.example.test'],
      protectedPathPolicy: 'deny',
      protectedPaths: ['/user-protected'],
    },
    resources: { maxTurns: 40, maxModelRequests: 20 },
    logging: { defaultMode: 'off', allowContentOptIn: false, retentionDays: 7 },
    telemetry: { allowed: false },
    requirements: { minimumApproval: 'user', minimumVerification: 'required' },
  },
};

describe('ReleaseProfile monotonic composition', () => {
  test('uses deny-wins, intersections, unions, minima and stricter risk orders', () => {
    const effective = composeReleaseProfile({
      embedded: broadProfile(),
      layers: [ADMIN_RESTRICTION, USER_RESTRICTION],
    });

    expect(effective.capabilities.shell.maxRollout).toBe('off');
    expect(effective.capabilities.plan.maxRollout).toBe('internal');
    expect(effective.capabilities.mcp_write.maxRollout).toBe('off');
    expect(effective.capabilities.shell.maturity).toBe('stable');
    expect(effective.safety.requireSandbox).toBe(true);
    expect(effective.safety.maxInteractionMode).toBe('auto');
    expect(effective.safety.maxFilesystemScope).toBe('workspace_write');
    expect(effective.safety.networkAllowlist).toEqual(['shared.example.test']);
    expect(effective.safety.networkDenylist).toEqual([
      'blocked.example.test',
      'user-blocked.example.test',
    ]);
    expect(effective.safety.protectedPathPolicy).toBe('deny');
    expect(effective.safety.protectedPaths).toEqual(['/admin-protected', '/user-protected']);
    expect(effective.resources.maxTurns).toBe(40);
    expect(effective.resources.maxModelRequests).toBe(20);
    expect(effective.data.providerRouteAllowlist).toEqual(['route-a']);
    expect(effective.data.providerRouteDenylist).toEqual(['route-denied']);
    expect(effective.data.maxWorkspaceDataClassification).toBe('internal');
    expect(effective.logging.defaultMode).toBe('off');
    expect(effective.logging.allowContentOptIn).toBe(false);
    expect(effective.logging.retentionDays).toBe(7);
    expect(effective.telemetry.allowed).toBe(false);
    expect(effective.telemetry.endpointPolicy).toBe('admin_only');
    expect(effective.requirements).toEqual({
      minimumApproval: 'user',
      minimumVerification: 'required',
    });
  });

  test('is order independent for security results and never mutates the ceiling', () => {
    const ceiling = broadProfile();
    const forward = composeReleaseProfile({
      embedded: ceiling,
      layers: [ADMIN_RESTRICTION, USER_RESTRICTION],
    });
    const reversed = composeReleaseProfile({
      embedded: ceiling,
      layers: [USER_RESTRICTION, ADMIN_RESTRICTION],
    });
    expect(reversed).toEqual(forward);
    expect(ceiling.capabilities.shell.maxRollout).toBe('general');
    expect(ceiling.resources.maxTurns).toBe(100);
  });

  test('preserves an empty allowlist as network-off', () => {
    const effective = composeReleaseProfile({
      embedded: broadProfile(),
      layers: [
        {
          source: 'rollout',
          restrictions: { safety: { networkAllowlist: [] } },
        },
      ],
    });
    expect(effective.safety.networkAllowlist).toEqual([]);
    expect(effective.safety.networkMode).toBe('off');
  });

  test('removes denylisted identities from intersected allowlists', () => {
    const effective = composeReleaseProfile({
      embedded: broadProfile(),
      layers: [
        {
          source: 'admin',
          restrictions: {
            safety: {
              networkAllowlist: ['shared.example.test'],
              networkDenylist: ['shared.example.test'],
              mcpProviderDenylist: ['mcp-a'],
            },
            data: { providerRouteDenylist: ['route-a'] },
          },
        },
      ],
    });
    expect(effective.safety.networkMode).toBe('off');
    expect(effective.safety.networkAllowlist).toEqual([]);
    expect(effective.safety.mcpProviderAllowlist).toEqual(['mcp-b']);
    expect(effective.data.providerRouteAllowlist).toEqual(['route-b']);
  });

  test('rejects project and CLI attempts to raise the embedded ceiling', () => {
    const projectCeiling = broadProfile();
    projectCeiling.resources.maxTurns = 10;
    expect(() =>
      composeReleaseProfile({
        embedded: projectCeiling,
        layers: [{ source: 'project', restrictions: { resources: { maxTurns: 11 } } }],
      }),
    ).toThrow(ReleaseProfileEscalationError);

    const cliCeiling = broadProfile();
    cliCeiling.capabilities.shell.maxRollout = 'off';
    expect(() =>
      composeReleaseProfile({
        embedded: cliCeiling,
        layers: [{ source: 'cli', restrictions: { capabilities: { shell: { enabled: true } } } }],
      }),
    ).toThrow('cli restriction attempted to raise capabilities.shell.enabled');

    const userCeiling = broadProfile();
    userCeiling.requirements.minimumApproval = 'auto_review';
    expect(() =>
      composeReleaseProfile({
        embedded: userCeiling,
        layers: [
          {
            source: 'user',
            restrictions: { requirements: { minimumApproval: 'none' } },
          },
        ],
      }),
    ).toThrow('user restriction attempted to raise requirements.minimumApproval');
  });

  test('adding any generated resource restriction never increases a limit', () => {
    const ceiling = broadProfile();
    for (let requested = 0; requested <= ceiling.resources.maxTurns; requested += 5) {
      const effective = composeReleaseProfile({
        embedded: ceiling,
        layers: [
          {
            source: 'project',
            restrictions: { resources: { maxTurns: requested } },
          },
        ],
      });
      expect(effective.resources.maxTurns).toBeLessThanOrEqual(ceiling.resources.maxTurns);
      expect(effective.resources.maxTurns).toBe(requested);
    }
  });

  test('fails closed on unknown security fields and capability names', () => {
    expect(() =>
      composeReleaseProfile({
        embedded: broadProfile(),
        layers: [
          {
            source: 'project',
            restrictions: { safety: { futureBypass: true } },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      composeReleaseProfile({
        embedded: broadProfile(),
        layers: [
          {
            source: 'project',
            restrictions: { capabilities: { future_capability: { enabled: true } } },
          },
        ],
      }),
    ).toThrow('unknown release capability');
  });
});
