import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type DocumentationMap,
  documentationPatternError,
  evaluateDocumentationImpact,
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

  it('requires a mapped current authority for implementation changes', () => {
    expect(evaluateDocumentationImpact(['src/core/runtime/kernel.ts'], map)).toEqual([
      {
        ruleId: 'runtime',
        sources: ['src/core/runtime/kernel.ts'],
        expectedAuthorities: ['packages/runtime/README.md', 'docs/active/runtime.md'],
      },
    ]);
    expect(
      evaluateDocumentationImpact(
        ['src/core/runtime/kernel.ts', 'packages/runtime/README.md'],
        map,
      ),
    ).toEqual([]);
  });

  it('requires every overlapping rule to converge independently', () => {
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
        ruleId: 'security',
        sources: ['packages/runtime/security/policy.ts'],
        expectedAuthorities: ['docs/active/security.md'],
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
      expect(
        rule.authorities.every(
          (authority) =>
            authority === 'README.md' ||
            authority === 'README.zh-CN.md' ||
            authority === 'docs/README.md' ||
            authority === 'tests/README.md' ||
            authority.startsWith('docs/active/') ||
            authority.startsWith('docs/runbooks/') ||
            /^(packages|apps)\/[^/]+\/(README\.md|docs\/)/u.test(authority),
        ),
      ).toBe(true);
      expect(
        rule.authorities.some((authority) =>
          /docs\/(adr|book|space|design|deprecated)\//u.test(authority),
        ),
      ).toBe(false);
    }
  });

  it('keeps representative feature paths on one precise owner rule', () => {
    expect(triggeredRepositoryRules('packages/agent-kernel/test/agent-kernel.test.ts')).toEqual([]);
    expect(triggeredRepositoryRules('apps/kite-cli/test/tui-layout.test.tsx')).toEqual([]);
    expect(triggeredRepositoryRules('packages/agent-kernel/src/reducer.ts')).toEqual([
      'agent-kernel',
    ]);
    expect(
      triggeredRepositoryRules('packages/agent-kernel/src/core/authorization/reducer.ts'),
    ).toEqual(['agent-kernel-authorization']);
    expect(
      triggeredRepositoryRules('packages/builtin-runtime/src/model/invocation-gateway.ts'),
    ).toEqual(['builtin-model']);
    expect(triggeredRepositoryRules('packages/builtin-runtime/src/mcp/manager.ts')).toEqual([
      'builtin-mcp',
    ]);
    expect(triggeredRepositoryRules('packages/runtime-protocol/src/codecs.ts')).toEqual([
      'runtime-protocol',
    ]);
    expect(triggeredRepositoryRules('packages/runtime-server/src/server.ts')).toEqual([
      'runtime-server',
    ]);
    expect(triggeredRepositoryRules('packages/runtime-client/src/client.ts')).toEqual([
      'runtime-client',
    ]);
    expect(triggeredRepositoryRules('packages/runtime-host/src/host/command-receipt.ts')).toEqual([
      'runtime-host-command-receipts',
    ]);
    expect(triggeredRepositoryRules('apps/kite-cli/src/carrier/runtime-server-stdio.ts')).toEqual([
      'kite-runtime-carriers',
    ]);
    expect(triggeredRepositoryRules('apps/kite-service/src/shell.ts')).toEqual([
      'kite-service-application',
    ]);
    expect(
      triggeredRepositoryRules('apps/kite-service/src/carrier/native-loopback-carrier.ts'),
    ).toEqual(['kite-service-carrier']);
    expect(triggeredRepositoryRules('apps/kite-service/src/manager/manager.ts')).toEqual([
      'kite-service-manager',
    ]);
    expect(
      triggeredRepositoryRules('apps/kite-cli/src/runtime-client/presentation-history.ts'),
    ).toEqual(['kite-runtime-history']);
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/i18n/messages.ts')).toEqual([
      'tui-localization',
    ]);
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/render/useStaticContent.tsx')).toEqual([
      'tui-rendering',
    ]);
    expect(triggeredRepositoryRules('apps/kite-cli/src/tui/reducers/handleEvent.ts')).toEqual([
      'tui-rendering',
    ]);
    expect(
      triggeredRepositoryRules('tests/qualification/sandbox/platform-capability-probe.test.ts'),
    ).toEqual(['platform-qualification']);
    expect(
      triggeredRepositoryRules('tests/qualification/runtime/fault-soak-report.test.ts'),
    ).toEqual(['runtime-resilience']);
    expect(triggeredRepositoryRules('scripts/release/platform-capability-probe.ts')).toEqual([
      'platform-qualification',
    ]);
    expect(triggeredRepositoryRules('scripts/release/session-log-acl-smoke.ts')).toEqual([
      'observability-and-session-logging',
    ]);
    expect(triggeredRepositoryRules('scripts/run-default-tests.ts')).toEqual(['test-system']);
  });

  it('assigns every workspace production file to exactly one documentation owner', () => {
    const repositoryRoot = join(import.meta.dir, '..', '..');
    const packageSourceRoots = readdirSync(join(repositoryRoot, 'packages'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repositoryRoot, 'packages', entry.name, 'src'));
    const sourceFiles = [
      join(repositoryRoot, 'apps', 'kite-cli', 'src'),
      join(repositoryRoot, 'apps', 'kite-service', 'src'),
      ...packageSourceRoots,
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
