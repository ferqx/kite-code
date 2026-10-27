import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type DocumentationMap,
  documentationPatternError,
  evaluateDocumentationImpact,
  isCurrentDocumentation,
  matchesDocumentationPattern,
  parseDocumentationImpactOptions,
} from '../../scripts/check-docs-impact';

const map: DocumentationMap = {
  version: 2,
  rules: [
    {
      id: 'runtime',
      sources: ['src/core/runtime/**'],
      authorities: ['packages/runtime/README.md', 'docs/active/runtime.md'],
    },
  ],
};

const repositoryMap = JSON.parse(
  readFileSync(new URL('../../docs/documentation-map.json', import.meta.url), 'utf8'),
) as DocumentationMap;

function triggeredRepositoryRules(path: string): string[] {
  return evaluateDocumentationImpact([path], repositoryMap).map((failure) => failure.ruleId);
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(child) : [child];
  });
}

describe('documentation impact gate V2', () => {
  it('matches only exact paths and terminal directory prefixes', () => {
    expect(
      matchesDocumentationPattern('src\\core\\runtime\\kernel.ts', 'src/core/runtime/**'),
    ).toBe(true);
    expect(matchesDocumentationPattern('src/core/runtime.ts', 'src/core/runtime/**')).toBe(false);
    expect(matchesDocumentationPattern('./src/protocol/events.ts', 'src/protocol/events.ts')).toBe(
      true,
    );
    expect(matchesDocumentationPattern('src/core/runtime/kernel.ts', 'src/**/kernel.ts')).toBe(
      false,
    );
    expect(documentationPatternError('tests/runtime/fault-*.test.ts')).toContain('terminal /**');
    expect(documentationPatternError('packages/**/src/**')).toContain('terminal /**');
    expect(documentationPatternError('')).toContain('empty');
  });

  it('reports all mapped documents and records which ones changed', () => {
    expect(evaluateDocumentationImpact(['src/core/runtime/kernel.ts'], map)).toEqual([
      {
        ruleId: 'runtime',
        sources: ['src/core/runtime/kernel.ts'],
        authorities: ['packages/runtime/README.md', 'docs/active/runtime.md'],
        changedAuthorities: [],
      },
    ]);
    expect(
      evaluateDocumentationImpact(
        ['src/core/runtime/kernel.ts', 'packages/runtime/README.md'],
        map,
      ),
    ).toEqual([
      {
        ruleId: 'runtime',
        sources: ['src/core/runtime/kernel.ts'],
        authorities: ['packages/runtime/README.md', 'docs/active/runtime.md'],
        changedAuthorities: ['packages/runtime/README.md'],
      },
    ]);
  });

  it('reports every overlapping rule to converge independently', () => {
    const overlapping: DocumentationMap = {
      version: 2,
      rules: [
        {
          id: 'package',
          sources: ['packages/runtime/**'],
          authorities: ['packages/runtime/README.md'],
        },
        {
          id: 'security',
          sources: ['packages/runtime/security/**'],
          authorities: ['docs/active/security.md'],
        },
      ],
    };
    expect(
      evaluateDocumentationImpact(
        ['packages/runtime/security/policy.ts', 'packages/runtime/README.md'],
        overlapping,
      ),
    ).toEqual([
      {
        ruleId: 'package',
        sources: ['packages/runtime/security/policy.ts', 'packages/runtime/README.md'],
        authorities: ['packages/runtime/README.md'],
        changedAuthorities: ['packages/runtime/README.md'],
      },
      {
        ruleId: 'security',
        sources: ['packages/runtime/security/policy.ts'],
        authorities: ['docs/active/security.md'],
        changedAuthorities: [],
      },
    ]);
  });

  it('honors exact exclusions and ignores documentation-only changes', () => {
    const withExclusion: DocumentationMap = {
      version: 2,
      rules: [
        {
          id: 'runtime',
          sources: ['src/core/runtime/**'],
          excludeSources: ['src/core/runtime/internal.ts'],
          authorities: ['docs/active/runtime.md'],
        },
      ],
    };
    expect(evaluateDocumentationImpact(['src/core/runtime/internal.ts'], withExclusion)).toEqual(
      [],
    );
    expect(evaluateDocumentationImpact(['docs/active/runtime.md'], withExclusion)).toEqual([]);
  });

  it('parses all, staged, and range scopes with an explicit base', () => {
    expect(parseDocumentationImpactOptions([], {})).toEqual({ scope: 'all' });
    expect(parseDocumentationImpactOptions(['--scope=staged'], {})).toEqual({
      scope: 'staged',
    });
    expect(parseDocumentationImpactOptions(['--scope=range', '--base=origin/main'], {})).toEqual({
      scope: 'range',
      base: 'origin/main',
    });
    expect(
      parseDocumentationImpactOptions(['--scope=range'], { DOCS_IMPACT_BASE: 'abc123' }),
    ).toEqual({ scope: 'range', base: 'abc123' });
    expect(() => parseDocumentationImpactOptions(['--scope=range'], {})).toThrow('requires');
    expect(() => parseDocumentationImpactOptions(['--scope=unknown'], {})).toThrow('unsupported');
  });

  it('keeps every repository mapping target on a current authority surface', () => {
    expect(repositoryMap.version).toBe(2);
    expect(repositoryMap.rules.length).toBeGreaterThan(0);
    for (const rule of repositoryMap.rules) {
      expect(rule.sources.length).toBeGreaterThan(0);
      expect(rule.authorities.length).toBeGreaterThan(0);
      expect(rule.authorities.every(isCurrentDocumentation)).toBe(true);
      expect(
        rule.authorities.some((authority) =>
          /docs\/(adr|book|space|design|deprecated)\//u.test(authority),
        ),
      ).toBe(false);
    }
  });

  it('keeps representative current feature paths on one precise owner rule', () => {
    for (const path of [
      'packages/agent/test/session-title.test.ts',
      'apps/service/test/isolated/mcp-credentials.test.ts',
      'apps/kite-cli/test/tui-layout.test.tsx',
    ]) {
      expect(triggeredRepositoryRules(path), path).toEqual([]);
    }
    const owners: Record<string, string> = {
      'packages/ai/src/sdk.ts': 'unified-ai',
      'packages/agent/src/loop.ts': 'unified-agent',
      'packages/agent/src/permissions/index.ts': 'unified-agent',
      'packages/client/src/index.ts': 'unified-client',
      'packages/client/src/generated/validators.js': 'unified-client',
      'packages/ui/src/tui/composer-input.tsx': 'unified-ui',
      'apps/service/src/configuration.ts': 'unified-service',
      'apps/service/src/mcp-http-port.ts': 'unified-service',
      'apps/service/generated/openapi.json': 'unified-service',
      'apps/cli/src/index.ts': 'unified-cli',
      'apps/cli/host/tui.tsx': 'unified-cli',
      'apps/desktop/src/index.tsx': 'unified-desktop',
      'apps/desktop/electron/main.ts': 'unified-desktop',
      'apps/web/src/controller.ts': 'unified-web',
      'apps/kite-cli/src/service-mode/adapter.ts': 'kite-service-mode-adapter',
      'apps/kite-cli/src/cli/index.ts': 'kite-cli-command-runtime',
      'apps/kite-cli/src/runtime-client/tui-history-facade.ts': 'kite-runtime-history',
      'apps/kite-cli/src/tui/i18n/messages.ts': 'tui-localization',
      'apps/kite-cli/src/tui/render/useStaticContent.tsx': 'tui-terminal',
      'apps/kite-cli/src/tui/reducers/handleClientEvent.ts': 'tui-projection',
      'scripts/runtime/unified-soak-report.ts': 'runtime-resilience',
      '.github/workflows/runtime-transport-qualification.yml': 'runtime-transport-qualification',
      '.github/workflows/platform-capability-probe.yml': 'platform-qualification',
      '.github/workflows/session-log-acl-smoke.yml': 'observability-and-session-logging',
      'scripts/release/source-terminal.ts': 'release-candidate',
      'scripts/check-unified-agent-boundary.ts': 'unified-agent-checks',
      'scripts/run-default-tests.ts': 'test-system',
    };
    for (const [path, owner] of Object.entries(owners)) {
      expect(triggeredRepositoryRules(path), path).toEqual([owner]);
    }
    for (const path of [
      'packages/agent-kernel/src/reducer.ts',
      'apps/kite-service/src/index.ts',
      'packages/runtime-storage-sqlite/src/log-query.ts',
    ]) {
      expect(triggeredRepositoryRules(path), path).toEqual([]);
    }
  });

  it('assigns every workspace production file to exactly one documentation owner', () => {
    const repositoryRoot = join(import.meta.dir, '..', '..');
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      workspaces: string[];
    };
    const sourceFiles = [
      ...manifest.workspaces.map((workspace) => join(repositoryRoot, workspace, 'src')),
      join(repositoryRoot, 'apps/cli/host'),
      join(repositoryRoot, 'apps/desktop/electron'),
      join(repositoryRoot, 'apps/desktop/scripts'),
      join(repositoryRoot, 'apps/kite-cli/src'),
    ].flatMap(collectFiles);
    const ownership = sourceFiles.map((file) => {
      const path = relative(repositoryRoot, file).replaceAll('\\', '/');
      return { path, rules: triggeredRepositoryRules(path) };
    });
    const unowned = ownership.filter(({ rules }) => rules.length === 0);
    const overlapping = ownership.filter(({ rules }) => rules.length > 1);

    expect(unowned, JSON.stringify(unowned, null, 2)).toEqual([]);
    expect(overlapping, JSON.stringify(overlapping, null, 2)).toEqual([]);
  });
});

