import { useState } from 'react';
import { useEnvImport } from '@seamnex/api-client';
import { Alert, Button, Drawer, Field, InlineNote, Select, Textarea } from '@seamnex/ui';

/**
 * FR-1.30: import an existing `.env` or Compose environment. The platform maps declared
 * variables, withholds secrets (they are entered here, never imported) and reports keys it
 * cannot place. Applied values land in the wizard state, never straight into a deployment.
 */
export function EnvImportControl({
  entryKey,
  onApply,
}: {
  entryKey: string;
  onApply: (values: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'dotenv' | 'compose'>('dotenv');
  const [content, setContent] = useState('');
  const importer = useEnvImport(entryKey);

  const acceptable = (importer.data?.mapped ?? []).filter(
    (item) => item.accepted && item.value !== null,
  );
  const rejected = (importer.data?.mapped ?? []).filter((item) => !item.accepted);

  const close = () => {
    setOpen(false);
    importer.reset();
    setContent('');
  };

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Import .env
      </Button>
      <Drawer
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title="Import an existing environment"
        description="Paste a .env file or the environment block of a Compose file. Values are mapped into the declared schema."
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            {importer.data ? (
              <Button
                variant="primary"
                disabled={acceptable.length === 0}
                onClick={() => {
                  onApply(
                    Object.fromEntries(acceptable.map((item) => [item.name, item.value ?? ''])),
                  );
                  close();
                }}
              >
                Apply {acceptable.length} value{acceptable.length === 1 ? '' : 's'}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={importer.isPending || content.trim().length === 0}
                onClick={() => importer.mutate({ source, content })}
              >
                {importer.isPending ? 'Mapping…' : 'Map values'}
              </Button>
            )}
          </>
        }
      >
        {importer.isError ? (
          <div className="mb-3">
            <Alert tone="danger" title="The environment could not be mapped">
              {importer.error instanceof Error
                ? importer.error.message
                : 'Retry with a .env or Compose environment block.'}
            </Alert>
          </div>
        ) : null}

        <div className="space-y-3">
          <Field
            label="Source format"
            htmlFor="import-source"
            hint="Compose files are read from their environment block."
          >
            <Select
              id="import-source"
              value={source}
              onChange={(event) => setSource(event.target.value as 'dotenv' | 'compose')}
            >
              <option value="dotenv">.env file (KEY=value)</option>
              <option value="compose">Compose environment block</option>
            </Select>
          </Field>
          <Field
            label="Content"
            htmlFor="import-content"
            hint="Nothing is written until you apply the mapped values."
          >
            <Textarea
              id="import-content"
              value={content}
              rows={10}
              spellCheck={false}
              placeholder={'ADMIN_EMAIL=portal-admin@seamnex.local\nSMTP_HOST=smtp.seamnex.local'}
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
        </div>

        {importer.data ? (
          <div className="mt-4 space-y-3">
            <p className="font-mono text-faint label-caps">
              {importer.data.parsed} parsed · {acceptable.length} usable · {rejected.length}{' '}
              rejected
            </p>
            <ul className="divide-y divide-line rounded-sm border border-line">
              {(importer.data.mapped ?? []).map((item) => (
                <li
                  key={item.name}
                  className="flex items-start justify-between gap-3 px-2.5 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-micro text-text">{item.name}</span>
                    <span className="block text-micro leading-snug text-faint">
                      {item.reason ?? 'Mapped from the pasted content.'}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-micro text-muted">
                    {item.value === null ? 'withheld' : item.value}
                  </span>
                </li>
              ))}
            </ul>
            {(importer.data.unmapped ?? []).length > 0 ? (
              <InlineNote>
                Not in the declared schema: {(importer.data.unmapped ?? []).join(', ')}. They are
                ignored rather than passed to the container.
              </InlineNote>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
