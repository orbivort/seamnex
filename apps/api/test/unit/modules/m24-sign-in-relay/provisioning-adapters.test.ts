import { describe, expect, it } from 'vitest';
import { ProductApiAdapters } from '../../../../src/modules/m24-sign-in-relay/provisioning-adapters';
import type { ProductApiClient } from '../../../../src/modules/m24-sign-in-relay/product-api.client';
import type { OrangeHrmApiClient } from '../../../../src/modules/m24-sign-in-relay/adapters/orangehrm-api';

/**
 * Which admin API answers for a catalogue entry.
 *
 * Keyed by the composed key for the same reason the login registry is: an environment file may still
 * say `D7` while the catalogue stores `D07-01`, and a mapping must resolve to one adapter whichever
 * spelling reached the module. An unknown product is `null`, not an error — its mappings are made by
 * hand, which is the state the ADR already describes.
 */

const openproject = { name: 'openproject' } as unknown as ProductApiClient;
const orangehrm = { name: 'orangehrm' } as unknown as OrangeHrmApiClient;

function adapters(): ProductApiAdapters {
  return new ProductApiAdapters(openproject, orangehrm);
}

describe('ProductApiAdapters', () => {
  it('maps both spellings of each vendor key onto its client', () => {
    expect(adapters().for('D9')).toBe(openproject);
    expect(adapters().for('D09-01')).toBe(openproject);
    expect(adapters().for('D7')).toBe(orangehrm);
    expect(adapters().for('D07-01')).toBe(orangehrm);
  });

  it('normalises case and surrounding whitespace before resolving', () => {
    expect(adapters().for('  d07-01 ')).toBe(orangehrm);
    expect(adapters().for('d9')).toBe(openproject);
  });

  it('answers null for a product the platform does not provision', () => {
    expect(adapters().for('D11-01')).toBeNull();
    expect(adapters().for('D01-01')).toBeNull();
  });
});
