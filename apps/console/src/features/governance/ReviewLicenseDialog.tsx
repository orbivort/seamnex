import { useState } from 'react';
import { toProblem, useRecordLicenseReview } from '@seamnex/api-client';
import { licenseTerms, type LicenseRecord } from '@seamnex/domain';
import { Button, Checkbox, Dialog, Field, Input, Switch, Textarea } from '@seamnex/ui';

/**
 * ADR-BE-25: the auditor's half of the two-party gate.
 *
 * The form deliberately has no reviewer field: the server takes the identity from the session and
 * the timestamp from its own clock. What the auditor supplies is the term and the evidence behind
 * it, which is what a second person can check later.
 */
export function ReviewLicenseDialog({
  record,
  open,
  onOpenChange,
}: {
  record: LicenseRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const review = useRecordLicenseReview(record.instanceId);
  const [licenseId, setLicenseId] = useState(record.licenseId);
  const [upstreamRef, setUpstreamRef] = useState(record.upstreamRef ?? '');
  const [obligations, setObligations] = useState(record.obligations.join('\n'));
  const [noObligations, setNoObligations] = useState(record.obligations.length === 0);
  const [resaleRestricted, setResaleRestricted] = useState(record.resaleRestricted);
  const [hostedRestricted, setHostedRestricted] = useState(record.hostedServiceRestricted);
  const [note, setNote] = useState(record.reviewNote ?? '');
  const [acknowledgeUnknown, setAcknowledgeUnknown] = useState(false);
  const [touched, setTouched] = useState(false);

  const parsedObligations = noObligations
    ? []
    : obligations
        .split('\n')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
  // Same rule the server applies, stated here so the dialog does not ask for a round trip it can
  // answer itself.
  const unknownLicence = licenseId.trim() !== '' && licenseTerms(licenseId) === null;
  const licenceError = licenseId.trim() === '' ? 'Enter the licence identifier.' : null;
  const referenceError =
    upstreamRef.trim() === '' ? 'Record the artefact the review was checked against.' : null;
  const obligationsError =
    parsedObligations.length === 0 && !noObligations
      ? 'List the obligations, or confirm that none apply.'
      : null;
  const unknownError =
    unknownLicence && !acknowledgeUnknown
      ? 'Confirm that you reviewed this unknown licence.'
      : null;
  const problem = review.error ? toProblem(review.error) : null;

  const submit = () => {
    setTouched(true);
    if (licenceError !== null || referenceError !== null || obligationsError !== null) return;
    if (unknownError !== null) return;
    review.mutate(
      {
        licenseId: licenseId.trim(),
        obligations: parsedObligations,
        resaleRestricted,
        hostedServiceRestricted: hostedRestricted,
        upstreamRef: upstreamRef.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        acknowledgeUnknownLicence: acknowledgeUnknown,
        confirmNoObligations: noObligations,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Record the licence review for ${record.product}`}
      description="The reviewer and timestamp are taken from your session. A cleared record always carries the reference below, so a second person can check the term later."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={review.isPending}>
            {review.isPending ? 'Recording…' : 'Record review'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Licence identifier" htmlFor="review-license-id" required>
            <Input
              id="review-license-id"
              value={licenseId}
              maxLength={120}
              onChange={(event) => setLicenseId(event.target.value)}
              invalid={touched && licenceError !== null}
            />
          </Field>
          <Field
            label="Upstream reference"
            htmlFor="review-upstream-ref"
            required
            hint="LICENSE URL, or the commercial contract id."
          >
            <Input
              id="review-upstream-ref"
              value={upstreamRef}
              maxLength={500}
              placeholder="https://…/LICENSE or CONTRACT-2026-014"
              onChange={(event) => setUpstreamRef(event.target.value)}
              invalid={touched && referenceError !== null}
            />
          </Field>
        </div>

        {touched && licenceError !== null ? (
          <p role="alert" className="text-meta font-medium text-danger">
            {licenceError}
          </p>
        ) : null}
        {touched && referenceError !== null ? (
          <p role="alert" className="text-meta font-medium text-danger">
            {referenceError}
          </p>
        ) : null}

        <Field
          label="Obligations"
          htmlFor="review-obligations"
          hint="One per line. These replace the catalogue defaults for this instance."
        >
          <Textarea
            id="review-obligations"
            rows={4}
            value={obligations}
            disabled={noObligations}
            onChange={(event) => setObligations(event.target.value)}
            invalid={touched && obligationsError !== null}
          />
        </Field>
        <Checkbox
          label="No obligations apply"
          description="Records an explicit “none” instead of leaving the list blank."
          checked={noObligations}
          onChange={(event) => setNoObligations(event.target.checked)}
        />
        {touched && obligationsError !== null ? (
          <p role="alert" className="text-meta font-medium text-danger">
            {obligationsError}
          </p>
        ) : null}

        {unknownLicence ? (
          <Checkbox
            label="This licence is not in the platform table"
            description="I checked this identifier against the upstream LICENSE file or the contract and want to record it anyway."
            checked={acknowledgeUnknown}
            onChange={(event) => setAcknowledgeUnknown(event.target.checked)}
          />
        ) : null}
        {touched && unknownError !== null ? (
          <p role="alert" className="text-meta font-medium text-danger">
            {unknownError}
          </p>
        ) : null}

        <div className="space-y-3 rounded-sm border border-line bg-panel-soft/60 px-3.5 py-3">
          <Switch
            label="Resale is restricted"
            description="The licence forbids reselling the product."
            checked={resaleRestricted}
            onCheckedChange={setResaleRestricted}
          />
          <Switch
            label="Hosted-service provision is restricted"
            description="The licence forbids offering the product to third parties as a service (C-3)."
            checked={hostedRestricted}
            onCheckedChange={setHostedRestricted}
          />
        </div>

        <Field
          label="Reviewer note"
          htmlFor="review-note"
          optionalLabel="optional"
          hint="Kept on the record; the audit trail stores only its length."
        >
          <Textarea
            id="review-note"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>

        {problem ? (
          <div
            role="alert"
            className="rounded-sm border border-danger-border bg-danger-soft px-3.5 py-3"
          >
            <p className="text-body font-semibold text-danger-strong">{problem.title}</p>
            <p className="mt-1 text-body leading-snug text-muted">{problem.detail}</p>
            {problem.fieldErrors.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5">
                {problem.fieldErrors.map((issue) => (
                  <li key={`${issue.field}-${issue.code}`} className="text-meta text-danger-strong">
                    {issue.field}: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
