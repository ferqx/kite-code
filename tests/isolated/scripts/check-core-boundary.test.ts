import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
const checker = resolve(import.meta.dir, '../../../scripts/check-core-boundary.ts');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'kite-core-boundary-'));
  roots.push(root);
  for (const directory of ['src/app', 'src/core', 'src/protocol']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return Bun.spawnSync(['bun', 'run', checker], { cwd: root });
}

describe('check-core-boundary', () => {
  test('rejects indirect access to the installed raw Subagent composition', () => {
    const result = fixture({
      'src/core/model/invocation-composition.ts':
        'const subagentComposition = {}; export const installed = { subagentComposition };\n',
      'src/core/controllers/invalid.ts':
        "import { installed } from '@/core/model/invocation-composition';\nvoid installed.subagentComposition.provider;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'installed Subagent composition must remain private to the installation root',
    );
  });

  test('rejects protocol imports from Core', () => {
    const result = fixture({
      'src/core/invalid-event.ts': 'export interface RuntimeEvent {}\n',
      'src/protocol/invalid.ts': "import type { RuntimeEvent } from '@/core/invalid-event';\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('protocol must not import core or app');
  });

  test('rejects multiline and relative protocol imports from Core', () => {
    const result = fixture({
      'src/core/invalid-event.ts': 'export interface RuntimeEvent {}\n',
      'src/protocol/invalid.ts':
        "import {\n  type RuntimeEvent,\n} from '../core/runtime/reducer';\nexport type Event = RuntimeEvent;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('protocol must not import core or app');
  });

  test('rejects dynamic protocol imports from App', () => {
    const result = fixture({
      'src/app/adapter.ts': 'export const value = 1;\n',
      'src/protocol/invalid.ts': "export const load = () => import('@/app/adapter');\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('protocol must not import core or app');
  });

  test('rejects Core imports from App', () => {
    const result = fixture({
      'src/app/view.ts': 'export interface View {}\n',
      'src/core/invalid.ts': "export type { View } from '@/app/view';\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('core must not import app');
  });

  test('rejects production imports of the test-only Tool helper', () => {
    const result = fixture({
      'src/core/controllers/invalid.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects extension-qualified test-only Tool helper imports', () => {
    const result = fixture({
      'src/core/controllers/invalid.ts':
        "export { invokeTestGovernedTool } from '@/tests/helpers/governed-tool.ts';\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects test-only Tool helper imports in the Pipeline dispatch adapter', () => {
    const result = fixture({
      'src/core/execution/tool-pipeline/dispatch.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nexport const dispatch = invokeTestGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects the test-only Tool helper in Tool Controller', () => {
    const result = fixture({
      'src/core/controllers/tool-controller.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects type-only test helper imports from production Tool Controller', () => {
    const result = fixture({
      'src/core/controllers/tool-controller.ts':
        "import type { GovernedToolInvocationInput } from '@/tests/helpers/governed-tool';\nimport { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects mixed test helper runtime imports in Tool Controller', () => {
    const result = fixture({
      'src/core/controllers/tool-controller.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects aliased, default, and namespace test helper imports in Tool Controller', () => {
    for (const importStatement of [
      "import { invokeTestGovernedTool as governed } from '@/tests/helpers/governed-tool';\nvoid governed;\n",
      "import runner, { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid runner;\nvoid invokeTestGovernedTool;\n",
      "import * as runner from '@/tests/helpers/governed-tool';\nvoid runner;\n",
      "import '@/tests/helpers/governed-tool';\n",
    ]) {
      const result = fixture({
        'src/core/controllers/tool-controller.ts': importStatement,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        'production source must not import test helper providers',
      );
    }
  });

  test('rejects other test helper imports in Tool Controller', () => {
    const result = fixture({
      'src/core/controllers/tool-controller.ts':
        "import { containsBrokeredGitInvocationForTest } from '@/tests/helpers/governed-tool';\nvoid containsBrokeredGitInvocationForTest;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects test helper imports from App, package, and script production roots', () => {
    const result = fixture({
      'apps/kite-cli/src/invalid.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
      'apps/kite-service/src/invalid.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
      'packages/runtime-spi/src/invalid.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
      'scripts/invalid.ts':
        "import { invokeTestGovernedTool } from '@/tests/helpers/governed-tool';\nvoid invokeTestGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr.match(/production source must not import test helper providers/g)?.length).toBe(
      4,
    );
  });

  test('rejects retired Tool Runner symbols in every production root', () => {
    const result = fixture({
      'src/core/invalid.ts': 'export const invokeGovernedTool = true;\n',
      'apps/kite-cli/src/invalid.ts': 'export const completedTaskExecutionResult = true;\n',
      'apps/kite-service/src/invalid.ts': 'export const completedTaskExecutionResult = true;\n',
      'packages/runtime-spi/src/invalid.ts': 'export const containsBrokeredGitInvocation = true;\n',
      'scripts/invalid.ts': 'export const invokeGovernedTool = true;\n',
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.stderr
        .toString()
        .match(/retired Core Tool Runner symbols must not exist in production source/g)?.length,
    ).toBe(5);
  });

  test('rejects LocalFilesystemProvider imports of policy, Runtime authority, and App modules', () => {
    const result = fixture({
      'src/core/policies/protected-path.ts': 'export const policy = true;\n',
      'src/core/policies/approval-policy.ts': 'export const approval = true;\n',
      'src/core/runtime/reducer.ts': 'export const reducer = true;\n',
      'src/core/runtime/kernel.ts': 'export const kernel = true;\n',
      'src/core/runtime/store.ts': 'export const store = true;\n',
      'apps/kite-cli/src/tui/view.ts': 'export const view = true;\n',
      'src/core/execution/workspace-filesystem/local-provider.ts':
        "import { policy } from '@kite-ai/builtin-runtime/sandbox';\n" +
        "import { approval } from '@/core/policies/approval-policy.ts';\n" +
        "export { event } from '../../runtime/reducer.ts';\n" +
        "export const loadState = () => import('../../runtime/reducer.js');\n" +
        "export { reducer } from '../../runtime/reducer';\n" +
        "export const loadKernel = () => require('../../runtime/kernel');\n" +
        "export const loadStore = () => import('../../runtime/store');\n" +
        "export { view } from '../../../app/tui/view';\n" +
        'void policy; void approval;\n',
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      'LocalFilesystemProvider must not own policy, approval, Runtime state, or App authority',
    );
    expect(stderr).toContain('@/core/policies/approval-policy.ts');
    expect(stderr).toContain('../../runtime/reducer.ts');
    expect(stderr).toContain('../../runtime/reducer.js');
    expect(stderr).toContain('../../runtime/reducer');
    expect(stderr).toContain('../../runtime/kernel');
    expect(stderr).toContain('../../runtime/store');
    expect(stderr).toContain('../../../app/tui/view');
  });

  test('accepts LocalFilesystemProvider imports of protocol and Node filesystem primitives', () => {
    const result = fixture({
      'src/protocol/workspace-filesystem-provider.ts':
        'export interface WorkspaceFilesystemProvider {}\n',
      'src/core/execution/workspace-filesystem/local-provider.ts':
        "import { readFile } from 'node:fs/promises';\n" +
        "import type { WorkspaceFilesystemProvider } from '@kite-ai/runtime-spi';\n" +
        'export const provider: WorkspaceFilesystemProvider = {};\nvoid readFile;\n',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
  });

  test('rejects Sandbox Provider authority and process spawn', () => {
    const result = fixture({
      'src/core/policies/approval-policy.ts': 'export const approval = true;\n',
      '@kite-ai/agent-kernel.ts': 'export const event = true;\n',
      'src/core/execution/sandbox-execution/local-provider.ts':
        "import { approval } from '@/core/policies/approval-policy';\n" +
        "import { event } from '@kite-ai/agent-kernel';\n" +
        "Bun.spawn(['forbidden']);\nvoid approval; void event;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain('LocalSandboxExecutionProvider must not own policy');
    expect(stderr).toContain(
      'SandboxExecutionProvider dependency closure must not spawn processes',
    );
  });

  test('rejects indirect Sandbox Provider spawn and production authority bypasses', () => {
    const result = fixture({
      'src/core/execution/sandbox-execution/local-provider.ts':
        "import { allocate } from './allocating-helper';\nvoid allocate;\n",
      'src/core/execution/sandbox-execution/allocating-helper.ts':
        "export const allocate = () => Bun.spawn(['forbidden']);\n",
      'src/core/controllers/sandbox-bypass.ts':
        "import { LocalSandboxExecutionProvider } from '@kite-ai/builtin-runtime/sandbox';\n" +
        "import { shellTool } from '@/core/tools/shell';\n" +
        'export const createSandboxExecutor = () => new LocalSandboxExecutionProvider(shellTool);\n',
      'src/core/tools/shell.ts': 'export const shellTool = true;\n',
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      'SandboxExecutionProvider dependency closure must not spawn processes',
    );
    expect(stderr).toContain('legacy createSandboxExecutor production entry must not exist');
    expect(stderr).toContain('production Shell authority must not import or call bare shellTool');
  });

  test('requires the acknowledged host Shell factory to use Builtin semantics', () => {
    const allowed = fixture({
      'src/app/sandbox/acknowledged-host-shell.ts':
        "import { createBuiltinShellExecutor } from '@kite-ai/builtin-runtime/sandbox';\n" +
        "import { createRuntimeHostProcessExecutionPort } from '@kite-ai/runtime-host';\n" +
        'export const createAcknowledgedHostShellExecutor = () =>\n' +
        '  createBuiltinShellExecutor(createRuntimeHostProcessExecutionPort());\n',
      'src/app/sandbox/composition.ts':
        "import { createAcknowledgedHostShellExecutor } from './acknowledged-host-shell';\nvoid createAcknowledgedHostShellExecutor;\n",
    });
    expect(allowed.exitCode).toBe(0);

    const bypass = fixture({
      'src/app/sandbox/acknowledged-host-shell.ts':
        "import { shellTool } from '@/core/tools/shell';\nexport const createAcknowledgedHostShellExecutor = () => shellTool;\n",
      'src/app/sandbox/composition.ts':
        "import { createAcknowledgedHostShellExecutor } from './acknowledged-host-shell';\nvoid createAcknowledgedHostShellExecutor;\n",
      'src/core/controllers/sandbox-bypass.ts':
        "import { createAcknowledgedHostShellExecutor } from '@/app/sandbox/acknowledged-host-shell';\nvoid createAcknowledgedHostShellExecutor;\n",
      'src/core/tools/shell.ts': 'export const shellTool = true;\n',
    });
    expect(bypass.exitCode).toBe(1);
    expect(bypass.stderr.toString()).toContain(
      'Acknowledged host Shell availability fallback has one App composition owner',
    );
    expect(bypass.stderr.toString()).toContain(
      'Acknowledged host Shell must use Builtin semantics, not Core shell value imports',
    );
  });

  test('rejects legacy and non-consumer Windows sandbox process entries', () => {
    const result = fixture({
      'src/core/sandbox/legacy.ts':
        'export const createWindowsRestrictedTokenExecutor = true;\n' +
        'executeWindowsRestrictedTokenPrepared(input, prepared);\n',
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain('legacy Windows sandbox executor entry must not exist');
    expect(stderr).toContain('Windows sandbox process adapters are Runtime-consumer-only');
  });

  test('rejects Runtime authority shapes retired by CUT-01', () => {
    const result = fixture({
      'src/protocol/capabilities.ts':
        'export interface LegacyCapabilityArtifactRef { relativePath: string }\n',
      'src/core/controllers/legacy-task.ts': "export const source = 'legacy_v24';\n",
      'src/core/runtime/kernel.ts':
        "export const normalize = (state: object) => 'modelInvocations' in state;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain('CUT-01 forbids legacy Runtime authority shapes in production source');
    expect(stderr).toContain('CUT-01 forbids same-epoch Model invocation index normalization');
  });

  test('allows Node filesystem access only in the exact descriptor-relative backend helper', () => {
    const accepted = fixture({
      'src/core/execution/workspace-filesystem/descriptor-relative.ts':
        "import { closeSync } from 'node:fs';\nvoid closeSync;\n",
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout.toString()).toContain('Core boundary checks passed.');

    const rejected = fixture({
      'src/core/execution/workspace-filesystem/descriptor-relative-other.ts':
        "import { closeSync } from 'node:fs';\nvoid closeSync;\n",
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain(
      'capability filesystem Node fs access must stay inside LocalFilesystemProvider',
    );
  });

  test('rejects concrete WorkspaceFilesystemProvider imports outside composition and Pipeline', () => {
    const result = fixture({
      'src/core/execution/workspace-filesystem/index.ts':
        'export const LocalWorkspaceFilesystemProvider = {};\n',
      'src/core/controllers/invalid.ts':
        "import { LocalWorkspaceFilesystemProvider } from '../execution/workspace-filesystem/index';\nvoid LocalWorkspaceFilesystemProvider;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'concrete WorkspaceFilesystemProvider imports must stay inside composition and Tool Pipeline',
    );
  });

  test('allows concrete WorkspaceFilesystemProvider only in production composition', () => {
    const result = fixture({
      'src/core/execution/workspace-filesystem/index.ts':
        'export const LocalWorkspaceFilesystemProvider = {};\n',
      'src/core/model/invocation-composition.ts':
        "import { LocalWorkspaceFilesystemProvider } from '@kite-ai/builtin-runtime/filesystem';\nvoid LocalWorkspaceFilesystemProvider;\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
  });

  test('keeps filesystem observation authority inside the issuer and receipt verifier', () => {
    const accepted = fixture({
      'src/core/execution/tool-pipeline/filesystem-observation-authority.ts':
        'export const issueWorkspaceFilesystemObservationAuthority = true;\nexport const assertAuthority = true;\n',
      'src/core/execution/tool-pipeline/workspace-filesystem.ts':
        "import { issueWorkspaceFilesystemObservationAuthority } from './filesystem-observation-authority';\nvoid issueWorkspaceFilesystemObservationAuthority;\n",
      'src/core/execution/tool-pipeline/dispatch.ts':
        "import { assertAuthority } from './filesystem-observation-authority';\nvoid assertAuthority;\n",
      'src/core/execution/tool-pipeline/receipt.ts':
        "import { assertAuthority } from './filesystem-observation-authority';\nvoid assertAuthority;\n",
    });
    expect(accepted.exitCode).toBe(0);

    const rejected = fixture({
      'src/core/execution/tool-pipeline/filesystem-observation-authority.ts':
        'export const issue = true;\n',
      'src/core/controllers/invalid.ts':
        "import { issue } from '@/core/execution/tool-pipeline/filesystem-observation-authority';\nvoid issue;\n",
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain(
      'filesystem observation authority must stay inside its Workspace Pipeline issuer and receipt verifier',
    );

    const receiptIssuer = fixture({
      'src/core/execution/tool-pipeline/filesystem-observation-authority.ts':
        'export const issueWorkspaceFilesystemObservationAuthority = true;\n',
      'src/core/execution/tool-pipeline/receipt.ts':
        "import { issueWorkspaceFilesystemObservationAuthority } from './filesystem-observation-authority';\nvoid issueWorkspaceFilesystemObservationAuthority;\n",
    });
    expect(receiptIssuer.exitCode).toBe(1);
    expect(receiptIssuer.stderr.toString()).toContain(
      'filesystem observation authority issuer must only be called by the Workspace Pipeline dispatcher',
    );
  });

  test('keeps Tool dispatch stage authority inside the dispatch issuer and receipt verifier', () => {
    const accepted = fixture({
      'src/core/execution/tool-pipeline/dispatch-authority.ts':
        'export const issueAcknowledgedRecordedInvocation = true;\nexport const assertAuthority = true;\n',
      'src/core/execution/tool-pipeline/dispatch.ts':
        "import { issueAcknowledgedRecordedInvocation } from './dispatch-authority';\nvoid issueAcknowledgedRecordedInvocation;\n",
      'src/core/execution/tool-pipeline/receipt.ts':
        "import { assertAuthority } from './dispatch-authority';\nvoid assertAuthority;\n",
    });
    expect(accepted.exitCode).toBe(0);

    const rejectedImport = fixture({
      'src/core/execution/tool-pipeline/dispatch-authority.ts':
        'export const assertAuthority = true;\n',
      'src/core/controllers/invalid.ts':
        "import { assertAuthority } from '@/core/execution/tool-pipeline/dispatch-authority';\nvoid assertAuthority;\n",
    });
    expect(rejectedImport.exitCode).toBe(1);
    expect(rejectedImport.stderr.toString()).toContain(
      'Tool dispatch stage authority must stay inside its issuer and receipt verifier',
    );

    const rejectedIssuer = fixture({
      'src/core/execution/tool-pipeline/dispatch-authority.ts':
        'export const issueAdapterDispatchedOutcome = true;\n',
      'src/core/execution/tool-pipeline/receipt.ts':
        "import { issueAdapterDispatchedOutcome } from './dispatch-authority';\nvoid issueAdapterDispatchedOutcome;\n",
    });
    expect(rejectedIssuer.exitCode).toBe(1);
    expect(rejectedIssuer.stderr.toString()).toContain(
      'Tool dispatch stage authority issuers must only be called by the dispatch adapter',
    );
  });

  test('rejects legacy concrete filesystem imports from all production execution consumers', () => {
    const result = fixture({
      'src/core/tools/file.ts': 'export const readFile = () => {};\n',
      'src/core/tools/search.ts': 'export const searchFiles = () => {};\n',
      'src/core/harness/read-file-invalid.ts':
        "import { readFile } from '@/core/tools/file';\nvoid readFile;\n",
      'src/core/harness/invalid.ts': "export { searchFiles } from '../tools/search.ts';\n",
      'src/core/controllers/invalid.ts': "export const load = () => import('../tools/file.js');\n",
      'src/core/execution/tool-pipeline/invalid.ts':
        "export const search = require('../../tools/search');\n",
      'src/core/execution/workspace-filesystem/local-provider.ts':
        "import { readFile } from '../../tools/file';\nvoid readFile;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      'workspace filesystem consumers must not import legacy concrete file or search tools',
    );
    expect(stderr).toContain('@/core/tools/file');
    expect(stderr).toContain('../tools/search.ts');
    expect(stderr).toContain('../tools/file.js');
    expect(stderr).toContain('../../tools/search');
    expect(stderr).toContain('../../tools/file');
  });

  test('rejects Node filesystem access in legacy modules and execution consumers', () => {
    const result = fixture({
      'src/core/tools/file.ts': "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n",
      'src/core/tools/search.ts': "export const loadFs = () => import('node:fs/promises');\n",
      'src/core/controllers/invalid.ts': "const fs = require('node:fs');\nvoid fs;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      'capability filesystem Node fs access must stay inside LocalFilesystemProvider',
    );
    expect(stderr).toContain('node:fs');
    expect(stderr).toContain('node:fs/promises');
  });

  test('allows trusted infrastructure to use Node filesystem primitives', () => {
    const result = fixture({
      'src/core/runtime/store.ts': "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n",
      'src/core/persistence/capability-artifacts.ts':
        "import { openSync } from 'node:fs';\nvoid openSync;\n",
      'src/core/model/project-instructions.ts':
        "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
  });

  test('rejects production imports of test helper providers', () => {
    const result = fixture({
      'tests/helpers/fake-workspace-filesystem-provider.ts': 'export const fakeProvider = {};\n',
      'src/core/execution/tool-pipeline/invalid.ts':
        "export { fakeProvider } from '../../../../tests/helpers/fake-workspace-filesystem-provider.ts';\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'production source must not import test helper providers',
    );
  });

  test('rejects direct Model transport and legacy invocation imports', () => {
    const result = fixture({
      'src/core/model/transport.ts': 'export const dispatch = () => {};\n',
      'src/core/model/invoke.ts': 'export const legacy = () => {};\n',
      'src/core/controllers/invalid.ts':
        "import { dispatch } from '../model/transport';\nimport { legacy } from '../model/invoke';\nvoid dispatch; void legacy;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      'model transport must stay behind the Gateway-owned live ModelResponseSource',
    );
    expect(stderr).toContain('legacy model invocation bypass is forbidden');
  });

  test('rejects Provider SDK dispatch imports outside the single-attempt transport', () => {
    const result = fixture({
      'scripts/invalid.ts':
        "import { generateText as dispatch, streamText } from 'ai';\nvoid dispatch; void streamText;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'Provider SDK dispatch must stay behind ModelInvocationGateway transport',
    );
  });

  test('rejects namespace Provider SDK dispatch outside the single-attempt transport', () => {
    const result = fixture({
      'src/core/invalid.ts':
        "import * as sdk from 'ai';\nvoid sdk.generateText({});\nvoid sdk.streamObject({});\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'Provider SDK dispatch must stay behind ModelInvocationGateway transport',
    );
  });

  test('rejects low-level LanguageModel dispatch outside the single-attempt transport', () => {
    const result = fixture({
      'src/core/invalid.ts':
        'declare const model: { doGenerate(input: unknown): unknown };\nvoid model.doGenerate({});\n',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'Provider SDK dispatch must stay behind ModelInvocationGateway transport',
    );
  });

  test('accepts only the Gateway-owned live Source-to-transport-to-SDK dispatch direction', () => {
    const result = fixture({
      'src/core/model/transport.ts':
        "import { generateText, streamText } from 'ai';\nexport { generateText, streamText };\n",
      'src/core/model/response-source.ts':
        "import { generateText } from './transport';\nexport const gateway = generateText;\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
  });

  test('rejects direct Gateway-to-transport imports after response source cutover', () => {
    const result = fixture({
      'src/core/model/transport.ts': 'export const dispatch = () => {};\n',
      'src/core/model/invocation-gateway.ts':
        "import { dispatch } from './transport';\nexport const gateway = dispatch;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'model transport must stay behind the Gateway-owned live ModelResponseSource',
    );
  });

  test('accepts the intended app to Core to protocol direction', () => {
    const result = fixture({
      'src/protocol/dto.ts': 'export interface DTO { value: string }\n',
      'src/core/service.ts':
        "import type { DTO } from '@/protocol/dto';\nexport type Value = DTO;\n",
      'src/app/main.ts':
        "import type { Value } from '@/core/service';\nexport type AppValue = Value;\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
  });
});
