import { describe, expect, it } from 'vitest';
import { LICENSE_TERMS, licenseRestrictsOffering, licenseTerms } from '../../src/license-terms';

/**
 * The register quotes these terms when no review record exists. A missing entry is not "no
 * restriction": C-3 refuses a licence the platform cannot describe, so the lookup must answer
 * `null` rather than an empty default.
 */
describe('licence terms register', () => {
  it('describes every licence it lists, with at least one obligation', () => {
    for (const terms of LICENSE_TERMS) {
      expect(terms.id.trim().length, terms.id).toBeGreaterThan(0);
      expect(terms.obligations.length, terms.id).toBeGreaterThan(0);
      for (const obligation of terms.obligations) {
        expect(obligation.length, terms.id).toBeGreaterThan(0);
      }
    }
    // The map is built from this list, so a duplicate id would silently hide one entry.
    expect(new Set(LICENSE_TERMS.map((terms) => terms.id.toLowerCase())).size).toBe(
      LICENSE_TERMS.length,
    );
  });

  it('normalises case and padding, because ids arrive from the catalogue repository', () => {
    expect(licenseTerms('  agpl-3.0 ')?.id).toBe('AGPL-3.0');
    expect(licenseTerms('MIT')?.id).toBe('MIT');
    expect(licenseTerms('Sustainable Use (fair-code)')?.resaleRestricted).toBe(true);
  });

  it('reports an unknown licence instead of inventing terms', () => {
    expect(licenseTerms('Proprietary-EULA')).toBeNull();
    expect(licenseTerms('')).toBeNull();
    expect(licenseTerms('   ')).toBeNull();
    expect(licenseTerms(null)).toBeNull();
    expect(licenseTerms(undefined)).toBeNull();
  });

  it('flags a licence that restricts resale or hosted-service offering', () => {
    expect(licenseRestrictsOffering(licenseTerms('AGPL-3.0'))).toBe(false);
    expect(licenseRestrictsOffering(licenseTerms('Elastic License 2.0'))).toBe(true);
    expect(licenseRestrictsOffering(licenseTerms('BSL-1.1'))).toBe(true);
    expect(licenseRestrictsOffering(null)).toBe(false);
  });

  it('treats either restriction as enough to refuse the gate', () => {
    expect(
      licenseRestrictsOffering({
        id: 'resale-only',
        obligations: [],
        resaleRestricted: true,
        hostedServiceRestricted: false,
      }),
    ).toBe(true);
    expect(
      licenseRestrictsOffering({
        id: 'hosted-only',
        obligations: [],
        resaleRestricted: false,
        hostedServiceRestricted: true,
      }),
    ).toBe(true);
  });
});
