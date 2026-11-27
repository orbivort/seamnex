import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '@seamnex/api-client';
import type { LicenseRecord } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { ReviewLicenseDialog } from '../../src/features/governance/ReviewLicenseDialog';
import { openAs, present } from '../helpers';

/**
 * FR-1.14 / AC-44 / ADR-BE-25 — the auditor's form.
 *
 * The register's own suite (`test/integration/licenses.test.tsx`) drives the happy path through the
 * route. What belongs here is the form's contract with the auditor: what it refuses to send, what it
 * has to be told explicitly, and what it shows when the server answers with a refusal instead of a
 * cleared row. The component is mounted directly because each case starts from a different record —
 * an empty obligation list, an unknown licence — that the register cannot all present at once.
 */

function pendingRecord(): LicenseRecord {
  return present(
    getState().licenses.find((row) => row.status === 'review_required'),
    'a licence awaiting review',
  );
}

function reviewedRecord(): LicenseRecord {
  return present(
    getState().licenses.find((row) => row.status === 'cleared' && row.reviewNote !== null),
    'a licence with a recorded review',
  );
}

/** The register owns `open`; the dialog only asks to be closed, so the harness has to honour it. */
function renderDialog(record: LicenseRecord) {
  const onOpenChange = vi.fn();
  function Harness() {
    const [isOpen, setOpen] = useState(true);
    return (
      <ApiProvider>
        <ReviewLicenseDialog
          record={record}
          open={isOpen}
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange(next);
          }}
        />
      </ApiProvider>
    );
  }
  render(<Harness />);
  return { onOpenChange };
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
}

function alertText(): string[] {
  return screen.queryAllByRole('alert').map((node) => node.textContent ?? '');
}

