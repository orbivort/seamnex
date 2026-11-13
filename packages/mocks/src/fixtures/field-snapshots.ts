import type { FieldDescriptor, FieldDiscoveryStatus } from '@seamnex/domain';

export type FieldFixture = {
  readonly status: FieldDiscoveryStatus;
  readonly fields: readonly FieldDescriptor[];
  readonly detail: string | null;
};

/**
 * What the mock server answers for `GET /workflows/:id/nodes/:nodeId/fields`.
 *
 * The point of the fixture is the three-way answer the console has to render: a product that
 * publishes a schema (EspoCRM, OpenProject), one that does not (Mautic, OrangeHRM), and a product
 * that is not deployed. A demo that only ever showed `available` would hide the fallback path.
 */
const ESPO_CONTACT: readonly FieldDescriptor[] = [
  { name: 'firstName', label: 'First name', type: 'string', required: false },
  { name: 'lastName', label: 'Last name', type: 'string', required: true },
  { name: 'emailAddress', label: 'Email', type: 'string', required: true },
  { name: 'phoneNumber', label: 'Phone', type: 'string', required: false },
  { name: 'title', label: 'Title', type: 'string', required: false },
  { name: 'accountId', label: 'Account', type: 'string', required: false },
  { name: 'consentSource', label: 'Consent source', type: 'string', required: false },
  { name: 'description', label: 'Description', type: 'string', required: false },
];

const WORK_PACKAGE: readonly FieldDescriptor[] = [
  { name: 'subject', label: 'Subject', type: 'string', required: true },
  { name: 'description', label: 'Description', type: 'string', required: false },
  { name: 'startDate', label: 'Start date', type: 'date', required: false },
  { name: 'dueDate', label: 'Due date', type: 'date', required: false },
  { name: 'estimatedHours', label: 'Estimated hours', type: 'number', required: false },
  { name: 'percentageDone', label: 'Percent complete', type: 'number', required: false },
];

export function fieldFixture(entryKey: string | null, operation: string | null): FieldFixture {
  if (entryKey === 'D01-01' && operation?.startsWith('contacts.')) {
    return { status: 'available', fields: ESPO_CONTACT, detail: null };
  }
  if (entryKey === 'D09-01' && operation?.startsWith('work_packages.')) {
    return { status: 'available', fields: WORK_PACKAGE, detail: null };
  }
  if (entryKey === 'D07-01') {
    return {
      status: 'unsupported',
      fields: [],
      detail:
        'OrangeHRM publishes no schema for the fields an operation accepts, so field names have to be entered manually and are not validated.',
    };
  }
  if (entryKey === null) {
    return {
      status: 'unsupported',
      fields: [],
      detail: 'This node is not bound to a product operation, so there are no product fields.',
    };
  }
  return {
    status: 'unsupported',
    fields: [],
    detail: `${entryKey} was not asked for a schema in this prototype; target names are typed by hand.`,
  };
}

/**
 * A redacted item a node received, shaped like the Mautic lead in `wf-lead-capture` so the sample
 * list lines up with that workflow's existing `lead.*` mappings.
 */
export const LEAD_SAMPLE: Record<string, unknown> = {
  lead: {
    id: 'lead-8841',
    email: 'ops@northwind.example',
    company: 'Northwind',
    consentSource: 'webinar-2026-03',
    fullName: 'Mei Chen',
    country: 'DE',
  },
  event: { type: 'segment.member.added', occurredAt: '2026-11-12T08:41:00Z' },
};

export function sampleItemFor(workflowId: string): Record<string, unknown> | null {
  return workflowId === 'wf-lead-capture' ? LEAD_SAMPLE : null;
}