describe('task-specific documentation impact', () => {
  const documentsFor = (path: string) =>
    evaluateDocumentationImpact([path], repositoryMap).flatMap((item) => item.authorities);
  it('routes current Web presentation and transport to their current authority without old execution owners', () => {
    expect(triggeredRepositoryRules('apps/web/src/page.tsx')).toEqual(['unified-web']);
    expect(documentsFor('apps/web/src/page.tsx')).toEqual([
      'apps/web/README.md',
      'docs/active/unified-agent-boundary.md',
    ]);
    expect(triggeredRepositoryRules('packages/client/src/browser.ts')).toEqual(['unified-client']);
    expect(documentsFor('packages/client/src/browser.ts')).toContain('packages/client/README.md');
    for (const path of ['apps/web/src/page.tsx', 'packages/client/src/browser.ts']) {
      expect(documentsFor(path)).not.toContain('docs/active/runtime-authority-boundary.md');
      expect(documentsFor(path)).not.toContain('docs/active/sqlite-runtime-log-query.md');
    }
  });
  it('routes TUI navigation, input, approval, and projection independently', () => {
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/session-navigation.ts')).toEqual([
      'tui-navigation',
    ]);
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/components/InputLine.tsx')).toEqual([
      'tui-input',
    ]);
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/components/ApprovalBlock.tsx')).toEqual([
      'tui-approval',
    ]);
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/presentation/timeline.ts')).toEqual([
      'tui-projection',
    ]);
    expect(documentsFor('apps/kite-cli/src/tui/session-navigation.ts')).not.toContain(
      'docs/handbook/clients/tui/reference/commands.md',
    );
  });
  it('keeps current Store queries, execution fencing, artifacts and transactions with the Agent owner', () => {
    for (const path of [
      'packages/agent/src/storage/sqlite/model-output.ts',
      'packages/agent/src/storage/sqlite/dispatch-read-set.ts',
      'packages/agent/src/storage/sqlite/host-mutation-operations.ts',
      'packages/agent/src/storage/sqlite/mutation-operations.ts',
      'packages/agent/src/storage/transaction-state.ts',
    ]) {
      expect(triggeredRepositoryRules(path), path).toEqual(['unified-agent']);
      expect(documentsFor(path), path).toEqual([
        'packages/agent/README.md',
        'docs/active/unified-agent-boundary.md',
      ]);
      expect(documentsFor(path)).not.toContain('docs/active/runtime-resilience-qualification.md');
      expect(documentsFor(path)).not.toContain('docs/active/sqlite-runtime-log-query.md');
    }
  });
});
