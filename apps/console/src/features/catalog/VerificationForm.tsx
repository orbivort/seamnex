import { useState } from 'react';
import type { useVerifyIntegrationMetadata } from '@seamnex/api-client';
import type { IntegrationMetadataVerification } from '@seamnex/api-client';
import {
  CREDENTIAL_GRANULARITY_OPTIONS,
  GUARANTEE_CLASS_LABELS,
  GUARANTEE_CLASSES,
  isWorkflowEligible,
  isWriteEligible,
  writeIneligibilityReason,
  type CatalogEntry,
  type CredentialGranularity,
  type EventMode,
  type GuaranteeClass,
  type Operation,
} from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  Select,
  Textarea,
} from '@seamnex/ui';
import { QueryError } from '@seamnex/shell';

/** Names used in the "what changed" receipt and in the audit diff. */
export const FACT_LABELS: Record<keyof IntegrationMetadataVerification, string> = {
  apiBaseUrl: 'API base URL',
  authMethod: 'Authentication method',
  guaranteeClass: 'Guarantee class',
  credentialGranularity: 'Credential granularity',
  sessionMaxMinutes: 'Session maximum',
  sloSupported: 'Single logout',
  operationInventory: 'Operation inventory',
  eventModes: 'Event modes',
};

/**
 * FR-2.14 / FR-2.15 / AC-41 — record what onboarding actually verified.
 *
 * The form used to offer one field (granularity) and resubmitted the session maximum it had just
 * read, so pressing "record" always produced a "change" and the review clock restarted on nothing.
 * Now every fact has an input, the submit action stays disabled until one of them differs from the
 * record, and only the changed facts travel — an omitted field means "leave it alone", never "reset
 * it to the catalogue document".
 */
