import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve('.github/workflows/release-candidate.yml'), 'utf8');

describe('non-production release candidate workflow skeleton', () => {
  test('has no automatic contribution trigger or release authority', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toMatch(/\n\s+push:/);
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('attestations: write');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('upload-artifact');
    expect(workflow).not.toContain('gh release');
    expect(workflow).toContain("github.repository == 'ferqx/kite-code'");
    expect(workflow).toContain('inputs.acknowledge_non_distributable == true');
  });

  test('uses a shell-independent explicit test list on every hosted platform', () => {
    expect(workflow).not.toContain('supply-chain*.test.ts');
    for (const testPath of [
      'tests/release/supply-chain-sbom.test.ts',
      'tests/release/supply-chain-workflow.test.ts',
      'tests/release/supply-chain-provenance.test.ts',
      'tests/release/supply-chain-platform-smoke.test.ts',
    ]) {
      expect(workflow).toContain(testPath);
    }
  });

  test('pins actions and makes the production job unreachable', () => {
    expect(workflow).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    expect(workflow).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(workflow).toContain('production-signing-disabled:');
    expect(workflow).toContain(
      [
        'if: ',
        '$',
        '{{ false && github.workflow_sha == vars.KITE_RELEASE_EXPECTED_WORKFLOW_SHA }}',
      ].join(''),
    );
    expect(workflow).toContain('nonDistributable=true productionCandidate=false');
    expect(workflow).toContain('scripts/release/verify-production-supply-chain.ts');
    expect(workflow).toContain(
      ['--repository-id "', '$', '{{ github.repository_id }}', '"'].join(''),
    );
    expect(workflow).toContain(
      ['--workflow-sha "', '$', '{{ vars.KITE_RELEASE_EXPECTED_WORKFLOW_SHA }}', '"'].join(''),
    );
    expect(workflow).toContain(
      ['--trusted-verifier-commit "', '$', '{{ vars.KITE_TRUSTED_VERIFIER_COMMIT }}', '"'].join(''),
    );
    expect(workflow).toContain(['--run-attempt "', '$', '{{ github.run_attempt }}', '"'].join(''));
    expect(workflow).toContain('KITE_RELEASE_GATE_DECISION_DIGEST: disabled-unconfigured');
    expect(workflow).toContain('KITE_RELEASE_SECURITY_REVIEWER_IDENTITY: disabled-unconfigured');
    expect(workflow).toContain('KITE_RELEASE_GH_SHA256:');
    expect(workflow).toContain('KITE_RELEASE_COSIGN_SHA256:');
    expect(workflow).toContain(['ref: ', '$', '{{ vars.KITE_TRUSTED_VERIFIER_COMMIT }}'].join(''));
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('TRUSTED_VERIFIER_COMMIT:');
    expect(workflow).toContain('^[a-f0-9]{40}$');
    expect(workflow).toContain('git -C trusted-verifier rev-parse --verify HEAD');
    expect(workflow).toContain('actual" != "$TRUSTED_VERIFIER_COMMIT');
    expect(workflow).toContain(
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    );
    expect(workflow).toContain(
      ['name: production-candidate-', '$', '{{ matrix.platform }}'].join(''),
    );
    expect(workflow).toContain('working-directory: trusted-verifier');
    expect(workflow).toContain(
      ['--native-launcher "../candidate/', '$', '{{ matrix.launcher }}', '"'].join(''),
    );
    expect(workflow).toContain('--security-review-evidence');
    expect(workflow).toContain('--security-reviewer-public-key');
    expect(workflow).toContain('platform: macos-arm64');
    expect(workflow).toContain('platform: linux-x64');
    expect(workflow).toContain('platform: windows-x64');
  });
});