describe('ReviewLicenseDialog', () => {
  it('opens with the recorded terms, evidence and note already in the fields', () => {
    const record = reviewedRecord();
    openAs('R2', '/governance/licenses');
    renderDialog(record);

    expect(screen.getByLabelText(/Licence identifier/)).toHaveProperty('value', record.licenseId);
    expect(screen.getByLabelText(/Upstream reference/)).toHaveProperty('value', record.upstreamRef);
    expect(screen.getByLabelText('Obligations')).toHaveProperty(
      'value',
      record.obligations.join('\n'),
    );
    expect(screen.getByLabelText(/Reviewer note/)).toHaveProperty('value', record.reviewNote);

    expect(
      screen.getByRole('switch', { name: 'Resale is restricted' }).getAttribute('aria-checked'),
    ).toBe(String(record.resaleRestricted));
    expect(
      screen
        .getByRole('switch', { name: 'Hosted-service provision is restricted' })
        .getAttribute('aria-checked'),
    ).toBe(String(record.hostedServiceRestricted));
    // A reviewed record needs no "none apply" confirmation, and shows no error until it is asked to.
    expect(screen.getByRole('checkbox', { name: /No obligations apply/ })).toHaveProperty(
      'checked',
      false,
    );
    expect(alertText()).toEqual([]);
  });

  it('trims the obligations, sends the evidence and closes on the server answer', async () => {
    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);

    fireEvent.change(screen.getByLabelText('Obligations'), {
      target: { value: '  Publish modifications  \n\n   Keep the notices \n' },
    });
    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: '  https://example.invalid/LICENSE  ' },
    });
    submit();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(record.obligations).toEqual(['Publish modifications', 'Keep the notices']);
    expect(record.upstreamRef).toBe('https://example.invalid/LICENSE');
    // An untouched note is left out of the payload rather than sent as an empty string.
    expect(record.reviewNote).toBeNull();
    expect(record.status).toBe('cleared');
  });

  it('asks for an explicit "none" instead of accepting an empty obligation list', async () => {
    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);

    fireEvent.change(screen.getByLabelText('Obligations'), { target: { value: ' \n  \n' } });
    submit();

    expect(alertText()).toContain('List the obligations, or confirm that none apply.');
    expect(record.status).toBe('review_required');

    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: 'CONTRACT-2026-014' },
    });

    const none = screen.getByRole('checkbox', { name: /No obligations apply/ });
    fireEvent.click(none);

    // Choosing "none" replaces the list rather than leaving a disabled box with stale text.
    expect(screen.getByLabelText('Obligations')).toHaveProperty('disabled', true);
    expect(alertText()).toEqual([]);

    submit();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(record.obligations).toEqual([]);
    expect(record.status).toBe('cleared');
  });

  it('requires the identifier and the evidence before it sends anything', () => {
    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);

    fireEvent.change(screen.getByLabelText(/Licence identifier/), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText(/Upstream reference/), { target: { value: '' } });
    submit();

    expect(alertText()).toEqual([
      'Enter the licence identifier.',
      'Record the artefact the review was checked against.',
    ]);
    // Nothing left the form: the row is still the one the register opened with.
    expect(record.status).toBe('review_required');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('refuses a licence outside the platform table until the auditor confirms it', async () => {
    const record = pendingRecord();
    const recordedLicenseId = record.licenseId;
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);

    fireEvent.change(screen.getByLabelText(/Licence identifier/), {
      target: { value: 'Proprietary-EULA' },
    });
    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: 'CONTRACT-2026-021' },
    });
    submit();

    expect(alertText()).toContain('Confirm that you reviewed this unknown licence.');
    // The refusal is local: an unacknowledged identifier never reaches the API.
    expect(record.licenseId).toBe(recordedLicenseId);

    fireEvent.click(screen.getByRole('checkbox', { name: /not in the platform table/ }));
    expect(alertText()).toEqual([]);

    submit();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(record.licenseId).toBe('Proprietary-EULA');
    expect(record.status).toBe('cleared');
  });

  it('drops the unknown-licence prompt again when the identifier is corrected', () => {
    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    renderDialog(record);

    const licenseInput = screen.getByLabelText(/Licence identifier/);
    fireEvent.change(licenseInput, { target: { value: 'Proprietary-EULA' } });
    expect(screen.queryByRole('checkbox', { name: /not in the platform table/ })).not.toBeNull();

    fireEvent.change(licenseInput, { target: { value: 'AGPL-3.0' } });
    expect(screen.queryByRole('checkbox', { name: /not in the platform table/ })).toBeNull();
  });

  it('records both restrictions and the note the auditor wrote', async () => {
    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);

    fireEvent.click(screen.getByRole('switch', { name: 'Resale is restricted' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Hosted-service provision is restricted' }));
    fireEvent.change(screen.getByLabelText(/Reviewer note/), {
      target: { value: '  Term checked against the vendor contract  ' },
    });
    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: 'https://example.invalid/contract.pdf' },
    });
    submit();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(record.resaleRestricted).toBe(true);
    expect(record.hostedServiceRestricted).toBe(true);
    expect(record.reviewNote).toBe('Term checked against the vendor contract');
  });

  it('says the write is in flight rather than leaving the button live', async () => {
    const record = pendingRecord();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put('/api/v1/licenses/:instanceId/review', async () => {
        await gate;
        return HttpResponse.json({
          ...record,
          status: 'cleared',
          reviewedBy: 'usr-ruth-adler',
          reviewedByName: 'Ruth Adler',
          reviewedAt: new Date().toISOString(),
          upstreamRef: 'https://example.invalid/LICENSE',
        } satisfies LicenseRecord);
      }),
    );

    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);
    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: 'https://example.invalid/LICENSE' },
    });
    submit();

    const pending = await screen.findByRole('button', { name: 'Recording…' });
    expect(pending).toHaveProperty('disabled', true);

    release();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('renders a server refusal with its field issues instead of closing', async () => {
    server.use(
      http.put('/api/v1/licenses/:instanceId/review', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/state-conflict',
            title: 'The instance is still offered as a hosted service',
            status: 409,
            detail:
              'EspoCRM is currently offered as a hosted service; disable that configuration before recording a restriction.',
            code: 'STATE_CONFLICT',
            fieldErrors: [
              {
                field: 'obligations',
                code: 'confirmation_required',
                message: 'Confirm explicitly when no obligations apply.',
              },
            ],
            remediation: 'Ask the platform administrator (R1) to turn hosted-service mode off.',
          },
          { status: 409 },
        ),
      ),
    );

    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);
    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: 'https://example.invalid/LICENSE' },
    });
    submit();

    const refusal = await screen.findByRole('alert');
    expect(
      within(refusal).getByText('The instance is still offered as a hosted service'),
    ).toBeDefined();
    expect(within(refusal).getByText(/disable that configuration/)).toBeDefined();
    expect(
      within(refusal).getByText('obligations: Confirm explicitly when no obligations apply.'),
    ).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('reports an unreachable API without inventing field issues', async () => {
    server.use(http.put('/api/v1/licenses/:instanceId/review', () => HttpResponse.error()));

    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    renderDialog(record);
    fireEvent.change(screen.getByLabelText(/Upstream reference/), {
      target: { value: 'https://example.invalid/LICENSE' },
    });
    submit();

    const refusal = await screen.findByRole('alert');
    expect(within(refusal).getByText('The platform API could not be reached')).toBeDefined();
    expect(within(refusal).queryByRole('list')).toBeNull();
  });

  it('cancels without writing the review', () => {
    const record = pendingRecord();
    openAs('R2', '/governance/licenses');
    const { onOpenChange } = renderDialog(record);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(record.status).toBe('review_required');
    expect(record.reviewedAt).toBeNull();
  });
});
