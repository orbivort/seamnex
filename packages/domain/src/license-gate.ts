import type { LicenseTerms } from './license-terms';

/**
 * FR-1.14 / AC-44 / ADR-BE-25: why a hosted-service configuration is refused, in one place.
 *
 * The API and the mock platform both call this, so "the register refuses" cannot mean two
 * different things depending on which transport a screen happens to be talking to. That divergence
 * already shipped once: the mock refused every unreviewed licence while the API allowed a known,
 * permissive one.
 *
 * Precedence is deliberate — unknown terms, then unreviewed, then restricted. The first two are
 * both fixable by the operator (record the terms, ask the auditor), while a restriction is a
 * licensing fact; showing the fixable reason first is what makes the refusal actionable.
 */
export type LicenseGateCode = 'LICENCE_UNREVIEWED' | 'LICENCE_RESTRICTED';

export type LicenseGateVerdict = {
  /** True only when the licence terms themselves forbid offering the product to third parties. */
  restricted: boolean;
  /** Non-null when the configuration must be refused. Names the licence and the reason. */
  reason: string | null;
  code: LicenseGateCode | null;
  remediation: string | null;
};

export type LicenseGateInput = {
  product: string;
  licenseId: string;
  /** The licence table's entry, or null when the id is unknown to the platform. */
  terms: LicenseTerms | null;
  /** Whether a `license_record` row exists at all. */
  recorded: boolean;
  /** Whether the review is complete (reviewer, date and reference present). */
  reviewed: boolean;
  resaleRestricted: boolean;
  hostedServiceRestricted: boolean;
};

export function licenseGateVerdict(input: LicenseGateInput): LicenseGateVerdict {
  const restricted = input.resaleRestricted || input.hostedServiceRestricted;

  // A licence in neither the review record nor the licence table has unverified terms: refuse
  // rather than assuming the permissive answer (C-3).
  if (!input.recorded && input.terms === null) {
    return {
      restricted: false,
      code: 'LICENCE_UNREVIEWED',
      reason: `No licence terms are recorded for ${input.product} (${input.licenseId}), so hosted-service mode stays off.`,
      remediation:
        'Record the licence terms and complete the review before enabling hosted-service mode.',
    };
  }

  // ADR-BE-25: an unreviewed term is not evidence, even when the licence table knows it. C-3 asks
  // for legal review before any hosted-service offering, so a known-but-unreviewed licence still
  // fails closed.
  if (!input.reviewed) {
    return {
      restricted,
      code: 'LICENCE_UNREVIEWED',
      reason: `The ${input.licenseId} licence recorded for ${input.product} has not been reviewed, so hosted-service mode stays off.`,
      remediation:
        'Ask an auditor (R2) to record the licence review before enabling hosted-service mode.',
    };
  }

  if (restricted) {
    return {
      restricted: true,
      code: 'LICENCE_RESTRICTED',
      reason: `${input.product} is licensed under ${input.licenseId}, which does not permit resale or offering it as a hosted service.`,
      remediation:
        'Keep the instance for internal use, or complete the licence review and obtain a commercial licence before enabling hosted-service mode.',
    };
  }

  return { restricted: false, code: null, reason: null, remediation: null };
}