export function VerificationForm({
  entry,
  verify,
  canVerify,
}: {
  entry: CatalogEntry;
  verify: ReturnType<typeof useVerifyIntegrationMetadata>;
  canVerify: boolean;
}) {
  const integration = entry.integration;
  const [authMethod, setAuthMethod] = useState(integration.authMethod);
  const [apiBaseUrl, setApiBaseUrl] = useState(integration.apiBaseUrl);
  const [guaranteeClass, setGuaranteeClass] = useState<GuaranteeClass>(
    integration.guaranteeClassVerified,
  );
  const [granularity, setGranularity] = useState<CredentialGranularity>(
    integration.credentialGranularity,
  );
  const [sessionMax, setSessionMax] = useState(String(integration.sessionMaxMinutes));
  const [sloSupported, setSloSupported] = useState(integration.sloSupported);
  const [operations, setOperations] = useState(
    JSON.stringify(integration.operationInventory, null, 2),
  );
  const [eventModes, setEventModes] = useState(JSON.stringify(integration.eventModes, null, 2));

  const operationsDirty = operations !== JSON.stringify(integration.operationInventory, null, 2);
  const eventsDirty = eventModes !== JSON.stringify(integration.eventModes, null, 2);

  const payload: IntegrationMetadataVerification = {};
  if (authMethod.trim() !== integration.authMethod) payload.authMethod = authMethod.trim();
  if (apiBaseUrl.trim() !== integration.apiBaseUrl) payload.apiBaseUrl = apiBaseUrl.trim();
  if (guaranteeClass !== integration.guaranteeClassVerified)
    payload.guaranteeClass = guaranteeClass;
  if (granularity !== integration.credentialGranularity) {
    payload.credentialGranularity = granularity;
  }
  if (sessionMax !== String(integration.sessionMaxMinutes)) {
    payload.sessionMaxMinutes = Number(sessionMax);
  }
  if (sloSupported !== integration.sloSupported) payload.sloSupported = sloSupported;

  let parseError: string | null = null;
  if (operationsDirty) {
    const parsed = parseArray<Operation>(operations);
    if (typeof parsed === 'string') parseError = `Operation inventory: ${parsed}`;
    else payload.operationInventory = parsed;
  }
  if (eventsDirty && parseError === null) {
    const parsed = parseArray<EventMode>(eventModes);
    if (typeof parsed === 'string') parseError = `Event modes: ${parsed}`;
    else payload.eventModes = parsed;
  }

  const changed = Object.keys(payload) as (keyof IntegrationMetadataVerification)[];
  const invalidSession = !/^\d+$/.test(sessionMax) || Number(sessionMax) <= 0;
  const blocked = !canVerify || parseError !== null || invalidSession || changed.length === 0;

  return (
    <Panel>
      <PanelHeader
        eyebrow="FR-2.14 verification"
        title="Record what was verified"
        description="Each fact supersedes the catalogue assumption. Only the facts you change are written, and the review clock restarts only when at least one is."
      />
      <div className="space-y-4 p-4">
        {verify.isError ? <QueryError error={verify.error} compact /> : null}

        <section className="space-y-2">
          <h3 className="label-caps-sans text-faint">Authentication</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Authentication method" htmlFor="verify-auth-method">
              <Input
                id="verify-auth-method"
                value={authMethod}
                disabled={!canVerify}
                onChange={(event) => setAuthMethod(event.target.value)}
              />
            </Field>
            <Field
              label="Guarantee class"
              htmlFor="verify-guarantee"
              hint="The class the product actually delivers, which decides how far an entitlement propagates."
            >
              <Select
                id="verify-guarantee"
                value={guaranteeClass}
                disabled={!canVerify}
                onChange={(event) => setGuaranteeClass(event.target.value as GuaranteeClass)}
              >
                {GUARANTEE_CLASSES.map((option) => (
                  <option key={option} value={option}>
                    {option} · {GUARANTEE_CLASS_LABELS[option].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="label-caps-sans text-faint">API surface</h3>
          <Field
            label="API base URL"
            htmlFor="verify-api-base"
            hint="The origin the product answers on from the instance network — not necessarily the public route."
          >
            <Input
              id="verify-api-base"
              value={apiBaseUrl}
              disabled={!canVerify}
              onChange={(event) => setApiBaseUrl(event.target.value)}
            />
          </Field>
          <Field
            label="Operation inventory (JSON)"
            htmlFor="verify-operations"
            hint='Array of { "id", "label", "mode": "read" | "write" }. The workflow builder offers exactly these nodes.'
            error={parseError?.startsWith('Operation inventory') ? parseError : undefined}
          >
            <Textarea
              id="verify-operations"
              rows={5}
              value={operations}
              disabled={!canVerify}
              onChange={(event) => setOperations(event.target.value)}
            />
          </Field>
        </section>

        <section className="space-y-2">
          <h3 className="label-caps-sans text-faint">Events and triggers</h3>
          <Field
            label="Event modes (JSON)"
            htmlFor="verify-events"
            hint='Array of { "mode": "webhook" | "schedule" | "poll" | "none", "label", "minimumIntervalMinutes"? }.'
            error={parseError?.startsWith('Event modes') ? parseError : undefined}
          >
            <Textarea
              id="verify-events"
              rows={4}
              value={eventModes}
              disabled={!canVerify}
              onChange={(event) => setEventModes(event.target.value)}
            />
          </Field>
        </section>

        <section className="space-y-2">
          <h3 className="label-caps-sans text-faint">Credentials and session</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field
              label="Credential granularity"
              htmlFor="granularity"
              hint="A product that cannot issue scoped credentials is write-workflow-ineligible."
            >
              <Select
                id="granularity"
                value={granularity}
                disabled={!canVerify}
                onChange={(event) => setGranularity(event.target.value as CredentialGranularity)}
              >
                {CREDENTIAL_GRANULARITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Session maximum (minutes)"
              htmlFor="verify-session"
              error={invalidSession ? 'Enter a positive whole number of minutes.' : undefined}
            >
              <Input
                id="verify-session"
                inputMode="numeric"
                value={sessionMax}
                disabled={!canVerify}
                onChange={(event) => setSessionMax(event.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              id="verify-slo"
              label="Single logout supported"
              description="The product terminates the platform session when it signs out."
              checked={sloSupported}
              disabled={!canVerify}
              onChange={(event) => setSloSupported(event.target.checked)}
            />
            {isWriteEligible(granularity) ? null : (
              <Badge tone={granularity === 'none' ? 'danger' : 'caution'} size="sm">
                write-ineligible
              </Badge>
            )}
            {isWorkflowEligible(granularity) ? null : (
              <Badge tone="danger" size="sm">
                workflow-ineligible
              </Badge>
            )}
          </div>
          {isWriteEligible(granularity) ? null : (
            <Callout
              tone={granularity === 'none' ? 'danger' : 'caution'}
              title="What this granularity costs"
            >
              {writeIneligibilityReason(granularity)}
            </Callout>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <InlineNote>
            {changed.length === 0
              ? 'Change at least one fact before recording a verification.'
              : `Recording: ${changed.map((key) => FACT_LABELS[key]).join(', ')}.`}
          </InlineNote>
          <Button
            size="sm"
            variant="secondary"
            disabled={blocked || verify.isPending}
            onClick={() => verify.mutate(payload)}
          >
            {verify.isPending ? 'Recording…' : 'Record verified review'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** Parses a JSON array, returning the reason as a string instead of throwing into the render. */
function parseArray<T>(text: string): T[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'not valid JSON';
  }
  if (!Array.isArray(parsed)) return 'must be a JSON array';
  return parsed as T[];
}
