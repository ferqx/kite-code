import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_DEFINITIONS_V1 } from '@kite/runtime-host';
import { parseDocument } from 'yaml';

describe('production dashboard and SLO contract', () => {
  test('covers the required low-content domains and blocks no-data green states', () => {
    const dashboard = JSON.parse(
      readFileSync(resolve('ops/dashboards/agent-production.json'), 'utf8'),
    ) as {
      defaultState: string;
      noDataState: string;
      contentFieldsAllowed: boolean;
      panels: { id: string; metrics: string[] }[];
    };
    expect(dashboard.defaultState).toBe('unknown');
    expect(dashboard.noDataState).toBe('blocked');
    expect(dashboard.contentFieldsAllowed).toBe(false);
    expect(dashboard.panels.map((panel) => panel.id)).toEqual([
      'run-turn-outcomes',
      'model-health',
      'tool-mcp-health',
      'skill-lifecycle',
      'plan-progress',
      'verification',
      'compaction',
      'runtime-recovery',
      'resource-governance',
      'artifact-logging',
      'agent-task-product',
    ]);
    expect(dashboard.panels.every((panel) => panel.metrics.length > 0)).toBe(true);
    for (const panel of dashboard.panels) {
      for (const metric of panel.metrics) {
        expect(METRIC_DEFINITIONS_V1).toHaveProperty(metric);
      }
    }
  });

  test('keeps non-G0 thresholds unconfigured until an approved baseline exists', () => {
    const document = parseDocument(
      readFileSync(resolve('ops/slo/agent-production-v1.yaml'), 'utf8'),
      { uniqueKeys: true },
    );
    expect(document.errors).toHaveLength(0);
    const slo = document.toJS() as Record<string, unknown>;
    expect(slo.status).toBe('baseline_unconfigured');
    expect(slo.noData).toBe('blocked');
    expect(slo.minimumSamples).toBeNull();
    expect(slo.observationWindowSeconds).toBeNull();
    expect(slo.errorBudget).toBeNull();
    expect(Object.values(slo.g0 as Record<string, unknown>)).toEqual([0, 0, 0, 0, 0]);
    expect(
      Object.values(slo.thresholds as Record<string, unknown>).every((value) => value === null),
    ).toBe(true);
  });
});
