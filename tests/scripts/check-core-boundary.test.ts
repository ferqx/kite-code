import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
const checker = resolve(import.meta.dir, '../../scripts/check-core-boundary.ts');

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
  test('rejects protocol imports from Core', () => {
    const result = fixture({
      'src/protocol/invalid.ts': "import type { RuntimeEvent } from '@/core/runtime/events';\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('protocol must not import core or app');
  });

  test('rejects multiline and relative protocol imports from Core', () => {
    const result = fixture({
      'src/core/runtime/events.ts': 'export interface RuntimeEvent {}\n',
      'src/protocol/invalid.ts':
        "import {\n  type RuntimeEvent,\n} from '../core/runtime/events';\nexport type Event = RuntimeEvent;\n",
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

  test('rejects Registry dispatch outside the governed invocation boundary', () => {
    const result = fixture({
      'src/core/controllers/invalid.ts': 'dispatchRegisteredTool(spec, input, context);\n',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'ToolSpec dispatch must stay behind invokeGovernedTool',
    );
  });

  test('rejects aliased and parenthesized Registry dispatch', () => {
    const result = fixture({
      'src/core/tools/registry/dispatch.ts':
        'export function dispatchRegisteredTool(..._args: unknown[]) {}\n',
      'src/core/controllers/invalid.ts':
        "import { dispatchRegisteredTool as dispatch } from '../tools/registry/dispatch';\n(dispatch) /* boundary bypass */ (spec, input, context);\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'ToolSpec dispatch must stay behind invokeGovernedTool',
    );
  });

  test('rejects direct concrete ToolSpec projection outside the governed boundary', () => {
    const result = fixture({
      'src/core/tools/registry/builtins/task.ts':
        'export const taskSpec = { projectResult() {} };\n',
      'src/core/controllers/invalid.ts':
        "import { taskSpec } from '../tools/registry/builtins/task';\ntaskSpec.projectResult(output, context);\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'ToolSpec dispatch must stay behind invokeGovernedTool',
    );
  });

  test('rejects concrete Tool Provider imports outside the Pipeline dispatch adapter', () => {
    const result = fixture({
      'src/core/controllers/invalid.ts':
        "import { invokeGovernedTool } from '@/core/harness/tool-runner';\nvoid invokeGovernedTool;\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'concrete Tool Provider imports must stay behind Tool Pipeline dispatch adapter',
    );
  });

  test('rejects extension-qualified concrete Tool Provider imports', () => {
    const result = fixture({
      'src/core/controllers/invalid.ts':
        "export { invokeGovernedTool } from '../harness/tool-runner.ts';\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'concrete Tool Provider imports must stay behind Tool Pipeline dispatch adapter',
    );
  });

  test('accepts concrete Tool Provider imports in the Pipeline dispatch adapter', () => {
    const result = fixture({
      'src/core/execution/tool-pipeline/dispatch.ts':
        "import { invokeGovernedTool } from '@/core/harness/tool-runner';\nexport const dispatch = invokeGovernedTool;\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
  });

  test('rejects direct Model transport and legacy invocation imports', () => {
    const result = fixture({
      'src/core/model/transport.ts': 'export const dispatch = () => {};\n',
      'src/core/model/invoke.ts': 'export const legacy = () => {};\n',
      'src/core/controllers/invalid.ts':
        "import { dispatch } from '@/core/model/transport';\nimport { legacy } from '../model/invoke';\nvoid dispatch; void legacy;\n",
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain('model transport must stay behind ModelInvocationGateway');
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

  test('accepts the Gateway-to-transport-to-SDK dispatch direction', () => {
    const result = fixture({
      'src/core/model/transport.ts':
        "import { generateText, streamText } from 'ai';\nexport { generateText, streamText };\n",
      'src/core/model/invocation-gateway.ts':
        "import { generateText } from './transport';\nexport const gateway = generateText;\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Core boundary checks passed.');
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
