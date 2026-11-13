import { describe, expect, it } from 'vitest';
import {
  isCredentialGranularity,
  isWorkflowEligible,
  isWriteEligible,
  workflowIneligibilityReason,
  writeIneligibilityReason,
} from '../../src/credential-granularity';
import { API_OPERATIONS, IntegrationMetadataRequestSchema, operationKey } from '../../src/contract';

/**
 * C-11 / FR-5.3: "products that cannot issue scoped credentials are read-only in workflows", and
 * FR-5.3 limits such a product "to read operations". These cases pin the rule the four independent
 * `!== 'none'` expressions in the API, the console and the simulator used to disagree about: an
 * account-wide credential is **not** a scoped one, so it cannot carry a write.
 */
describe('isWriteEligible', () => {
  it('is true only for operation-scoped credentials', () => {
    expect(isWriteEligible('scoped')).toBe(true);
    expect(isWriteEligible('account')).toBe(false);
    expect(isWriteEligible('none')).toBe(false);
  });
});

describe('isWorkflowEligible', () => {
  it('is true whenever a credential can be brokered at all', () => {
    expect(isWorkflowEligible('scoped')).toBe(true);
    expect(isWorkflowEligible('account')).toBe(true);
    // `none` means the product exposes no API credential: even a read scope would be a fiction.
    expect(isWorkflowEligible('none')).toBe(false);
  });
});

describe('ineligibility reasons', () => {
  it('says nothing when the operation is permitted', () => {
    expect(writeIneligibilityReason('scoped')).toBeNull();
    expect(workflowIneligibilityReason('scoped')).toBeNull();
    expect(workflowIneligibilityReason('account')).toBeNull();
  });

  it('distinguishes an account-wide credential from no credential at all', () => {
    expect(writeIneligibilityReason('account')).toMatch(/account-wide/);
    expect(writeIneligibilityReason('none')).toMatch(/no API credential/);
    expect(writeIneligibilityReason('account')).not.toBe(writeIneligibilityReason('none'));
    expect(workflowIneligibilityReason('none')).toMatch(/no API credential/);
  });
});

describe('isCredentialGranularity', () => {
  it('narrows only the three declared members', () => {
    expect(isCredentialGranularity('scoped')).toBe(true);
    expect(isCredentialGranularity('account')).toBe(true);
    expect(isCredentialGranularity('none')).toBe(true);
    expect(isCredentialGranularity('banana')).toBe(false);
    expect(isCredentialGranularity(null)).toBe(false);
  });
});

/**
 * FR-2.14 is a fact the platform branches on, so the request schema has to reject an unknown value
 * rather than persist it into the catalog document — which used to be readable only as an
 * "incomplete projection" error after the fact.
 */
describe('IntegrationMetadataRequestSchema', () => {
  const patch = API_OPERATIONS.find(
    (operation) => operationKey(operation) === 'PATCH /catalog/:key/integration-metadata',
  );

  it('is the schema the route table validates against', () => {
    expect(patch).toBeDefined();
    expect(patch?.request).toBe(IntegrationMetadataRequestSchema);
  });

  it('accepts the three declared members and a session maximum', () => {
    for (const value of ['scoped', 'account', 'none'] as const) {
      expect(
        IntegrationMetadataRequestSchema.safeParse({ credentialGranularity: value }).success,
      ).toBe(true);
    }
    expect(IntegrationMetadataRequestSchema.safeParse({ sessionMaxMinutes: 480 }).success).toBe(
      true,
    );
  });

  it('rejects an undeclared value and a partial patch of the wrong shape', () => {
    expect(
      IntegrationMetadataRequestSchema.safeParse({ credentialGranularity: 'banana' }).success,
    ).toBe(false);
    expect(IntegrationMetadataRequestSchema.safeParse({ sessionMaxMinutes: -1 }).success).toBe(
      false,
    );
    expect(IntegrationMetadataRequestSchema.safeParse({ sessionMaxMinutes: 1.5 }).success).toBe(
      false,
    );
  });
});
