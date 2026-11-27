import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  toProblem,
  useCatalog,
  useTrustedRegistries,
  useUpdateTrustedRegistries,
} from '@seamnex/api-client';
import { registryNamespaceOf } from '@seamnex/domain';
import {
  Button,
  Callout,
  DataTable,
  Dialog,
  Field,
  Panel,
  PanelHeader,
  SkeletonLines,
  Textarea,
  defineColumns,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';
import { useCapabilities } from '../../use-capabilities';

/**
 * NFR-4.16 — the allow-list the pull and build paths enforce.
 *
 * Two things this panel must not do. It must not present the list as a statement of intent: the same
 * entries are read by the catalogue validation, the pre-flight and `DockerEngineClient`, so what is
 * shown here is what refuses an image. And it must not imply per-entry history it does not have — the
 * revision rows carry a version, a note and a hash, not "first seen" per namespace, so the table says
 * which documented images depend on each namespace instead of inventing a date.
 */
type RegistryRow = { namespace: string; usedBy: readonly string[] };

type DialogMode = 'add' | 'remove' | null;

export function TrustedRegistryPanel() {
  const registry = useTrustedRegistries();
  const catalog = useCatalog();
  const update = useUpdateTrustedRegistries();
  // Stable identity: the column memo must not be rebuilt because the mutation object was.
  const { reset: resetUpdate } = update;
  const { mutable } = useCapabilities();
  const canManage = mutable.has('settings.manage');

  const [mode, setMode] = useState<DialogMode>(null);
  const [namespaces, setNamespaces] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);

  /**
   * Which documented images come from which namespace. The mapping runs through the one parser the
   * API uses (`registryNamespaceOf`), so the console cannot disagree with the pull guard about
   * whether `espocrm/espocrm:10.0.11` is `docker.io/espocrm`.
   */
  const usage = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of catalog.data ?? []) {
      const namespace = registryNamespaceOf(entry.imageRef);
      const products = map.get(namespace) ?? [];
      if (!products.includes(`${entry.key} ${entry.product}`)) {
        products.push(`${entry.key} ${entry.product}`);
      }
      map.set(namespace, products);
    }
    return map;
  }, [catalog.data]);

  /*
   * Derived on every render on purpose: the list is tens of entries, and a memo over a value the
   * query object recreates is one more identity to keep right than it saves.
   */
  const rows: RegistryRow[] = [...(registry.data?.current.entries ?? [])]
    .sort()
    .map((namespace) => ({ namespace, usedBy: usage.get(namespace) ?? [] }));

  const columns = useMemo(
    () =>
      defineColumns<RegistryRow>([
        {
          id: 'namespace',
          header: 'Namespace',
          primary: true,
          mono: true,
          cell: (row) => row.namespace,
        },
        {
          id: 'used',
          header: 'Documented images',
          cell: (row) =>
            row.usedBy.length === 0 ? (
              <span className="text-micro text-faint">no catalog entry uses it</span>
            ) : (
              <span className="text-meta text-muted">{row.usedBy.join(' · ')}</span>
            ),
        },
        {
          id: 'remove',
          header: '',
          width: '96px',
          cell: (row) =>
            canManage ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode('remove');
                  setNamespaces(row.namespace);
                  setNote('');
                  setTouched(false);
                  resetUpdate();
                }}
              >
                Remove
              </Button>
            ) : null,
        },
      ]),
    [canManage, resetUpdate],
  );

  /**
   * What a removal costs. Named, not counted: "2 products affected" sends an operator to the
   * catalogue to find out which, and the next deployment is the thing that fails.
   */
  const affected =
    mode === 'remove'
      ? rows
          .filter((row) =>
            namespaces
              .split('\n')
              .map((value) => value.trim())
              .includes(row.namespace),
          )
          .flatMap((row) => row.usedBy)
      : [];

  const problem = update.error ? toProblem(update.error) : null;
  const noteError = note.trim().length < 10 ? 'State why the allow-list is changing.' : null;
  const namespaceError = namespaces.trim().length === 0 ? 'Enter at least one namespace.' : null;

  const open = (next: Exclude<DialogMode, null>) => {
    setMode(next);
    setNamespaces('');
    setNote('');
    setTouched(false);
    update.reset();
  };

  const submit = () => {
    setTouched(true);
    if (noteError !== null || namespaceError !== null) return;
    const list = namespaces
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    update.mutate(
      {
        add: mode === 'add' ? list : [],
        remove: mode === 'remove' ? list : [],
        note: note.trim(),
      },
      { onSuccess: () => setMode(null) },
    );
  };

  return (
    <Panel>
      <PanelHeader
        eyebrow="Image trust"
        title="Trusted registry allow-list"
        description="Every pull and build is checked against this list. An image outside it is refused before a container starts, and the only remedy is a new revision here."
        actions={
          <div className="flex items-center gap-2">
            {registry.data ? (
              <span
                className="font-mono text-micro text-muted"
                title={`Content hash ${registry.data.current.contentHash}`}
              >
                rev {registry.data.current.version} · {registry.data.current.entries.length} entries
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh the allow-list"
              onClick={() => void registry.refetch()}
              disabled={registry.isFetching}
            >
              <RefreshCw
                className={registry.isFetching ? 'size-4 animate-spin' : 'size-4'}
                aria-hidden
              />
            </Button>
            {canManage ? (
              <Button variant="secondary" size="sm" onClick={() => open('add')}>
                Add namespaces
              </Button>
            ) : null}
          </div>
        }
      />
      <AsyncPanel
        query={registry}
        loading={
          <div className="p-4">
            <SkeletonLines lines={5} />
          </div>
        }
        loadingLabel="Loading the trusted-registry allow-list"
      >
        {(data) => (
          <>
            <p className="border-b border-line px-4 py-2 text-meta text-muted">
              Revision {data.current.version}, {data.current.entries.length} entries, recorded{' '}
              {formatRelative(data.current.createdAt)} by {data.current.createdBy}.
              {data.current.note === null ? null : ` ${data.current.note}`}
            </p>
            {catalog.isError ? (
              <Callout tone="caution" className="m-4" title="Products cannot be attributed">
                The catalogue could not be read, so this table cannot say which products depend on
                each namespace. The allow-list itself is unaffected.
              </Callout>
            ) : null}
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.namespace}
              dense
              caption="Registries and namespaces an image may come from, with the documented products that use them."
            />
            <div className="border-t border-line px-4 py-2">
              <p className="text-micro text-faint">
                History: {data.history.length} recorded revisions
                {data.history[0] === undefined
                  ? '.'
                  : `, newest ${formatDateTime(data.history[0].createdAt)}.`}
              </p>
            </div>
          </>
        )}
      </AsyncPanel>

      <Dialog
        open={mode !== null}
        onOpenChange={(next) => (next ? undefined : setMode(null))}
        title={mode === 'remove' ? 'Remove trusted namespaces' : 'Add trusted namespaces'}
        description={
          mode === 'remove'
            ? 'Removing a namespace refuses every image from it at the next pull or build. The products below cannot be deployed again until it is added back.'
            : 'One namespace per line, e.g. ghcr.io/team or docker.io/library. The change is recorded as a new revision and audited.'
        }
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button
              variant={mode === 'remove' ? 'danger' : 'primary'}
              onClick={submit}
              disabled={update.isPending}
            >
              {update.isPending ? 'Recording…' : `Record revision`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Namespaces"
            htmlFor="registry-namespaces"
            required
            hint="One per line. Values are normalised to registry/namespace before they are stored."
          >
            <Textarea
              id="registry-namespaces"
              rows={4}
              value={namespaces}
              onChange={(event) => setNamespaces(event.target.value)}
              invalid={touched && namespaceError !== null}
            />
          </Field>
          {touched && namespaceError !== null ? (
            <p role="alert" className="text-meta font-medium text-danger">
              {namespaceError}
            </p>
          ) : null}

          {affected.length > 0 ? (
            <Callout tone="caution" title="These products would lose their image">
              {affected.join(' · ')}. Their next deploy or reconfigure is refused until the
              namespace is trusted again.
            </Callout>
          ) : null}

          <Field
            label="Reason"
            htmlFor="registry-note"
            required
            hint="Kept on the revision and in the audit trail; every allow-list change is audited."
          >
            <Textarea
              id="registry-note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              invalid={touched && noteError !== null}
            />
          </Field>
          {touched && noteError !== null ? (
            <p role="alert" className="text-meta font-medium text-danger">
              {noteError}
            </p>
          ) : null}

          {problem ? (
            <div
              role="alert"
              className="rounded-sm border border-danger-border bg-danger-soft px-3.5 py-3"
            >
              <p className="text-body font-semibold text-danger-strong">{problem.title}</p>
              <p className="mt-1 text-body leading-snug text-muted">{problem.detail}</p>
            </div>
          ) : null}
        </div>
      </Dialog>
    </Panel>
  );
}
