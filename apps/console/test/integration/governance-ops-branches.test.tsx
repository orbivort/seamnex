import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { LicenseRecord, PatchRecord, PostureSummary, PrivacyRequest } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { formatDate } from '@seamnex/utils';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * Branch completeness for the governance registers.
 *
 * `licenses`/`patches`/`posture`/`privacy` drive each screen's *decisions*: a refusal, an empty
 * register, an unreadable one. What they never reach is the state a page is in while the platform
 * is still deciding, and the records whose evidence is missing rather than merely unfavourable —
 * a licence term nobody assessed, a version nobody checked, a certificate already expired, a
 * subject reference too long for a column. Those are the branches this file pins, because each of
 * them is a place where "no data" must not read as "no problem".
 *
 * `hang` answers nothing at all: `isPending` is a state the operator actually sees, and the only
 * honest way to assert it is to keep the request open for the length of the assertion.
 */
const hang = () => new Promise<Response>(() => {});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/**
 * A patch record that is current and freshly checked; each case overrides only the fact it is
 * about, so the assertion cannot pass because of an unrelated drift in the row.
 */
function patchRow(overrides: Partial<PatchRecord> = {}): PatchRecord {
  return {
    instanceId: 'inst-alpha',
    entryKey: 'D01-01',
    product: 'Alpha',
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    lastUpgradeAt: iso(-10 * DAY),
    oldestUnappliedSecurityDays: 0,
    severity: 'info',
    checkedAt: iso(-3 * HOUR),
    ...overrides,
  };
}

function posture(overrides: Partial<PostureSummary> = {}): PostureSummary {
  return {
    generatedAt: iso(-HOUR),
    sso: { native: 2, forwardAuth: 4, signInRequired: 0, totalEntries: 6 },
    missingHealthChecks: [],
    unverifiedRestores: [],
    expiringCertificates: [],
    staleMetadata: [],
    instancesWithoutHealthCheck: 0,
    totalInstances: 6,
    coveragePercent: 100,
    ...overrides,
  };
}

function privacyRequest(overrides: Partial<PrivacyRequest> = {}): PrivacyRequest {
  return {
    id: 'pr-9100',
    subjectRef: 'sub_test',
    kind: 'export',
    state: 'open',
    openedBy: 'Sofia Almeida',
    openedAt: iso(-2 * DAY),
    dueAt: iso(28 * DAY),
    closedAt: null,
    scopes: [],
    evidence: [],
    ...overrides,
  };
}

