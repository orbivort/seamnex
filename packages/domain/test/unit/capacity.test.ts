import { describe, expect, it } from 'vitest';
import {
  DISK_HEADROOM_RATIO,
  MEMORY_HEADROOM_RATIO,
  admissionVerdict,
  type AdmissionInput,
} from '../../src/capacity';

const HOST = { cpu: 8, memoryMb: 32 * 1024, diskMb: 500 * 1024 };
const RESERVE = { cpu: 1, memoryMb: 4 * 1024, diskMb: 20 * 1024 };
const SMALL = { cpu: 1, memoryMb: 1024, diskMb: 10 * 1024 };

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    host: HOST,
    reserve: RESERVE,
    allocated: { cpu: 0, memoryMb: 0, diskMb: 0 },
    request: SMALL,
    oversubscriptionFactor: 1.25,
    ...overrides,
  };
}

describe('capacity admission (§13.2)', () => {
  it('admits a small request on an empty host and reports headroom', () => {
    const verdict = admissionVerdict(input());
    expect(verdict.admissible).toBe(true);
    expect(verdict.shortfall).toEqual([]);
    expect(verdict.headroom.cpu).toBeGreaterThan(0);
    expect(verdict.headline).toMatch(/vCPU and .* GB memory headroom/);
  });

  it('caps CPU at the oversubscription factor', () => {
    const verdict = admissionVerdict(input({ allocated: { cpu: 9, memoryMb: 0, diskMb: 0 } }));
    expect(verdict.admissible).toBe(false);
    expect(verdict.shortfall).toContain('CPU');
    expect(verdict.limits.cpu).toBe(HOST.cpu * 1.25);
  });

  it('never oversubscribes memory and stops at 95%', () => {
    const tight = { cpu: 1, memoryMb: HOST.memoryMb - RESERVE.memoryMb - 512, diskMb: 0 };
    const verdict = admissionVerdict(input({ request: tight }));
    expect(verdict.limits.memoryMb).toBe(HOST.memoryMb * MEMORY_HEADROOM_RATIO);
    expect(verdict.admissible).toBe(false);
    expect(verdict.shortfall).toContain('Memory');
  });

  it('never oversubscribes disk and stops at 90%', () => {
    const tight = { cpu: 1, memoryMb: 0, diskMb: HOST.diskMb - RESERVE.diskMb - 1024 };
    const verdict = admissionVerdict(input({ request: tight }));
    expect(verdict.limits.diskMb).toBe(HOST.diskMb * DISK_HEADROOM_RATIO);
    expect(verdict.shortfall).toContain('Disk');
  });

  it('counts the platform reserve before the request', () => {
    const withoutReserve = admissionVerdict(input({ reserve: { cpu: 0, memoryMb: 0, diskMb: 0 } }));
    const withReserve = admissionVerdict(input());
    expect(withReserve.headroom.cpu).toBeLessThan(withoutReserve.headroom.cpu);
    expect(withReserve.used.cpu).toBe(SMALL.cpu + RESERVE.cpu);
  });

  it('reports every exceeded axis, not just the first', () => {
    const verdict = admissionVerdict(
      input({ allocated: { cpu: 99, memoryMb: 99_999, diskMb: 999_999 } }),
    );
    expect(verdict.shortfall).toEqual(['CPU', 'Memory', 'Disk']);
  });

  it('falls back to a factor of 1 rather than dividing by zero', () => {
    const verdict = admissionVerdict(input({ oversubscriptionFactor: 0 }));
    expect(verdict.limits.cpu).toBe(HOST.cpu);
  });

  it('treats a missing request as a zero-sized one', () => {
    // The wizard preview calls this before the size step has a value; `undefined` at runtime must
    // not become `NaN` on every axis.
    const verdict = admissionVerdict({
      ...input(),
      request: undefined as unknown as AdmissionInput['request'],
    });

    expect(verdict.admissible).toBe(true);
    expect(verdict.used.cpu).toBe(RESERVE.cpu);
    expect(Number.isNaN(verdict.used.memoryMb)).toBe(false);
  });
});
