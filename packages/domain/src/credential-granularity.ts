import { CREDENTIAL_GRANULARITIES, type CredentialGranularity } from './enums';

/**
 * Credential granularity (FR-2.14) and what it permits.
 *
 * C-11 is the constraint this file encodes: the platform's guarantee covers **brokered, scoped
 * credentials**, so a product that cannot issue a credential narrow enough to be bounded by an
 * operation cannot be written to by a workflow. FR-5.3 says the same thing from the workflow side
 * ("the workflow shall be limited to read operations"), and FR-2.14 from the catalog side ("flagged
 * write-workflow-ineligible").
 *
 * The rule is therefore deliberately one-sided: **only `scoped` writes**, and only `scoped` and
 * `account` may be used at all — `none` declares that the product exposes no API credential, so
 * even a read scope would be a credential the platform cannot honestly broker.
 *
 * Everything that needs a verdict calls these functions: the registry projection, the mock
 * simulator, the console and the credential broker. Four independent `!== 'none'` expressions used
 * to disagree with each other and with the requirement, which is exactly the class of bug a single
 * predicate prevents.
 */
export const WRITE_ELIGIBLE_GRANULARITIES: readonly CredentialGranularity[] = ['scoped'];

export const WORKFLOW_ELIGIBLE_GRANULARITIES: readonly CredentialGranularity[] = [
  'scoped',
  'account',
];

export function isCredentialGranularity(value: unknown): value is CredentialGranularity {
  return (
    typeof value === 'string' && (CREDENTIAL_GRANULARITIES as readonly string[]).includes(value)
  );
}

/** C-11 / FR-5.3: a write workflow may target only a product that issues per-operation credentials. */
export function isWriteEligible(granularity: CredentialGranularity): boolean {
  return WRITE_ELIGIBLE_GRANULARITIES.includes(granularity);
}

/** A workflow may only *use* a product it can obtain a credential for; `none` means none at all. */
export function isWorkflowEligible(granularity: CredentialGranularity): boolean {
  return WORKFLOW_ELIGIBLE_GRANULARITIES.includes(granularity);
}

/**
 * The one sentence each surface shows for a refused write. `none` and `account` are refused for
 * different reasons, and telling an operator to "request a scope" for a product with no API at all
 * is what made the old error misleading.
 */
export function writeIneligibilityReason(granularity: CredentialGranularity): string | null {
  if (isWriteEligible(granularity)) return null;
  return granularity === 'none'
    ? 'The product exposes no API credential at all, so no workflow may write to it (C-11).'
    : 'The product issues only account-wide credentials, so a write workflow cannot be bounded to an operation (C-11).';
}

/** The complement for reads: `none` has nothing to broker, so it is refused too. */
export function workflowIneligibilityReason(granularity: CredentialGranularity): string | null {
  if (isWorkflowEligible(granularity)) return null;
  return 'The product exposes no API credential, so the platform cannot broker any workflow access to it.';
}
