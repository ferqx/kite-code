import { describe, expect, test } from 'bun:test';
import { assertEgressAllowedV1, joinDataOriginsV1 } from '../src/data-origin-egress';

const origin = (classification: 'public' | 'internal' | 'confidential' | 'secret') => ({
  originId: classification,
  kind: 'external' as const,
  classification,
  ownerProjectId: null,
  parentOriginIds: [],
  observationId: `obs:${classification}`,
});
describe('RAV1-03 DataOrigin/Egress IR', () => {
  test('uses deny-wins classification join', () => {
    expect(joinDataOriginsV1([origin('public'), origin('confidential')])).toBe('confidential');
    expect(joinDataOriginsV1([origin('internal'), origin('secret')])).toBe('secret');
  });
  test('requires destination-specific authority and denies expired or disallowed provenance', () => {
    const authority = {
      egressId: 'e1',
      destination: {
        destinationId: 'model:1',
        kind: 'model' as const,
        routeIdentity: 'route:1',
        nonceNamespace: 'model:1',
      },
      allowedClassifications: ['internal'] as const,
      allowedOriginKinds: ['project'] as const,
      invocationId: 'i1',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    expect(() => assertEgressAllowedV1({ origins: [origin('confidential')], authority })).toThrow(
      'classification',
    );
    expect(() =>
      assertEgressAllowedV1({ origins: [{ ...origin('internal'), kind: 'project' }], authority }),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowedV1({
        origins: [{ ...origin('internal'), kind: 'project' }],
        authority: { ...authority, expiresAt: '2020-01-01T00:00:00Z' },
      }),
    ).toThrow('expired');
    expect(() =>
      assertEgressAllowedV1({
        origins: [
          {
            ...origin('internal'),
            kind: 'project',
            ownerProjectId: 'project_one',
            parentOriginIds: ['missing-parent'],
          },
        ],
        authority,
      }),
    ).toThrow('lineage');
    expect(() =>
      assertEgressAllowedV1({
        origins: [
          { ...origin('internal'), kind: 'project', ownerProjectId: 'project_one' },
          {
            ...origin('public'),
            kind: 'project',
            ownerProjectId: 'project_two',
          },
        ],
        authority,
      }),
    ).toThrow('Project identity');
  });
});
