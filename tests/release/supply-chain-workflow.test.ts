import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve('.github/workflows/release-candidate.yml'), 'utf8');
const candidateBuilder = readFileSync(resolve('scripts/release/oss-candidate.ts'), 'utf8');
const candidateInstaller = readFileSync(
  resolve('scripts/release/install-oss-candidate.ts'),
  'utf8',
);
const windowsPublication = readFileSync(
  resolve('packages/builtin-runtime/src/filesystem/descriptor-relative.ts'),
  'utf8',
);
const windowsRunnerBuilder = readFileSync(
  resolve('scripts/release/build-windows-runner.ts'),
  'utf8',
);
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
    expect(windowsRunnerBuilder).toContain(
      '--remap-path-prefix=$' + '{cargoHome}=C:\\\\kite-cargo',
    );
    expect(windowsRunnerBuilder).toContain(
      '--remap-path-prefix=$' + '{projectRoot}=C:\\\\kite-source',
    );
    expect(windowsRunnerBuilder).toContain("'linker=rust-lld'");
    expect(windowsRunnerBuilder).toContain("'link-arg=--no-insert-timestamp'");
    const orderedSteps = [
      'rustup toolchain install 1.97.1-x86_64-pc-windows-gnu --profile minimal',
      'bun run scripts/release/build-windows-runner.ts',
      'bun run scripts/release/windows-runner-evidence.ts',
      'git diff --exit-code -- release/platform-capabilities/windows-runner.json',
      'Verify Windows App Server endpoint and Session Store fencing',
      'packages/kite-local-runtime/test/isolated/lifecycle-reservation.test.ts',
      'packages/runtime-storage-sqlite/test/kite-session-runtime-file.test.ts',
      'packages/runtime-storage-sqlite/test/kite-session-execution-authority.test.ts',
      'tests/release/app-server-daemon.test.ts',
      'bun run release:build',
    ];
    let previousIndex = -1;
    for (const step of orderedSteps) {
      const index = workflow.indexOf(step);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }

    for (const asset of [
      'release/platform-capabilities/windows-runner.json',
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

  test('publishes Windows install metadata through bounded native atomic commits', () => {
    expect(candidateInstaller).toContain(
      "import { atomicReplaceInLockedWindowsDirectory } from '@kite-ai/builtin-runtime/filesystem'",
    );
    expect(candidateInstaller.match(/flushFileBuffers: false/g)).toHaveLength(3);
    expect(candidateInstaller.match(/writeThroughFile: false/g)).toHaveLength(3);
    expect(candidateInstaller.match(/writeThroughMove: false/g)).toHaveLength(3);
    expect(windowsPublication).toContain('WINDOWS_FILE_FLAG_WRITE_THROUGH');
    expect(windowsPublication).toContain('WINDOWS_MOVEFILE_WRITE_THROUGH');
    expect(windowsPublication).toContain('input.flushFileBuffers !== false');
  });

  test('does not ship the retired evaluation or live-Provider jobs', () => {
    expect(workflow).not.toContain('live-provider-smoke');
    expect(workflow).not.toContain('run_live_provider_smoke');
    expect(workflow).not.toContain('DEEPSEEK_API_KEY:');
    expect(workflow).not.toContain('OPENCODE_API_KEY:');
    expect(workflow).not.toContain('test:provider:smoke');
    expect(workflow).not.toContain('scripts/evals/');
    expect(workflow).not.toContain('tests/evals/');
  });

  test('pins all third-party Actions to immutable commits', () => {
    expect(workflow).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    expect(workflow).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/);
  });
});
