import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
} from '../../../scripts/evals/qualification/github-actions-agent-evaluation-v1';

const workflow = readFileSync(resolve(GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1), 'utf8');

function jobBlock(name: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`workflow job is missing: ${name}`);
  const remainder = workflow.slice(start + 1);
  const boundary = remainder.search(/\n {2}[^\s]/u);
  return workflow.slice(start, boundary < 0 ? workflow.length : start + 1 + boundary);
}

describe('GitHub Actions live Agent diagnostic workflow', () => {
  test('is manual-only, fixed to protected main, and carries least GitHub permission', () => {
    const preflight = jobBlock('preflight');
    const live = jobBlock('live-agent-evaluation');
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(
      /^ {2}(?:push|pull_request|pull_request_target|schedule|workflow_run):/m,
    );
    expect(workflow).not.toMatch(/^ {4}inputs:/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(
      /^ {2}(?:actions|attestations|checks|deployments|id-token|issues|packages|pull-requests|statuses):/m,
    );
    expect(workflow).toContain("github.repository == 'ferqx/kite-code'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(preflight).not.toContain('github.ref_protected == true');
    expect(live).toContain('github.ref_protected == true');
    expect(workflow).toContain('group: agent-live-evaluation-main-v1');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  test('pins checkout/setup actions and never accepts a caller-selected checkout', () => {
    const actionUses = [...workflow.matchAll(/^\s*- uses:\s+([^\s]+)\s*$/gmu)].map(
      (match) => match[1],
    );
    expect(actionUses).toEqual([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
    ]);
    for (const action of actionUses) expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain(`ref: \${{ github.sha }}`);
    expect(workflow).not.toMatch(/^\s+repository:/m);
    expect(workflow).toContain('bun install --frozen-lockfile --ignore-scripts');
  });

  test('keeps the secret only in the protected live step and publishes no artifact', () => {
    const preflight = jobBlock('preflight');
    const live = jobBlock('live-agent-evaluation');
    expect(preflight).not.toContain('secrets.');
    expect(preflight).toContain('bun run eval:agent:live:preflight');
    expect(preflight).toContain('github-actions-agent-diagnostic-model-lease.test.ts');
    expect(preflight).toContain('github-actions-auto-compaction.test.ts');
    expect(preflight).toContain('github-actions-agent-diagnostic-aggregate.test.ts');
    expect(live).toContain('environment:\n      name: agent-live-eval');
    expect(live).toContain(`${GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1}:`);
    expect(live).toContain(`secrets.${GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1}`);
    expect(live).toContain('bun run eval:agent:live');
    expect(live).toContain('Run fixed real-Agent diagnostic suite');
    expect(workflow).not.toContain('upload-artifact');
    expect(workflow).not.toContain('DEEPSEEK_API_KEY');
    expect(workflow).not.toContain('DASHSCOPE_API_KEY');
    expect(workflow).not.toContain('release-candidate');
  });
});
