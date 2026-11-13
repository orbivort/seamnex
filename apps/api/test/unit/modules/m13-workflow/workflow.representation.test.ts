import { describe, expect, it } from 'vitest';
import {
  formatIrHash,
  manualTrigger,
  normaliseDescription,
  ownerName,
} from '../../../../src/modules/m13-workflow/workflow.representation';

/**
 * Two read paths of M13 must produce the same representation. They already drifted: one returned
 * `"<name>."` for a missing description, the other `''`, and both echoed the opaque identity id as
 * the owner's name. These rules are the single place that now decides.
 */
describe('normaliseDescription', () => {
  it('keeps a real description', () => {
    expect(normaliseDescription('Sync mail into the CRM')).toBe('Sync mail into the CRM');
  });

  it('maps an empty or whitespace-only string to null', () => {
    expect(normaliseDescription('')).toBeNull();
    expect(normaliseDescription('   ')).toBeNull();
    expect(normaliseDescription('\t\n')).toBeNull();
  });

  it('keeps null as null', () => {
    expect(normaliseDescription(null)).toBeNull();
  });
});

describe('formatIrHash', () => {
  it('prefixes a bare digest with the algorithm the contract carries', () => {
    expect(formatIrHash('abc123')).toBe('sha256:abc123');
  });

  it('leaves an already-prefixed digest alone', () => {
    expect(formatIrHash('sha256:abc123')).toBe('sha256:abc123');
  });

  it('reports no digest as sha256:none', () => {
    expect(formatIrHash(null)).toBe('sha256:none');
    expect(formatIrHash('')).toBe('sha256:none');
  });
});

describe('ownerName', () => {
  it('prefers the synced display name', () => {
    expect(ownerName('Alice', 'alice', 'sub-1')).toBe('Alice');
  });

  it('falls back to the mirror username', () => {
    expect(ownerName(null, 'alice', 'sub-1')).toBe('alice');
    expect(ownerName(undefined, 'alice', 'sub-1')).toBe('alice');
  });

  it('falls back to the identifier it actually holds rather than inventing a name', () => {
    expect(ownerName(null, null, 'sub-1')).toBe('sub-1');
    expect(ownerName(undefined, undefined, 'sub-1')).toBe('sub-1');
  });
});

describe('manualTrigger', () => {
  it('describes a manual trigger that an operator starts', () => {
    expect(manualTrigger()).toEqual({
      type: 'manual',
      label: 'Manual',
      config: 'Started by an operator.',
      timezone: null,
    });
  });

  it('returns a fresh object so a caller cannot mutate the shared value', () => {
    expect(manualTrigger()).not.toBe(manualTrigger());
  });
});
