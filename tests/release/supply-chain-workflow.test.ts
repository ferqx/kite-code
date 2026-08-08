import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve('.github/workflows/release-candidate.yml'), 'utf8');
const candidateBuilder = readFileSync(resolve('scripts/release/oss-candidate.ts'), 'utf8');
const cargoConfig = readFileSync(resolve('.cargo/config.toml'), 'utf8');

describe('ordinary open-source release candidate workflow', () => {
  test('runs hosted macOS, Ubuntu, and Windows without publish authority', () => {
    expect(workflow).toContain('pull_request:');
    expect(workflow).toMatch(/\n\s+push:/);
    expect(workflow).toContain('workflow_dispatch:');
    for (const runner of ['macos-15', 'ubuntu-24.04', 'windows-2025']) {
      expect(workflow).toContain(`os: ${runner}`);
    }
    for (const forbidden of [
      'id-token: write',
      'attestations: write',
      'contents: write',
      'packages: write',
      'environment: production-release',
      'gh release',
      'npm publish',
      'sigstore',
      'notarization',
      'authenticode',
    ]) {
      expect(workflow.toLowerCase()).not.toContain(forbidden);
    }
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  test('builds, verifies, installs, starts, rolls back, and uploads each native candidate', () => {
    for (const command of [
      'bun run release:build',
      'bun run release:verify -- --require-clean-source',
      'bun run release:smoke',
      'bun run scripts/run-tui-system-tests.ts startup',
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).toContain('retention-days: 14');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain(
      `KITE_EXPECTED_CANDIDATE_COMMIT: \${{ github.event.pull_request.head.sha || github.sha }}`,
    );
    expect(workflow).toContain(
      `KITE_CANDIDATE_REPOSITORY: \${{ github.event.pull_request.head.repo.full_name || github.repository }}`,
    );
    expect(workflow).toContain(`ref: \${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}`);
    expect(workflow).toContain(`repository: \${{ env.KITE_CANDIDATE_REPOSITORY }}`);
  });

  test('builds and pins the Windows sandbox runner before packaging every required asset', () => {
    expect(cargoConfig).toContain('[target.x86_64-pc-windows-gnu]');
    expect(cargoConfig).toContain('link-arg=-Wl,--no-insert-timestamp');
    const orderedSteps = [
      'rustup toolchain install 1.97.1-x86_64-pc-windows-gnu --profile minimal',
      'cargo build --release --manifest-path native/windows-sandbox-runner/Cargo.toml',
      'bun run scripts/release/windows-runner-evidence.ts',
      'git diff --exit-code -- release/platform-capabilities/windows-runner-v1.json',
      'bun run release:build',
    ];
    let previousIndex = -1;
    for (const step of orderedSteps) {
      const index = workflow.indexOf(step);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }

    for (const asset of [
      'release/platform-capabilities/windows-runner-v1.json',
      'native/windows-sandbox-runner/target/release/kite-windows-runner.exe',
      'vendor/isksh/isksh.exe',
      'vendor/isksh/coreutils.exe',
      'vendor/isksh/LICENSE-APACHE',
      'vendor/isksh/LICENSE-MIT',
      'vendor/isksh/LICENSE.coreutils',
    ]) {
      expect(candidateBuilder).toContain(asset);
    }
  });

  test('keeps real Provider calls explicit, low-volume, and artifact-free', () => {
    expect(workflow).toContain('run_live_provider_smoke');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain('DEEPSEEK_API_KEY:');
    expect(workflow).toContain('DASHSCOPE_API_KEY:');
    expect(workflow).toContain('bun run test:provider:smoke -- --provider all');
    const liveJob = workflow.slice(workflow.indexOf('  live-provider-smoke:'));
    expect(liveJob).not.toContain('upload-artifact');
  });

  test('pins all third-party Actions to immutable commits', () => {
    expect(workflow).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    expect(workflow).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/);
  });
});
