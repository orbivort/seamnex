/**
 * FR-1.14 / AC-44: the licence terms the register can state for a deployed instance.
 *
 * The obligations and the resale / hosted-service restrictions are properties of the *licence*,
 * not of the deployment: a second review of the same AGPL product must not be able to invent a
 * different answer. `license_record` stores what an auditor signed off on; this table is the
 * starting point when no review exists yet, so the register (and the gate in front of
 * hosted-service mode) has a term to quote instead of an empty cell.
 *
 * A product with a negotiated commercial licence is represented by its review record, which wins
 * over this table. A licence id that appears in neither is unknown, and the gate refuses it
 * (`docs/mvp-platform-requirements.md` C-3).
 */
export type LicenseTerms = {
  /** SPDX identifier, or the vendor's licence name when the licence is not SPDX-listed. */
  readonly id: string;
  /** The obligations the operator carries while the product is deployed. */
  readonly obligations: readonly string[];
  /** Reselling the product is restricted. */
  readonly resaleRestricted: boolean;
  /** Offering the product as a hosted service is restricted (C-3). */
  readonly hostedServiceRestricted: boolean;
};

export const LICENSE_TERMS: readonly LicenseTerms[] = [
  {
    id: 'AGPL-3.0',
    obligations: [
      'Offer the complete corresponding source to every user who interacts over a network',
      'Preserve copyright and licence notices',
      'State modifications when redistributing',
    ],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'GPL-3.0',
    obligations: [
      'Provide the corresponding source on request',
      'Preserve copyright and licence notices',
      'State modifications when redistributing',
    ],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'GPL-2.0-or-later',
    obligations: [
      'Provide the corresponding source on request',
      'Preserve copyright and licence notices',
    ],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'LGPL-3.0',
    obligations: [
      'Offer the library source and permit relinking',
      'Preserve copyright and licence notices',
    ],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'Apache-2.0',
    obligations: [
      'Preserve the licence and NOTICE files',
      'State modifications when redistributing',
    ],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'MIT',
    obligations: ['Preserve the copyright notice and licence text'],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'BSD-3-Clause',
    obligations: ['Preserve the copyright notice, conditions and disclaimer'],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'OSL-3.0',
    obligations: [
      'Offer the complete source to network users',
      'Preserve copyright and licence notices',
    ],
    resaleRestricted: false,
    hostedServiceRestricted: false,
  },
  {
    id: 'Sustainable Use (fair-code)',
    obligations: [
      'Internal business use only',
      'No resale or hosted-service provision',
      'Preserve licence notices',
    ],
    resaleRestricted: true,
    hostedServiceRestricted: true,
  },
  {
    id: 'Elastic License 2.0',
    obligations: [
      'No offering the product as a managed service',
      'No circumventing licence-key functionality',
    ],
    resaleRestricted: true,
    hostedServiceRestricted: true,
  },
  {
    id: 'BSL-1.1',
    obligations: [
      'Production use is limited until the change date in the licence',
      'No competing hosted or managed service',
    ],
    resaleRestricted: true,
    hostedServiceRestricted: true,
  },
];

const BY_NORMALISED_ID = new Map(
  LICENSE_TERMS.map((terms) => [terms.id.trim().toLowerCase(), terms] as const),
);

/** Licence ids arrive from the catalogue repository, so case and padding are normalised first. */
export function licenseTerms(licenseId: string | null | undefined): LicenseTerms | null {
  if (typeof licenseId !== 'string') return null;
  const normalised = licenseId.trim().toLowerCase();
  if (normalised.length === 0) return null;
  return BY_NORMALISED_ID.get(normalised) ?? null;
}

/** True when the licence is known and either restriction applies (resale or hosted service). */
export function licenseRestrictsOffering(terms: LicenseTerms | null): boolean {
  return terms !== null && (terms.resaleRestricted || terms.hostedServiceRestricted);
}
