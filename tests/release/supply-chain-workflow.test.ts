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
    expect(workflow).not.toContain('cosign');
    expect(workflow).not.toContain('gh release');
    expect(workflow).toContain("github.repository == 'ferqx/kite-code'");
    expect(workflow).toContain('inputs.acknowledge_non_distributable == true');
  });

  test('pins actions and makes the production job unreachable', () => {
    expect(workflow).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    expect(workflow).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(workflow).toContain('production-signing-disabled:');
    expect(workflow).toContain('if: $' + '{{ false }}');
    expect(workflow).toContain('nonDistributable=true productionCandidate=false');
  });
});
