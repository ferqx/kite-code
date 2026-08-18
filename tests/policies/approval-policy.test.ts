import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandGrantKey,
  hasSameCommandGrant,
  normalizeAuthorizationState,
  stableStringify,
} from '@/core/harness/tool-policy';
import {
  classifyShellRisk,
  type EvaluateToolApprovalParams,
  evaluateToolApproval,
  isDestructiveShellCommand,
} from '@/core/policies/approval-policy';

// ── Test helpers / 测试辅助 ──

function baseParams(overrides?: Partial<EvaluateToolApprovalParams>): EvaluateToolApprovalParams {
  return {
    toolName: 'shell_execute',
    toolArgs: { command: 'echo hello' },
    phase: 'building',
    workspace: '/tmp/test',
    threadId: 'thread-1',
    ...overrides,
  };
}

// ── classifyShellRisk / 命令风险分类 ──

describe('classifyShellRisk', () => {
  it('classifies policy-proven shell inspection as read', () => {
    expect(classifyShellRisk('ls -la')).toBe('read');
  });

  it('classifies destructive commands as destructive', () => {
    expect(classifyShellRisk('rm -rf /tmp/foo')).toBe('destructive');
  });

  it('classifies git mutations as vcs_mutation', () => {
    expect(classifyShellRisk('git push origin main')).toBe('vcs_mutation');
  });

  it('classifies file writes as write_file', () => {
    expect(classifyShellRisk('cp file1 file2')).toBe('write_file');
  });

  it('classifies network commands as network', () => {
    expect(classifyShellRisk('curl https://example.com')).toBe('network');
  });

  it('classifies unknown commands as execute_code', () => {
    expect(classifyShellRisk('node script.js')).toBe('execute_code');
  });
});

// ── isDestructiveShellCommand / 破坏性命令检测 ──

describe('isDestructiveShellCommand', () => {
  it('detects rm -rf', () => {
    expect(isDestructiveShellCommand('rm -rf /')).toBe(true);
  });

  it('detects sudo commands', () => {
    expect(isDestructiveShellCommand('sudo rm file')).toBe(true);
  });

  it('detects chmod recursive', () => {
    expect(isDestructiveShellCommand('chmod -R 777 /')).toBe(true);
  });

  it('allows normal ls', () => {
    expect(isDestructiveShellCommand('ls -la')).toBe(false);
  });

  it('allows echo', () => {
    expect(isDestructiveShellCommand('echo hello')).toBe(false);
  });

  it('detects dd to /dev/', () => {
    expect(isDestructiveShellCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('detects mkfs', () => {
    expect(isDestructiveShellCommand('mkfs.ext4 /dev/sda1')).toBe(true);
  });

  it('detects shutdown', () => {
    expect(isDestructiveShellCommand('shutdown now')).toBe(true);
  });

  it('detects fork bomb pattern', () => {
    expect(isDestructiveShellCommand(':(){ :|:& };:')).toBe(true);
  });
});

// ── stableStringify / 确定性序列化 ──

describe('stableStringify', () => {
  it('stable-serializes objects with sorted keys', () => {
    const a = stableStringify({ b: 2, a: 1 });
    const b2 = stableStringify({ a: 1, b: 2 });
    expect(a).toBe(b2);
  });

  it('stable-serializes nested objects', () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, x: 3 })).toBe(
      stableStringify({ x: 3, z: { a: 2, b: 1 } }),
    );
  });
});

// ── commandGrantKey / same_command 授权 key ──

describe('commandGrantKey', () => {
  it('generates same key for same input', () => {
    const k1 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'ls' });
    const k2 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'ls' });
    expect(k1).toBe(k2);
  });

  it('generates different keys for different commands', () => {
    const k1 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'ls' });
    const k2 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'rm' });
    expect(k1).not.toBe(k2);
  });
});

// ── normalizeAuthorizationState / 授权状态规范化 ──

