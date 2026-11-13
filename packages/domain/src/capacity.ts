/**
 * Design §13.2 capacity guard.
 *
 * The wizard preview, the capacity board and `POST /instances` all call this function so
 * client and server cannot disagree about admission. Rules:
 *   CPU    — declared caps + request + platform reserve <= oversubscriptionFactor × host CPU
 *   Memory — allocated + request + platform reserve   <= 95% of host memory
 *   Disk   — allocated + request + platform reserve   <= 90% of the volume pool
 * Memory and disk are never oversubscribed; only CPU caps are.
 */

export type ResourceShape = { cpu: number; memoryMb: number; diskMb: number };

export type AdmissionAxis = 'CPU' | 'Memory' | 'Disk';

export type AdmissionInput = {
  host: ResourceShape;
  reserve: ResourceShape;
  allocated: ResourceShape;
  request: ResourceShape;
  oversubscriptionFactor: number;
};

export type AdmissionOutcome = {
  admissible: boolean;
  shortfall: AdmissionAxis[];
  headline: string;
  detail: string;
  reserveNote: string;
  limits: ResourceShape;
  used: ResourceShape;
  headroom: ResourceShape;
};

const EMPTY: ResourceShape = { cpu: 0, memoryMb: 0, diskMb: 0 };

export const MEMORY_HEADROOM_RATIO = 0.95;
export const DISK_HEADROOM_RATIO = 0.9;

function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

export function admissionVerdict(input: AdmissionInput): AdmissionOutcome {
  const request = input.request ?? EMPTY;
  const factor = input.oversubscriptionFactor > 0 ? input.oversubscriptionFactor : 1;

  const limits: ResourceShape = {
    cpu: input.host.cpu * factor,
    memoryMb: input.host.memoryMb * MEMORY_HEADROOM_RATIO,
    diskMb: input.host.diskMb * DISK_HEADROOM_RATIO,
  };

  const used: ResourceShape = {
    cpu: round(input.allocated.cpu + request.cpu + input.reserve.cpu, 2),
    memoryMb: input.allocated.memoryMb + request.memoryMb + input.reserve.memoryMb,
    diskMb: input.allocated.diskMb + request.diskMb + input.reserve.diskMb,
  };

  const shortfall: AdmissionAxis[] = [];
  if (used.cpu > limits.cpu) shortfall.push('CPU');
  if (used.memoryMb > limits.memoryMb) shortfall.push('Memory');
  if (used.diskMb > limits.diskMb) shortfall.push('Disk');

  const headroom: ResourceShape = {
    cpu: round(limits.cpu - used.cpu, 2),
    memoryMb: limits.memoryMb - used.memoryMb,
    diskMb: limits.diskMb - used.diskMb,
  };

  const detail =
    `Admission checks the platform reserve first, then CPU caps against ${factor}× the ${input.host.cpu} vCPU host, ` +
    `memory against 95% of ${gb(input.host.memoryMb)} GB and disk against 90% of the ${gb(input.host.diskMb)} GB pool. ` +
    'Memory and disk are never oversubscribed.';

  return {
    admissible: shortfall.length === 0,
    shortfall,
    headline:
      shortfall.length === 0
        ? `${headroom.cpu.toFixed(1)} vCPU and ${gb(headroom.memoryMb)} GB memory headroom after the platform reserve`
        : `${shortfall.join(', ')} shortfall against the admission rule`,
    detail,
    reserveNote:
      `Reserve: ${input.reserve.cpu} vCPU / ${gb(input.reserve.memoryMb)} GB / ${gb(input.reserve.diskMb)} GB ` +
      'held back for the control plane, identity provider and observability.',
    limits,
    used,
    headroom,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
