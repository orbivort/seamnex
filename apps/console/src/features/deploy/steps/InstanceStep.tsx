import type { CatalogEntry, EnvProfile } from '@seamnex/domain';
import { PACKAGING_LABELS } from '@seamnex/domain';
import {
  DefinitionList,
  Field,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  Select,
  SplitLayout,
} from '@seamnex/ui';
import type { WizardValues } from './types';

export function InstanceStep({
  entry,
  values,
  errors,
  profiles,
  routeHost,
  onChange,
}: {
  entry: CatalogEntry;
  values: WizardValues;
  errors: Record<string, string>;
  profiles: EnvProfile[];
  /** The host the API will publish, from the deploy preview. Never a locally guessed domain. */
  routeHost?: string;
  onChange: (patch: Partial<WizardValues>) => void;
}) {
  return (
    <SplitLayout ratio="content">
      <Panel>
        <PanelHeader
          eyebrow="Step 1"
          title="Instance identity"
          description="The slug becomes a stable sub-domain. Deleted slugs stay reserved for 30 days."
        />
        <div className="space-y-4 p-4">
          <Field
            label="Route slug"
            required
            htmlFor="slug"
            hint={
              routeHost === undefined
                ? 'DNS label, lower-case. The published host comes from the API’s route preview, never from a guess here.'
                : `Published as ${routeHost} · the edge, not this field, supplies the scheme and port`
            }
            error={errors.slug}
          >
            <Input
              id="slug"
              value={values.slug}
              invalid={Boolean(errors.slug)}
              onChange={(event) => onChange({ slug: event.target.value.toLowerCase() })}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Environment profile"
            htmlFor="profile"
            hint="Profiles distinguish lifecycle targets on a single host: production or staging."
          >
            <Select
              id="profile"
              value={values.profileKey}
              onChange={(event) => onChange({ profileKey: event.target.value })}
            >
              {profiles.map((profile) => (
                <option key={profile.key} value={profile.key}>
                  {/* Provenance ("updated by seed") belongs in an audit view, not in a choice: it made
                      the control read like a read-only field rather than a profile picker. */}
                  {profile.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Catalog entry" htmlFor="catalog-entry">
            <Input
              id="catalog-entry"
              value={`${entry.key} · ${entry.product}`}
              readOnly
              className="bg-paper-deep font-mono text-meta"
            />
          </Field>
        </div>
      </Panel>

      <Panel>
        <PanelHeader eyebrow="What this does" title="Deployment shape" />
        <div className="p-4">
          <DefinitionList
            columns={1}
            items={[
              { label: 'Packaging', value: PACKAGING_LABELS[entry.packaging] },
              { label: 'Source', value: entry.packagingSource },
              { label: 'Services', value: ['web', ...entry.dependencies].join(', ') },
              { label: 'Volumes', value: entry.volumes.map((volume) => volume.name).join(', ') },
              { label: 'License', value: entry.licenseId },
            ]}
          />
          <InlineNote className="mt-3">
            One action creates an isolated network, dedicated volumes, database credentials and a
            route. No shell commands.
          </InlineNote>
        </div>
      </Panel>
    </SplitLayout>
  );
}