describe('normalizeAuthorizationState', () => {
  it('defaults null to default mode', () => {
    expect(normalizeAuthorizationState(null).mode).toBe('default');
  });

  it('preserves full_access mode', () => {
    expect(normalizeAuthorizationState({ mode: 'full_access', commandGrants: {} }).mode).toBe(
      'full_access',
    );
  });

  it('adds empty commandGrants if missing', () => {
    const result = normalizeAuthorizationState({ mode: 'default', commandGrants: {} });
    expect(result).toEqual({ mode: 'default', commandGrants: {} });
  });
});

// ── hasSameCommandGrant / same_command 授权检查 ──

describe('hasSameCommandGrant', () => {
  it('returns true for matching grant', () => {
    const key = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'npm test' });
    const auth = {
      mode: 'default' as const,
      commandGrants: {
        [key]: {
          workspace: '/ws',
          threadId: 't1',
          command: 'npm test',
          source: 'test' as const,
          grantedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    expect(
      hasSameCommandGrant(auth, { workspace: '/ws', threadId: 't1', command: 'npm test' }),
    ).toBe(true);
  });

  it('returns false for mismatched command', () => {
    const key = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'npm test' });
    const auth = {
      mode: 'default' as const,
      commandGrants: {
        [key]: {
          workspace: '/ws',
          threadId: 't1',
          command: 'npm test',
          source: 'test' as const,
          grantedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    expect(hasSameCommandGrant(auth, { workspace: '/ws', threadId: 't1', command: 'other' })).toBe(
      false,
    );
  });
});

// ── evaluateToolApproval / 工具审批评估 ──

describe('evaluateToolApproval', () => {
  // ── Read tools / 只读工具 ──
  describe('read tools', () => {
    it('allows read_file with workspace path', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'read_file', toolArgs: { path: 'foo.txt' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.decision).toBe('allow');
      expect(result.risk).toBe('read');
    });

    it('allows read_file with an absolute path outside workspace by default', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'read_file', toolArgs: { path: '/f' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.decision).toBe('allow');
      expect(result.risk).toBe('read');
      expect(result.effects).toBeUndefined();
    });

    it('allows an absolute workspace file reached through a filesystem alias', () => {
      if (process.platform === 'win32') return;
      const root = mkdtempSync(join(tmpdir(), 'kite-policy-path-alias-'));
      const workspace = join(root, 'workspace');
      const alias = join(root, 'workspace-alias');
      try {
        mkdirSync(workspace);
        writeFileSync(join(workspace, 'data.txt'), 'inside');
        symlinkSync(workspace, alias, 'dir');

        const result = evaluateToolApproval(
          baseParams({
            toolName: 'read_file',
            toolArgs: { path: join(alias, 'data.txt') },
            workspace,
          }),
        );

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(false);
        expect(result.effects?.externalRead).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('allows search_content', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'search_content', toolArgs: { pattern: 'foo' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('allows search_content with an absolute path outside workspace by default', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'search_content', toolArgs: { pattern: 'foo', path: '/etc' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.decision).toBe('allow');
      expect(result.effects).toBeUndefined();
    });

    it('allows search_files', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'search_files', toolArgs: { pattern: '*.ts' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('allows a Registry-classified read-only capability during planning', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'tool_search', toolArgs: { query: 'database' }, phase: 'planning' }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });

    it('allows search_files with an absolute path outside workspace by default', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'search_files', toolArgs: { pattern: '*.txt', path: '/tmp' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.decision).toBe('allow');
      expect(result.effects).toBeUndefined();
    });
  });

  // ── MSYS2 path normalization (Windows only) / MSYS2 路径归一化 ──
  // Windows 上 MSYS2 形式路径（/c/proj/...）必须先归一化再判断外部性，
  // 否则 resolve() 会把它挂到当前盘符，工作区内路径被误判为外部。
  // On Windows, MSYS2-style paths must be normalized before the external
  // check; otherwise resolve() roots them at the current drive and
  // in-workspace paths are misclassified as external.
  const describeWin32 = process.platform === 'win32' ? describe : describe.skip;

  describeWin32('MSYS2-style path normalization', () => {
    const workspace = 'C:\\proj';

    it('treats in-workspace MSYS2 paths as internal for search tools', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'search_files',
          toolArgs: { pattern: '*.ts', path: '/c/proj/src' },
          workspace,
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.effects?.externalRead).toBeUndefined();
    });

    it('allows read-only MSYS2 paths outside the workspace', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'search_content',
          toolArgs: { pattern: 'foo', path: '/d/elsewhere' },
          workspace,
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.effects).toBeUndefined();
    });

    it('treats in-workspace MSYS2 paths as internal for write tools', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'write_file',
          toolArgs: { path: '/c/proj/out.txt', content: 'x' },
          workspace,
        }),
      );
      // write_file 始终需要审批，但工作区内路径不应带 externalWrite effect
      // write_file always requires approval, but in-workspace paths must not
      // carry the externalWrite effect.
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.effects?.externalWrite).toBeUndefined();
    });

    it('flags MSYS2 paths outside the workspace as external writes', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'edit_file',
          toolArgs: { path: '/d/other/file.txt' },
          workspace,
        }),
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalWrite: true });
    });
  });

  // 非 Windows 平台契约：msys2ToWindowsPath 透传，'/c/proj' 是真正的外部
  // 绝对路径，但只读文件工具仍默认放行。该用例在 Linux CI 上运行。
  // Off-Windows contract: msys2ToWindowsPath is a no-op, so '/c/proj' is a
  // genuine external absolute path and remains readable without approval.
  const describeNonWin32 = process.platform !== 'win32' ? describe : describe.skip;

  describeNonWin32('MSYS2 normalization is a no-op off Windows', () => {
    it('still allows /c/... external reads on non-Windows platforms', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'search_files',
          toolArgs: { pattern: '*.ts', path: '/c/proj/src' },
          workspace: '/tmp/test',
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.effects).toBeUndefined();
    });
  });

  // ── Plan tools / 计划工具 ──
  describe('plan tools', () => {
    it('allows update_plan', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'update_plan', toolArgs: { plan: {} } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('plan');
    });

    it('allows ask_user', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'ask_user', toolArgs: { question: 'what?' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.risk).toBe('plan');
    });
  });

  // ── Shell commands / Shell 命令 ──
  describe('shell_execute', () => {
    it('allows read-only shell commands directly', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'ls -la' } }));
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });

    it('allows policy-proven read-only shell inspection during planning', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'pwd' }, phase: 'planning' }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
      expect(result.phaseConstraint).toBeUndefined();
    });

    it('requires approval for shell reads outside the workspace', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'cat /tmp/kite-approved-read.txt' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalRead: true });
    });

    it('detects an external read through an attached input redirection', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'cat </tmp/kite-approved-read.txt' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalRead: true });
    });

    it('keeps an in-workspace ripgrep pattern file on the read-only fast path', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'rg -f patterns.txt src' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });

    it.each([
      'rg -f /tmp/kite-patterns src',
      'rg --file=/tmp/kite-patterns src',
    ])('requires approval for an external ripgrep pattern file: %s', (command) => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command } }));
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalRead: true });
    });

    it.each([
      'grep -f /tmp/kite-patterns src',
      'grep --file=/tmp/kite-patterns src',
      'file -m /tmp/kite-magic input.txt',
      'file --magic-file=/tmp/kite-magic input.txt',
      'sort --random-source /tmp/kite-seed input.txt',
      'sort --random-source=/tmp/kite-seed input.txt',
    ])('requires approval for a read-only command with an external option file: %s', (command) => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command } }));
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalRead: true });
    });

    it('denies protected path reads before opening an approval', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'cat ~/.ssh/id_ed25519' } }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it('requires approval for write-like shell commands', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'cp a b' } }));
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('denies destructive shell commands', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'rm -rf /etc/nginx' } }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
      expect(result.risk).toBe('destructive');
    });

    it('denies rm -rf . (workspace root)', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'rm -rf .' } }));
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
      expect(result.risk).toBe('destructive');
    });

    it('downgrades rm -rf on workspace subdirectories to write_file', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'rm -rf node_modules' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('write_file');
      expect(result.decision).toBe('ask');
    });

    it('downgrades rm -rf on temp paths to write_file', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'rm -rf /tmp/build' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('write_file');
      expect(result.decision).toBe('ask');
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('downgrades rm -rf on other non-critical paths to write_file', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'rm -rf /opt/cache' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('write_file');
      expect(result.decision).toBe('ask');
    });

    it('does not open approval for a downgraded removal during planning', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'rm -rf /tmp/build' },
          phase: 'planning',
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.phaseConstraint).toBe('planning');
    });

    it('denies empty shell commands', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: '' } }));
      expect(result.allowed).toBe(false);
    });

    it('allows network-aware shell with approval', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'curl example.com' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('network');
      expect(result.effects).toEqual({ network: true });
    });

    it('marks remote git operations as network access', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'git push origin main' } }),
      );
      expect(result.risk).toBe('vcs_mutation');
      expect(result.effects).toEqual({ network: true });
    });

    it('marks dependency installation as network access', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'bun install' } }));
      expect(result.risk).toBe('write_file');
      expect(result.effects).toEqual({ network: true, uncertainEffects: true });
    });

    it('projects filesystem effects for network clients that write without redirection', () => {
      expect(
        evaluateToolApproval(
          baseParams({ toolArgs: { command: 'curl -o /tmp/out https://example.com' } }),
        ).effects,
      ).toEqual({ network: true, externalWrite: true });
      expect(
        evaluateToolApproval(
          baseParams({ toolArgs: { command: 'wget -O /tmp/out https://example.com' } }),
        ).effects,
      ).toEqual({ network: true, externalWrite: true });
      expect(
        evaluateToolApproval(
          baseParams({
            toolArgs: {
              command:
                'curl.exe --output schannel-smoke.html --write-out APPROVED_SCHANNEL_OK https://example.com/',
            },
          }),
        ).effects,
      ).toEqual({ network: true });
      expect(
        evaluateToolApproval(
          baseParams({
            toolArgs: {
              command:
                'curl -sS -o /dev/null -w "HTTP_CODE:%{http_code} TIME:%{time_total}" https://example.com/',
            },
          }),
        ).effects,
      ).toEqual({ network: true });
      expect(
        evaluateToolApproval(baseParams({ toolArgs: { command: 'scp host:/file /tmp/out' } }))
          .effects,
      ).toEqual({ network: true, uncertainEffects: true });
      expect(
        evaluateToolApproval(
          baseParams({
            toolArgs: {
              command: 'curl -w "$(touch escaped)" https://example.com/',
            },
          }),
        ).effects,
      ).toEqual({ network: true, uncertainEffects: true });
    });

    it('keeps uncertain filesystem effects on mixed network and external-write commands', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'touch /tmp/output.txt; curl example.com' } }),
      );
      expect(result.effects).toEqual({ network: true, uncertainEffects: true });
    });

    it('marks writes outside the workspace for approval', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'touch ../outside.txt' } }),
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('treats Windows-style relative write paths as inside the workspace', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'touch nested\\output.txt' } }),
      );
      expect(result.effects).toEqual({});
    });

    it('marks unprovable scripts as uncertain', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'node script.js' } }));
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ uncertainEffects: true });
    });

    it('keeps local Git mutations inside the workspace filesystem lane', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'git commit -m update' } }),
      );

      expect(result.effects).toEqual({});
    });
  });

  // ── Write tools / 写工具 ──
  describe('write_file / edit_file', () => {
    it('requires approval for write_file in building phase', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '/tmp/f' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('write_file');
    });

    it('requires approval for edit_file', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'edit_file', toolArgs: { path: '/tmp/f' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('denies write_file during planning phase', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '/tmp/f' }, phase: 'planning' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
      expect(result.requiresApproval).toBe(false);
      expect(result.userVisibleSummary).toBe(
        'Plan mode is read-only. No file was written. Describe the intended change in the plan and apply it after plan approval.',
      );
    });

    it('explains that edit_file cannot be approved during planning', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'edit_file', toolArgs: { path: 'src/a.ts' }, phase: 'planning' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.userVisibleSummary).toBe(
        'Plan mode is read-only. No file was edited. Describe the intended change in the plan and apply it after plan approval.',
      );
    });

    it('sets externalWrite effect for absolute paths', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '/tmp/external.txt' } }),
      );
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('sets externalWrite effect for home-directory paths', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '~/external.txt' } }),
      );
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('treats a home-relative target inside the trusted workspace as workspace-local', () => {
      const workspace = join(homedir(), 'trusted-project');
      const result = evaluateToolApproval(
        baseParams({
          workspace,
          toolName: 'write_file',
          toolArgs: { path: '~/trusted-project/inside.txt' },
        }),
      );
      expect(result.effects).toBeUndefined();
      expect(result.userVisibleSummary).toContain('workspace file');
    });

    it('does NOT set externalWrite effect for relative paths', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: 'src/foo.ts' } }),
      );
      expect(result.effects).toBeUndefined();
    });

    it('sets externalWrite effect for edit_file with absolute path', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'edit_file', toolArgs: { path: '/etc/config' } }),
      );
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('treats relative traversal as an external write requiring approval', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '../outside.txt' } }),
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('routes an external protected-looking file write through approval instead of hard denial', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '~/.ssh/authorized_keys' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.decision).toBe('ask');
      expect(result.effects).toEqual({ externalWrite: true });
    });

    it('allows reading a symlink whose canonical target has a protected-looking name', () => {
      const workspace = mkdtempSync(join(tmpdir(), 'approval-protected-link-'));
      try {
        writeFileSync(join(workspace, '.env'), 'SECRET=value');
        try {
          symlinkSync(join(workspace, '.env'), join(workspace, 'ordinary.txt'));
        } catch (error) {
          // A non-elevated Windows account without Developer Mode cannot create
          // file symlinks. This is host capability absence, not policy behavior.
          if (
            process.platform === 'win32' &&
            error instanceof Error &&
            'code' in error &&
            error.code === 'EPERM'
          ) {
            return;
          }
          throw error;
        }
        const result = evaluateToolApproval(
          baseParams({
            workspace,
            toolName: 'read_file',
            toolArgs: { path: 'ordinary.txt' },
          }),
        );
        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(false);
        expect(result.decision).toBe('allow');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('marks external path in userVisibleSummary', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '/tmp/f' } }),
      );
      expect(result.userVisibleSummary).toContain('external');
    });
  });

  // ── web_fetch / 网络请求 ──
  describe('web_fetch', () => {
    it('marks valid web_fetch URLs as network access without imposing a mode decision', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'web_fetch', toolArgs: { url: 'https://example.com' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.effects).toEqual({ network: true });
    });

    it('denies URLs with embedded credentials', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'web_fetch',
          toolArgs: { url: 'https://user:pass@example.com' },
        }),
      );
      expect(result.allowed).toBe(false);
    });

    it('denies URLs with token in query string', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'web_fetch',
          toolArgs: { url: 'https://example.com?token=abcdef123456789012345' },
        }),
      );
      expect(result.allowed).toBe(false);
    });

    it('denies invalid URLs', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'web_fetch', toolArgs: { url: 'not-a-url' } }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ── Authorization / 授权 ──
  describe('authorization', () => {
    it('allows write_file under full_access without approval', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'write_file',
          toolArgs: { path: '/tmp/f' },
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.grantUsed).toBe('full_access');
    });

    it('allows shell under same_command grant', () => {
      const key = commandGrantKey({
        workspace: '/tmp/test',
        threadId: 'thread-1',
        command: 'npm test',
      });
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'npm test' },
          authorization: {
            mode: 'default',
            commandGrants: {
              [key]: {
                workspace: '/tmp/test',
                threadId: 'thread-1',
                command: 'npm test',
                source: 'test' as const,
                grantedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.grantUsed).toBe('same_command');
    });

    it('still denies destructive commands under full_access', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'rm -rf /' },
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it('denies non-read shell during planning phase regardless of auth', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'npm test' },
          phase: 'planning',
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.phaseConstraint).toBe('planning');
    });

    it.each([
      'git branch new-branch',
      'git branch -d old-branch',
      'git diff --output=leak.diff',
      "rg --pre 'touch pwned' needle src",
      "sed -e 'w leaked.txt' input.txt",
      'find . -fprint leaked.txt',
      'sort -o sorted.txt input.txt',
      'uniq input.txt output.txt',
      'echo victim.txt | xargs sed -i s/x/y/',
      'file -C -m magic',
      'file -z archive.gz',
      'file -p input.txt',
      'file --preserve-date input.txt',
      'sort {--output=sorted.txt,input.txt}',
    ])('does not admit an effectful command as planning inspection: %s', (command) => {
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command },
          phase: 'planning',
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.phaseConstraint).toBe('planning');
    });
  });

  // ── Sub-agent / 子 agent ──
  describe('task (sub-agent)', () => {
    it('allows explore sub-agent in planning phase', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'task',
          toolArgs: { subagent_type: 'explore', description: 'search' },
          phase: 'planning',
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it('denies non-read sub-agent in planning phase', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'task',
          toolArgs: { subagent_type: 'general-purpose', description: 'fix' },
          phase: 'planning',
        }),
      );
      expect(result.allowed).toBe(false);
    });

    it('denies disclosed code and review roles in planning while allowing plan', () => {
      for (const subagentType of ['code', 'review']) {
        const result = evaluateToolApproval(
          baseParams({
            toolName: 'task',
            toolArgs: { subagent_type: subagentType, task: 'Inspect or change the architecture.' },
            phase: 'planning',
          }),
        );
        expect(result.allowed).toBe(false);
        expect(result.requiresApproval).toBe(false);
        expect(result.phaseConstraint).toBe('planning');
      }
      expect(
        evaluateToolApproval(
          baseParams({
            toolName: 'task',
            toolArgs: { subagent_type: 'plan', task: 'Plan the architecture change.' },
            phase: 'planning',
          }),
        ).allowed,
      ).toBe(true);
    });
  });

  // ── MCP tools / MCP 工具 ──
  describe('MCP tools', () => {
    it('requires approval for MCP tools by default', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'mcp__server__tool', toolArgs: {} }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('mcp');
    });

    it('keeps unknown MCP tools behind approval under full_access', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'mcp__server__tool',
          toolArgs: {},
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('allows MCP tools only with a bound local read policy', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'mcp__server__tool',
          toolArgs: {},
          mcpPolicy: {
            effects: { filesystem: 'read', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });

    it('allows a bound read-only MCP tool during planning', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'mcp__server__read',
          toolArgs: {},
          phase: 'planning',
          mcpPolicy: {
            effects: { filesystem: 'read', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });

    it('keeps MCP tools behind approval when any effect dimension can write', () => {
      const writePolicies = [
        { filesystem: 'write', network: 'read', externalState: 'read' },
        { filesystem: 'read', network: 'write', externalState: 'read' },
        { filesystem: 'read', network: 'read', externalState: 'write' },
      ] as const;

      for (const effects of writePolicies) {
        const result = evaluateToolApproval(
          baseParams({
            toolName: 'mcp__server__tool',
            toolArgs: {},
            mcpPolicy: { effects, minimumApproval: 'none' },
          }),
        );
        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(true);
        expect(result.risk).toBe('mcp');
      }
    });

    it('rejects a side-effectful MCP tool with actionable planning guidance', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'mcp__server__write',
          toolArgs: {},
          phase: 'planning',
          mcpPolicy: {
            effects: { filesystem: 'write', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
          },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.phaseConstraint).toBe('planning');
      expect(result.userVisibleSummary).toBe(
        'Plan mode is read-only. This operation did not run and cannot be approved while planning. Use read-only inspection or describe the intended implementation in the plan, then run it after plan approval.',
      );
    });
  });

  // ── read_mcp_resource / MCP 资源读取 ──
  describe('read_mcp_resource', () => {
    it('marks externally managed resource reads without imposing a mode decision', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'read_mcp_resource',
          toolArgs: { server: 'srv', uri: 'resource://x' },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
      expect(result.effects).toBeUndefined();
    });
  });

  // ── Unknown tools / 未知工具 ──
  describe('unknown tools', () => {
    it('denies unknown tool names', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'nonexistent_tool', toolArgs: {} }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });
  });
});
