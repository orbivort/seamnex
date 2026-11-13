import { useState } from 'react';
import {
  useAdminCredential,
  useProvisionRelayAccounts,
  useSetAdminCredential,
} from '@seamnex/api-client';
import type { InstanceDetail, RelayProvisionReport } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  Drawer,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  SkeletonLines,
} from '@seamnex/ui';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/**
 * ADR-BE-22 §Credentials — the one credential the provisioning sweep cannot derive.
 *
 * A `password` product reuses the administrator login its installer created, and an entry with no
 * adapter never provisions. A `bearer` product (OpenProject) accepts only a personal access token,
 * and a token is minted only inside an authenticated session — the seeded administrator is the
 * break-glass account, so the platform must not enter that session. The operator therefore creates
 * the token in the product and stores it here.
 *
 * Two things the panel deliberately does not do: it never shows the stored value (the API has no
 * field for it) and it never asks for it twice. Replacing a token is a new write, versioned in the
 * store and audited as `instance.admin_credential.updated`.
 */
export function AdminCredentialPanel({
  instance,
  canEdit,
}: {
  instance: InstanceDetail;
  canEdit: boolean;
}) {
  const credential = useAdminCredential(instance.id, { enabled: canEdit });
  const set = useSetAdminCredential(instance.id);
  const provision = useProvisionRelayAccounts(instance.id);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');

  /*
   * The read is `instance.env`, so a role without it must not mount the query (a disabled query
   * would also leave `AsyncPanel` on its loading branch forever). The tab that hosts this panel is
   * already gated on the same capability; this is the second half of the same decision.
   */
  if (!canEdit) return null;

  const close = () => {
    setOpen(false);
    setToken('');
    set.reset();
  };

  return (
    <Panel>
      <PanelHeader
        eyebrow="ADR-BE-22"
        title="Product administrator token"
        description="The credential the sign-in relay provisions per-user product accounts with. Stored write-only in the platform secret store."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/*
              ADR-BE-22: the same pass the deployment event and the sweep run, for an operator who
              has just fixed something and does not want to wait for a cadence. Restarting the
              scheduler used to be this button.
            */}
            {credential.data !== undefined && credential.data.kind !== 'none' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={provision.isPending}
                onClick={() => provision.mutate()}
              >
                {provision.isPending ? 'Provisioning…' : 'Provision now'}
              </Button>
            ) : null}
            {credential.data?.required === true ? (
              <Button
                size="sm"
                variant={credential.data.configured ? 'secondary' : 'primary'}
                onClick={() => setOpen(true)}
              >
                {credential.data.configured ? 'Replace token' : 'Add token'}
              </Button>
            ) : null}
          </div>
        }
      />
      <AsyncPanel
        query={credential}
        loading={
          <div className="p-4">
            <SkeletonLines lines={2} />
          </div>
        }
        loadingLabel="Loading the administrator credential"
        renderError={(error, retry) => (
          <div className="p-4">
            <QueryError error={error} onRetry={retry} />
          </div>
        )}
        empty={() => null}
      >
        {(data) => (
          <div className="space-y-2 p-4">
            {data.kind === 'none' ? (
              <p className="text-meta text-muted">
                This entry registers no provisioning adapter, so the relay creates no product
                accounts. Mappings are created by hand and no token is read.
              </p>
            ) : data.kind === 'password' ? (
              <p className="text-meta text-muted">
                This product provisions with the administrator login its installer created, held as
                instance variables. No API token is needed or read.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={data.configured ? 'positive' : 'caution'} size="sm">
                    {data.configured ? 'configured' : 'not configured'}
                  </Badge>
                  <span className="font-mono text-micro text-muted">{data.name}</span>
                  {data.version === null ? null : (
                    <span className="font-mono text-micro text-faint">v{data.version}</span>
                  )}
                </div>
                <p className="text-meta leading-snug text-muted">
                  {data.configured
                    ? 'The sweep can authenticate to the product’s API, create the per-user accounts and rotate their passwords.'
                    : 'Until a token is stored, every launch falls back to the product’s own login form and the sweep records admin_credential_missing.'}
                </p>
              </>
            )}
          </div>
        )}
      </AsyncPanel>

      {set.isError ? <QueryError error={set.error} compact /> : null}
      {set.data ? (
        <Callout tone="positive" title="Token stored">
          Launches will be signed in from the next pass on — press “Provision now” to run it
          immediately instead of waiting for the sweep.
        </Callout>
      ) : null}

      {/*
        The pass answers in counts, never in reassurance: three different zeroes mean three
        different things, and an operator needs to know which one they are looking at.
      */}
      {provision.isError ? <QueryError error={provision.error} compact /> : null}
      {provision.data ? (
        <Callout
          tone={provision.data.failed > 0 ? 'caution' : 'positive'}
          title="Provisioning pass finished"
        >
          {describeProvision(provision.data)}
        </Callout>
      ) : null}

      <Drawer
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        title={`${credential.data?.configured === true ? 'Replace' : 'Add'} administrator token`}
        description="Create the token in the product as an administrator, then paste it here once."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={set.isPending || token.trim().length < 8}
              onClick={() => {
                set.mutate(token, { onSuccess: close });
              }}
            >
              {set.isPending ? 'Storing…' : 'Store token'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label
            htmlFor="admin-credential-token"
            className="block text-meta font-medium text-muted"
          >
            Administrator API token
          </label>
          <Input
            id="admin-credential-token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <InlineNote>
            The value is written to the platform secret store, never returned by the API and never
            shown again. Replacing it appends a version and is recorded in the audit log against
            your account.
          </InlineNote>
        </div>
      </Drawer>
    </Panel>
  );
}

/**
 * The pass reports counts, and its zeroes are not interchangeable: a disabled relay, a relay with no
 * allow-list and a relay whose candidates are all ineligible need three different fixes, so the
 * panel names which one happened instead of printing "0".
 */
function describeProvision(report: RelayProvisionReport): string {
  if (!report.enabled) {
    return 'The sign-in relay is disabled for this deployment (SEAMNEX_RELAY_ENABLED). Nothing was attempted; a relaunch with the relay enabled is what changes this.';
  }
  if (!report.configured) {
    return 'No entry is allow-listed (SEAMNEX_RELAY_ENTRY_KEYS), so no pass can ever select an account to create.';
  }
  if (report.considered === 0) {
    return 'The configuration is right and nobody was eligible: entitlements exist only for disabled directory users, or every instance of these entries is not running.';
  }
  const accounts = report.provisioned === 1 ? 'account' : 'accounts';
  return `${report.provisioned} ${accounts} created or refreshed, ${report.failed} failed, out of ${report.considered} considered. The per-candidate reason for a failure is in the audit log (relay.account.provision_failed).`;
}