describe('license register in flight and with thin terms', () => {
  it('keeps the hosted-service control busy until the API answers', async () => {
    server.use(http.put('/api/v1/licenses/:instanceId/hosted-service', hang));

    openAs('R1', '/governance/licenses');
    render(<App />);
    await screen.findByRole('heading', { name: 'License register' });

    const [button] = await screen.findAllByRole<HTMLButtonElement>('button', {
      name: /Enable hosted-service flag for/i,
    });
    expect(button).toBeDefined();
    if (!button) throw new Error('the hosted-service control is not rendered');
    fireEvent.click(button);

    // "The platform is still deciding" and "nothing happened" must not look the same: the label
    // says the write is in flight and the control announces itself as busy while it is disabled.
    expect(await screen.findByText('Saving…')).toBeDefined();
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('separates a term with nothing recorded from one never assessed', async () => {
    const [base] = getState().licenses;
    expect(base).toBeDefined();
    if (!base) throw new Error('the license fixture is empty');
    const record = (overrides: Partial<LicenseRecord>): LicenseRecord => ({
      ...base,
      ...overrides,
    });
    getState().licenses = [
      // Unreviewed, no restrictions, no obligations: the platform knows nothing about this term.
      record({
        instanceId: 'inst-alpha',
        entryKey: 'D01-01',
        product: 'Alpha',
        licenseId: 'MIT',
        obligations: [],
        resaleRestricted: false,
        hostedServiceRestricted: false,
        status: 'review_required',
        reviewedBy: null,
        reviewedAt: null,
      }),
      // Reviewed and unencumbered — but still with no obligation text on file.
      record({
        instanceId: 'inst-beta',
        entryKey: 'D02-01',
        product: 'Beta',
        licenseId: 'Apache-2.0',
        obligations: [],
        resaleRestricted: false,
        hostedServiceRestricted: false,
        status: 'cleared',
        reviewedBy: null,
        reviewedAt: '2026-10-01T00:00:00.000Z',
      }),
    ];

    openAs('R1', '/governance/licenses');
    render(<App />);

    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('None recorded').length).toBe(2);
    // "Not assessed" is the honest word for a term the register has never seen; "none" is a claim
    // only a reviewed record may make.
    expect(within(table).getByText('not assessed')).toBeDefined();
    expect(within(table).getByText('none')).toBeDefined();
    // A review date with no named reviewer renders the date alone: the row never invents an author.
    expect(within(table).getByText(formatDate('2026-10-01T00:00:00.000Z'))).toBeDefined();
    expect(within(table).getByText('Not reviewed')).toBeDefined();
  });
});

describe('patch register with missing and stale evidence', () => {
  it('never presents an unchecked version or an unmeasured age as current', async () => {
    server.use(
      http.get('/api/v1/patch-register', () =>
        HttpResponse.json([
          patchRow({
            instanceId: 'inst-a',
            entryKey: 'D01-01',
            product: 'Alpha',
            currentVersion: 'unknown',
            latestVersion: 'unknown',
          }),
          patchRow({
            instanceId: 'inst-b',
            entryKey: 'D02-01',
            product: 'Beta',
            latestVersion: '1.1.0',
            oldestUnappliedSecurityDays: null,
            severity: 'warning',
          }),
          patchRow({
            instanceId: 'inst-c',
            entryKey: 'D03-01',
            product: 'Gamma',
            currentVersion: '2.0.0',
            latestVersion: '2.1.0',
            oldestUnappliedSecurityDays: 5,
            severity: 'info',
          }),
        ]),
      ),
    );

    openAs('R1', '/governance/patches');
    render(<App />);

    const table = await screen.findByRole('table');
    // The running and the available version are both unknown for the first row.
    expect(within(table).getAllByText('unknown').length).toBe(2);
    // …and its age is "not checked" in the security cell and in the severity pill alike.
    expect(within(table).getAllByText('not checked').length).toBe(2);
    expect(within(table).getByText('not measured')).toBeDefined();
    expect(within(table).getByText('5 days')).toBeDefined();
    // `info` has no NFR-4.7 window, so the tooltip states the age and stops rather than inventing
    // a deadline the requirements never set.
    expect(
      within(table).getByTitle(/Oldest unapplied security update is 5 days old\.$/),
    ).toBeDefined();
    expect(screen.getByText('1 not checked')).toBeDefined();
  });

  it('warns that every age on the register is stale when the oldest check is over a day old', async () => {
    server.use(
      http.get('/api/v1/patch-register', () =>
        HttpResponse.json([patchRow({ instanceId: 'inst-a', checkedAt: iso(-72 * HOUR) })]),
      ),
    );

    openAs('R1', '/governance/patches');
    render(<App />);

    expect(await screen.findByText(/· stale/)).toBeDefined();
    expect(screen.getByTitle(/so the ages below are stale/)).toBeDefined();
  });

  it('reports a fleet that is fully current without an alarm', async () => {
    server.use(
      http.get('/api/v1/patch-register', () =>
        HttpResponse.json([
          patchRow({ instanceId: 'inst-a', entryKey: 'D01-01', product: 'Alpha' }),
          patchRow({ instanceId: 'inst-b', entryKey: 'D02-01', product: 'Beta' }),
        ]),
      ),
    );

    openAs('R1', '/governance/patches');
    render(<App />);

    expect(await screen.findByText('0 behind')).toBeDefined();
    expect(screen.getByText('0 critical')).toBeDefined();
    expect(screen.getByText('2 current')).toBeDefined();
    expect(screen.queryAllByText(/not checked/).length).toBe(0);
    expect(screen.queryAllByText(/past SLA/).length).toBe(0);
  });
});

describe('security posture renewal and metadata backlog', () => {
  it('says a certificate is expired and counts a one-day debt in the singular', async () => {
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json(
          posture({
            sso: { native: 2, forwardAuth: 4, signInRequired: 1, totalEntries: 7 },
            unverifiedRestores: [
              { instanceId: 'inst-metabase', product: 'Metabase', lastVerifiedAt: null },
              {
                instanceId: 'inst-shop',
                product: 'WooCommerce',
                lastVerifiedAt: '2026-08-01T00:00:00.000Z',
              },
            ],
            expiringCertificates: [
              { host: 'theirs.seamnex.local', expiresAt: iso(-DAY), daysLeft: 0 },
              { host: 'soon.seamnex.local', expiresAt: iso(9 * DAY), daysLeft: 9 },
              { host: 'mid.seamnex.local', expiresAt: iso(21 * DAY), daysLeft: 21 },
              { host: 'ours.seamnex.local', expiresAt: iso(86 * DAY), daysLeft: 86 },
            ],
            staleMetadata: [
              {
                entryKey: 'D03-01',
                product: 'Zammad',
                verifiedAt: '2026-01-05T00:00:00.000Z',
                daysOverdue: 1,
              },
              {
                entryKey: 'D04-01',
                product: 'WooCommerce',
                verifiedAt: '2026-01-05T00:00:00.000Z',
                daysOverdue: 12,
              },
            ],
            missingHealthChecks: [{ instanceId: 'inst-metabase', product: 'Metabase' }],
            instancesWithoutHealthCheck: 1,
          }),
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Security posture' })).toBeDefined();
    // A certificate whose renewal window has closed says so; a countdown would read as headroom.
    expect(await screen.findByText('expired')).toBeDefined();
    // The three renewal tones are three different obligations: inside a fortnight, inside a month,
    // and beyond the month that still counts as "reported, not yet urgent".
    expect(screen.getByText('9 days')).toBeDefined();
    expect(screen.getByText('21 days')).toBeDefined();
    expect(screen.getByText('86 days')).toBeDefined();
    // One day overdue is one day, not "1 days".
    expect(screen.getByText('1 day overdue')).toBeDefined();
    expect(screen.getByText('12 days overdue')).toBeDefined();
    // Never verified and overdue are different debts, and the row states which one it is.
    expect(screen.getByText('no drill')).toBeDefined();
    expect(screen.getByText('overdue')).toBeDefined();
    // The entry count is a different denominator from the deployment count; when they disagree the
    // board has to say why rather than leave two numbers on the same screen contradicting.
    expect(
      screen.getByText(/7 catalog entries; shared deployments are counted once/),
    ).toBeDefined();
    expect(screen.getByText('Restores 4/6')).toBeDefined();
    expect(screen.getByText('No health check observed')).toBeDefined();
  });

  it('does not credit an empty fleet with coverage', async () => {
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json(
          posture({
            sso: { native: 0, forwardAuth: 0, signInRequired: 0, totalEntries: 0 },
            totalInstances: 0,
            coveragePercent: 0,
          }),
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByText('SSO 0/0')).toBeDefined();
    expect(screen.getByText('Restores 0/0')).toBeDefined();
    expect(screen.getByText(/Every stateful deployment has a verified restore/)).toBeDefined();
    expect(screen.getByText(/Native floor \(S-2\): 0 of 6 required/)).toBeDefined();
  });

  it('credits a fleet that meets the native floor and has every restore verified', async () => {
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json(
          posture({
            sso: { native: 6, forwardAuth: 6, signInRequired: 0, totalEntries: 12 },
            totalInstances: 12,
            coveragePercent: 100,
          }),
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    // An empty unverified list is the one case where "every restore" is a claim and not a gap.
    expect(await screen.findByText('Restores 12/12')).toBeDefined();
    expect(screen.getByText('SSO 12/12')).toBeDefined();
    // Six native deployments is the S-2 floor, so the summary states a passed floor, not a debt.
    expect(screen.getByText(/Native floor \(S-2\): 6 of 6 required/)).toBeDefined();
    expect(screen.getByText(/Every stateful deployment has a verified restore/)).toBeDefined();
  });

  it('says it is loading rather than that posture is unavailable while the board is in flight', async () => {
    server.use(http.get('/api/v1/posture', hang));

    openAs('R1', '/governance/posture');
    render(<App />);

    // A read that has not answered yet is not a failure: the badge names the wait and the panel
    // shows its skeleton, so a slow API cannot be mistaken for an unreadable one.
    expect(await screen.findByText('loading')).toBeDefined();
    expect(screen.getByRole('status', { name: 'Loading the security posture' })).toBeDefined();
    expect(screen.queryByText('posture unavailable')).toBeNull();
  });
});

describe('privacy queue selection and in-flight writes', () => {
  it('selects the request under the pointer and through the Inspect button', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole<HTMLTableRowElement>('row').slice(1);
    expect(rows.length).toBe(2);
    const [firstRow, secondRow] = rows;
    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
    if (!firstRow || !secondRow) throw new Error('the privacy queue rendered fewer than two rows');

    // A row click is the pointer affordance. It must select — the request has no page of its own,
    // so activating the row may not navigate away from the queue.
    fireEvent.click(within(secondRow).getByText('pr-4103'));
    expect(await screen.findByText('Scopes for sub_6e77')).toBeDefined();

    // The Inspect button is the keyboard path to the same selection.
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('Scopes for sub_44c1')).toBeDefined();
  });

  it('shortens a long subject reference without hiding the full value', async () => {
    getState().privacy = [privacyRequest({ subjectRef: 'sub_0123456789abcdef' })];

    openAs('R1', '/governance/privacy');
    render(<App />);

    // The queue row and the detail header both carry the short handle…
    expect((await screen.findAllByText('sub_0123…cdef')).length).toBe(1);
    expect(screen.getByText('Scopes for sub_0123…cdef')).toBeDefined();
    // …and the tooltip plus the detail body keep the identifier an operator has to check.
    expect(screen.getByText('sub_0123456789abcdef')).toBeDefined();
    expect(screen.getAllByTitle('sub_0123456789abcdef').length).toBeGreaterThan(0);
  });

  it('pluralises the scopes a closed record never completed', async () => {
    getState().privacy = [
      privacyRequest({
        state: 'complete',
        scopes: [
          {
            scopeType: 'platform',
            scopeId: 'audit_event',
            label: 'Audit events',
            state: 'pending',
            detail: 'Never reported.',
          },
          {
            scopeType: 'product',
            scopeId: 'inst-collab',
            label: 'D10-01 Nextcloud',
            state: 'pending',
            detail: 'Never reported.',
          },
        ],
      }),
    ];

    openAs('R1', '/governance/privacy');
    render(<App />);

    expect(await screen.findByText('Closed with scopes still outstanding')).toBeDefined();
    expect(screen.getByText(/2 scopes never reported completion/)).toBeDefined();
  });

  it('holds the advance control busy until the API answers', async () => {
    server.use(http.post('/api/v1/privacy/requests/:id/advance', hang));

    openAs('R1', '/governance/privacy');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Advance scope' }));
    expect(await screen.findByText('Advancing…')).toBeDefined();
  });

  it('does not close the open-request dialog until the API accepts it', async () => {
    server.use(http.post('/api/v1/privacy/requests', hang));

    openAs('R1', '/governance/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy requests' });

    fireEvent.click(screen.getByRole('button', { name: 'Open request' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Subject reference/), {
      target: { value: 'sub_44c1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open request' }));

    expect(await screen.findByText('Opening…')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('lets the operator choose the request kind in both directions', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy requests' });

    fireEvent.click(screen.getByRole('button', { name: 'Open request' }));
    const dialog = await screen.findByRole('dialog');
    const kind = within(dialog).getByLabelText(/Request kind/) as HTMLSelectElement;

    fireEvent.change(kind, { target: { value: 'delete' } });
    expect(kind.value).toBe('delete');
    // Choosing export again must actually clear the erasure, not leave the previous choice armed.
    fireEvent.change(kind, { target: { value: 'export' } });
    expect(kind.value).toBe('export');
  });

  it('closes the open-request dialog from its own cancel control', async () => {
    openAs('R1', '/governance/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy requests' });

    fireEvent.click(screen.getByRole('button', { name: 'Open request' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
