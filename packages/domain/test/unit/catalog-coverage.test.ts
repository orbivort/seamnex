import { describe, expect, it } from 'vitest';
import { computeCatalogCoverage } from '../../src/catalog-coverage';
import { NATIVE_FLOOR_DEPLOYMENTS } from '../../src/posture';

/**
 * S-1 / S-2 — coverage computed once for the receipt, the posture payload and the gate.
 *
 * The finding was arithmetic: three products declared an environment with no entry document, so the
 * catalogue advertised products that could never deploy, and the floor was a caption nobody could
 * check. Both halves are asserted here — the deployment dedupe (D5 and D6 are one ERPNext instance)
 * and the fact that a refused declaration stays visible instead of being silently dropped.
 */
describe('computeCatalogCoverage', () => {
  it('counts deployments, not entries, so a shared instance is credited once', () => {
    const coverage = computeCatalogCoverage({
      entries: [
        { key: 'D05-01', guaranteeClass: 'native', primaryInstanceId: 'inst-erp' },
        { key: 'D06-01', guaranteeClass: 'native', primaryInstanceId: 'inst-erp' },
        { key: 'D01-01', guaranteeClass: 'fa_header', primaryInstanceId: 'inst-crm' },
        { key: 'D07-01', guaranteeClass: 'fa_gate', primaryInstanceId: null },
      ],
      declaredEnvironments: 3,
      refused: [],
    });

    expect(coverage.entries).toBe(4);
    expect(coverage.deployments).toBe(3);
    expect(coverage.byClass).toEqual({ native: 1, fa_header: 1, fa_delegated: 0, fa_gate: 1 });
    expect(coverage.nativeDeployments).toBe(1);
  });

  it('serves the floor, the shortfall and the baseline with the counts', () => {
    const coverage = computeCatalogCoverage({
      entries: [
        { key: 'D01-01', guaranteeClass: 'native', primaryInstanceId: null },
        { key: 'D02-01', guaranteeClass: 'fa_delegated', primaryInstanceId: null },
      ],
      declaredEnvironments: 2,
      refused: [],
    });

    expect(coverage.floor).toBe(NATIVE_FLOOR_DEPLOYMENTS);
    expect(coverage.baseline).toBe(12);
    expect(coverage.floorMet).toBe(false);
    expect(coverage.shortfall).toBe(NATIVE_FLOOR_DEPLOYMENTS - 1);
  });

  it('measures against a recorded decision rather than the default', () => {
    const coverage = computeCatalogCoverage({
      entries: [
        { key: 'D01-01', guaranteeClass: 'native', primaryInstanceId: null },
        { key: 'D02-01', guaranteeClass: 'native', primaryInstanceId: null },
      ],
      declaredEnvironments: 2,
      refused: [],
      floor: 2,
    });

    expect(coverage.floor).toBe(2);
    expect(coverage.floorMet).toBe(true);
    expect(coverage.shortfall).toBe(0);
  });

  it('reports a refused declaration as declared-but-not-documented', () => {
    const coverage = computeCatalogCoverage({
      entries: [{ key: 'D01-01', guaranteeClass: 'native', primaryInstanceId: null }],
      declaredEnvironments: 3,
      refused: [
        { key: 'D07-01', reason: 'no entry document' },
        { key: 'D11-01', reason: 'no entry document' },
      ],
    });

    expect(coverage.declaredEnvironments).toBe(3);
    expect(coverage.documentedEnvironments).toBe(1);
    expect(coverage.refused).toHaveLength(2);
    // The refusals are what makes it a control: a verdict without the reason cannot be acted on.
    expect(coverage.refused[0]).toEqual({ key: 'D07-01', reason: 'no entry document' });
  });

  it('does not report a negative documented count when more is refused than declared', () => {
    const coverage = computeCatalogCoverage({
      entries: [],
      declaredEnvironments: 1,
      refused: [
        { key: 'D07-01', reason: 'no entry document' },
        { key: 'D11-01', reason: 'invalid json' },
      ],
    });

    expect(coverage.documentedEnvironments).toBe(0);
    expect(coverage.entries).toBe(0);
    expect(coverage.deployments).toBe(0);
  });
});
