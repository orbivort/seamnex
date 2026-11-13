import type { PrivacyRequest } from '@seamnex/domain';
import { at, daysAgo } from './context';

/**
 * NFR-4.13. Requests are addressed by the pseudonymous `subject_ref`; platform-tier scopes are
 * mandatory because a subject's data is not only inside products.
 */
export const PRIVACY_REQUESTS: PrivacyRequest[] = [
  {
    id: 'pr-4102',
    subjectRef: 'sub_44c1',
    kind: 'export',
    state: 'running',
    openedBy: 'Ruth Adler',
    openedAt: at(-220),
    dueAt: at(10 * 24 * 60),
    closedAt: null,
    scopes: [
      {
        scopeType: 'platform',
        scopeId: 'entitlements',
        label: 'Entitlements and role bindings',
        state: 'complete',
        detail: '6 grants exported with scope labels.',
      },
      {
        scopeType: 'platform',
        scopeId: 'audit_event',
        label: 'Audit events (subject_ref)',
        state: 'complete',
        detail: '34 events matched the pseudonymous reference.',
      },
      {
        scopeType: 'platform',
        scopeId: 'job_log',
        label: 'Job logs',
        state: 'complete',
        detail: '12 log lines exported; secrets masked.',
      },
      {
        scopeType: 'platform',
        scopeId: 'idp_user',
        label: 'Identity-provider record',
        state: 'complete',
        detail: 'Profile, groups and MFA enrolment exported.',
      },
      {
        scopeType: 'product',
        scopeId: 'inst-helpdesk',
        label: 'D03-01 Zammad — tickets and articles',
        state: 'running',
        detail: 'Product export running through the brokered credential.',
      },
      {
        scopeType: 'product',
        scopeId: 'inst-collab',
        label: 'D10-01 Nextcloud — files and shares',
        state: 'pending',
        detail: 'Queued behind the helpdesk export.',
      },
    ],
    evidence: [
      'idp_user export complete',
      'audit_event rows: 34',
      'job_log rows: 12',
      'product scopes queued (D03-01, D10-01)',
    ],
  },
  {
    id: 'pr-4103',
    subjectRef: 'sub_6e77',
    kind: 'delete',
    state: 'open',
    openedBy: 'Ruth Adler',
    openedAt: daysAgo(1),
    dueAt: at(29 * 24 * 60),
    closedAt: null,
    scopes: [
      {
        scopeType: 'platform',
        scopeId: 'idp_user',
        label: 'Identity-provider record',
        state: 'pending',
        detail: 'Account closure awaits the product scopes.',
      },
      {
        scopeType: 'platform',
        scopeId: 'subject_ref',
        label: 'Subject mapping',
        state: 'pending',
        detail:
          'Deleting the mapping is the erasure; the audit chain keeps only the opaque reference.',
      },
      {
        scopeType: 'product',
        scopeId: 'inst-helpdesk',
        label: 'D03-01 Zammad — guest tickets',
        state: 'pending',
        detail: 'Guest surface scoped to the invitation.',
      },
    ],
    evidence: ['Request accepted with a recorded legal basis'],
  },
];
