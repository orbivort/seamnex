import { describe, expect, it } from 'vitest';
import { licenseGateVerdict } from '../../src/license-gate';
import { licenseTerms } from '../../src/license-terms';

/**
 * FR-1.14 / AC-44 / ADR-BE-25: the gate is one decision, shared by the API and the mock platform.
 * These cases pin the precedence — unknown, then unreviewed, then restricted — because a refusal
 * that names the wrong reason sends the operator to the wrong fix.
 */

const BASE = {
  product: 'Mail',
  licenseId: 'AGPL-3.0',
  recorded: true,
  reviewed: true,
  resaleRestricted: false,
  hostedServiceRestricted: false,
};

describe('licenseGateVerdict', () => {
  it('allows a reviewed, unencumbered licence', () => {
    const verdict = licenseGateVerdict({ ...BASE, terms: licenseTerms('AGPL-3.0') });
    expect(verdict).toEqual({ restricted: false, reason: null, code: null, remediation: null });
  });

  it('refuses terms the platform has never seen', () => {
    const verdict = licenseGateVerdict({
      ...BASE,
      licenseId: 'Unknown-1.0',
      terms: null,
      recorded: false,
      reviewed: false,
    });
    expect(verdict.code).toBe('LICENCE_UNREVIEWED');
    expect(verdict.reason).toContain('No licence terms are recorded for Mail (Unknown-1.0)');
    expect(verdict.remediation).toContain('Record the licence terms');
  });

  it('refuses a known licence that nobody has reviewed, even when it is permissive', () => {
    const verdict = licenseGateVerdict({
      ...BASE,
      terms: licenseTerms('AGPL-3.0'),
      reviewed: false,
    });
    expect(verdict.code).toBe('LICENCE_UNREVIEWED');
    expect(verdict.reason).toBe(
      'The AGPL-3.0 licence recorded for Mail has not been reviewed, so hosted-service mode stays off.',
    );
    expect(verdict.remediation).toContain('Ask an auditor (R2)');
    // The licence itself is not the obstacle; the missing evidence is.
    expect(verdict.restricted).toBe(false);
  });

  it('refuses a reviewed licence that restricts resale or hosted service', () => {
    const verdict = licenseGateVerdict({
      ...BASE,
      licenseId: 'Sustainable Use (fair-code)',
      terms: licenseTerms('Sustainable Use (fair-code)'),
      resaleRestricted: true,
      hostedServiceRestricted: true,
    });
    expect(verdict.code).toBe('LICENCE_RESTRICTED');
    expect(verdict.reason).toContain('Sustainable Use (fair-code)');
    expect(verdict.restricted).toBe(true);
    expect(verdict.remediation).toContain('commercial licence');
  });

  it('reports unknown terms before the restriction, because the fix comes first', () => {
    const verdict = licenseGateVerdict({
      ...BASE,
      licenseId: 'Unknown-1.0',
      terms: null,
      recorded: false,
      resaleRestricted: true,
      hostedServiceRestricted: true,
    });
    expect(verdict.code).toBe('LICENCE_UNREVIEWED');
    expect(verdict.reason).toContain('No licence terms are recorded');
  });

  it('reports a missing review before the restriction, so the operator knows who acts next', () => {
    const verdict = licenseGateVerdict({
      ...BASE,
      terms: licenseTerms('Sustainable Use (fair-code)'),
      reviewed: false,
      resaleRestricted: true,
      hostedServiceRestricted: true,
    });
    expect(verdict.code).toBe('LICENCE_UNREVIEWED');
    expect(verdict.reason).toContain('has not been reviewed');
    expect(verdict.restricted).toBe(true);
  });
});
