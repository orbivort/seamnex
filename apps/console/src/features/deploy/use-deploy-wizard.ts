import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  toProblem,
  useCapacity,
  useCatalogEntry,
  useDeploy,
  useDeployPreview,
  useEnvPlan,
  useEnvProfiles,
  useEnvSchema,
  useInstances,
  usePolicyExceptions,
  type DeployInput,
} from '@seamnex/api-client';
import type {
  AdmissionOutcome,
  CatalogEntry,
  EnvPlanValue,
  EnvSchemaVar,
  PolicyException,
} from '@seamnex/domain';
import { admissionVerdict, PACKAGING_LABELS } from '@seamnex/domain';
import { useDebouncedValue } from '@seamnex/shell';
import { formatDate, formatRelative } from '@seamnex/utils';
import type { PreflightCheck, WizardValues } from './steps/types';

/**
 * Exported because the two consumers need the same list for different reasons: the hook clamps
 * "next" to the last index, and the page renders the Stepper and the "step N / M" label from it.
 */
export const STEPS = [
  { id: 'identity', label: 'Identity', description: 'Slug and profile' },
  { id: 'source', label: 'Source', description: 'Resolution path' },
  { id: 'env', label: 'Environment', description: 'Declared variables' },
  { id: 'resources', label: 'Resources', description: 'Admission' },
  { id: 'review', label: 'Review', description: 'Confirm and deploy' },
];

/** Used only until the catalog entry (with its reviewed shape) arrives. */
const DEFAULT_RESOURCES = { cpu: 1, memoryMb: 2048, diskMb: 20480 };

/**
 * A failure rendered as a sentence, never as `[object Object]` or an empty string.
 *
 * Exported because the page also prints one refusal the hook does not derive: the capacity read
 * failure it hands to the resources step. One rule for turning an error into copy, one place.
 */
export function problemText(error: unknown): string {
  return toProblem(error).detail;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32);
}

function defaultsFor(
  vars: EnvSchemaVar[],
  current: Record<string, string>,
): Record<string, string> {
  const next = { ...current };
  for (const variable of vars) {
    if (next[variable.name] === undefined) {
      next[variable.name] = variable.defaultValue ?? '';
    }
  }
  return next;
}

/**
 * The plan's answer for one variable, by name. Only the fields this module reads are required, so a
 * caller that has no plan can omit the map entirely.
 */
type ResolvedEnv = ReadonlyMap<string, Pick<EnvPlanValue, 'value' | 'masked'>>;

function validate(
  step: number,
  values: WizardValues,
  vars: EnvSchemaVar[],
  declared?: { cpu: number; memoryMb: number; diskMb: number },
  resolvedEnv?: ResolvedEnv,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 0) {
    // The bound is the contract's (`SlugSchema` is 2–48), not a suggestion: the message already
    // claimed it, and a 60-character slug used to pass here only to be rejected by the request
    // validator, which surfaced as a failed preview rather than as a field error.
    // eslint-disable-next-line security/detect-unsafe-regex -- the contract's own slug pattern: single character classes, linear worst case.
    const shape = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(values.slug);
    if (!shape || values.slug.length < 2 || values.slug.length > 48) {
      errors.slug = 'Use lower-case letters, digits and dashes (2–48 characters).';
    }
  }
  if (step === 2) {
    vars.forEach((variable) => {
      if (!variable.required) return;
      const value = values.env[variable.name] ?? '';
      if (value.trim() !== '') return;
      /*
       * The plan is the authority on what the precedence chain supplied: a profile can supply a value
       * the form never shows, and a locked secret resolves from the secret store. Demanding a value the
       * form cannot accept was a dead end, not a check: `DB_PASSWORD` renders disabled with "resolves
       * to •••••••• · secret store" and still blocked the wizard with "DB_PASSWORD is required." A
       * variable capped below `profile_and_instance` cannot be typed at all, so a local demand on it
       * only names a field the operator has no way to fill. The API re-resolves before provisioning
       * and answers `fieldErrors` for anything genuinely missing, which `planErrors()` surfaces.
       */
      const planValue = resolvedEnv?.get(variable.name);
      const planSupplied =
        planValue !== undefined && (planValue.masked || (planValue.value ?? '') !== '');
      if (planSupplied || variable.overrideCeiling !== 'profile_and_instance') return;
      errors[`env.${variable.name}`] = `${variable.name} is required.`;
    });
  }
  if (step === 3) {
    if (values.resources.cpu <= 0) errors.resources = 'CPU must be greater than zero.';
    if (values.resources.memoryMb < 256) errors.resources = 'Memory must be at least 256 MB.';
    /**
     * The catalog's shape is the reviewed one, and for a JVM product it is also the shape that
     * decides the heap: a 1 GB container runs Metabase with a 256 MB heap and dies during startup,
     * while the declared 2 GB gives it 495 MB and it boots. The field was pre-filled with the
     * declared value and looked like a suggestion, so an operator could deploy a product the
     * platform already knows cannot start. The API refuses the same request.
     */
    if (declared !== undefined && values.resources.memoryMb < declared.memoryMb) {
      errors.resources = `Below the catalog minimum: this product is declared with ${declared.memoryMb} MB. Raise memory to at least ${declared.memoryMb} MB.`;
    }
  }
  return errors;
}

/**
 * Everything the deploy screen does except paint: the queries it reads, the values it derives, the
 * validation it runs and the request it issues. Written as a type alias rather than an inferred
 * object so the screen's contract is reviewable, and derived from the hook return types the screen
 * already depended on instead of importing TanStack's generics here.
 */
export type DeployWizard = {
  entry: ReturnType<typeof useCatalogEntry>;
  profiles: ReturnType<typeof useEnvProfiles>;
  capacity: ReturnType<typeof useCapacity>;
  deploy: ReturnType<typeof useDeploy>;
  plan: ReturnType<typeof useEnvPlan>;
  preview: ReturnType<typeof useDeployPreview>;
  /** Declared variables, empty until the schema arrives. */
  vars: EnvSchemaVar[];
  values: WizardValues;
  update: (patch: Partial<WizardValues>) => void;
  errors: Record<string, string>;
  step: number;
  setStep: Dispatch<SetStateAction<number>>;
  next: () => void;
  back: () => void;
  submit: () => void;
  verdict: AdmissionOutcome | null;
  checks: PreflightCheck[];
  blocked: boolean;
  failing: string[];
  /** Checks still waiting on a read; reported apart from `failing`, which has actually failed. */
  waiting: string[];
  unresolvedFields: string[];
  exception: PolicyException | null;
  /** The API's published host; `undefined` until the preview answers. */
  routeHost: string | undefined;
  jobId: string | null;
  setJobId: Dispatch<SetStateAction<string | null>>;
};

export function useDeployWizard(entryKey: string): DeployWizard {
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  /**
   * Only what the operator typed. Everything else is derived during render, so the first paint
   * already shows the product's slug, its reviewed resource shape and the host's profile —
   * instead of a frame of empty fields followed by an effect that filled them in.
   */
  const [draft, setDraft] = useState<Partial<WizardValues>>({});

  const entry = useCatalogEntry(entryKey);
  const envSchema = useEnvSchema(entryKey);
  const profiles = useEnvProfiles();
  // Step-gated: the first step issues only the requests it needs. The capacity snapshot and the
  // policy exceptions are read when a step actually shows them, not on mount.
  const capacity = useCapacity({ enabled: step >= 3 });
  const exceptions = usePolicyExceptions({ enabled: step >= 1 });

  const vars = useMemo(() => envSchema.data ?? [], [envSchema.data]);

  const env = useMemo(() => defaultsFor(vars, draft.env ?? {}), [vars, draft.env]);

  const values = useMemo<WizardValues>(
    () => ({
      slug: draft.slug ?? slugify(entry.data?.product ?? 'app'),
      profileKey: draft.profileKey ?? profiles.data?.[0]?.key ?? '',
      env,
      resources: draft.resources ?? entry.data?.resources ?? DEFAULT_RESOURCES,
    }),
    [draft.slug, draft.profileKey, draft.resources, entry.data, profiles.data, env],
  );

  const update = (patch: Partial<WizardValues>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const typedOverrides = useMemo(() => {
    const entries = vars
      .filter((variable) => variable.overrideCeiling === 'profile_and_instance')
      .map((variable) => [variable.name, values.env[variable.name] ?? ''] as const)
      // A value the operator never touched is a catalog default, not an override. Sending it as one
      // made the plan label every default "instance override" and made `requiresRecreate` fire for
      // variables that were not changed — while `submit()` below already filtered the same way, so
      // the summary and the request disagreed about what the plan contained.
      .filter(([name, value]) => {
        const variable = vars.find((item) => item.name === name);
        return value !== '' && value !== (variable?.defaultValue ?? '');
      });
    return Object.fromEntries(entries);
  }, [vars, values.env]);

  const debouncedOverrides = useDebouncedValue(typedOverrides, 350);
  const plan = useEnvPlan(
    entryKey,
    values.profileKey,
    debouncedOverrides,
    Boolean(entry.data) && values.profileKey !== '',
  );

  /**
   * What the precedence chain supplied, keyed by variable. The environment step needs it to tell an
   * empty input it is waiting on from an empty input the chain already answered.
   */
  const planValues = useMemo<ResolvedEnv>(
    () => new Map((plan.data?.values ?? []).map((item) => [item.name, item])),
    [plan.data],
  );

  /**
   * The preview is a read keyed on what it answers about. The two debounced inputs keep typing
   * from issuing one request per keystroke; `useDeployPreview` cancels a superseded request and
   * keys the cache on the slug and the size, so an answer for a discarded input cannot be shown
   * as the current verdict.
   */
  const previewSlug = useDebouncedValue(values.slug, 400);
  const previewResources = useDebouncedValue(values.resources, 400);
  const previewInput = useMemo<DeployInput>(
    () => ({
      entryKey,
      slug: previewSlug,
      ...(values.profileKey === '' ? {} : { profile: values.profileKey }),
      resources: previewResources,
    }),
    [entryKey, previewSlug, values.profileKey, previewResources],
  );
  const preview = useDeployPreview(previewInput, entry.data !== undefined);
  const deploy = useDeploy();

  /**
   * DATA-03: the list is read for exactly one reason — the `slugTaken` fallback below, which only
   * runs while the preview has no answer. `useInstances` documents that the platform-wide list is a
   * 403 for a domain owner's scoped grant, and the step the wizard opens on (identity) needs no list
   * at all, so the read is gated on the two conditions that actually consume it: the review step is
   * on screen *and* the preview is still silent.
   *
   * That second condition is what keeps the fallback honest rather than merely cheaper. When the
   * list has not answered either, `slugTaken` is false, but the pre-flight row is `pending` rather
   * than passing (`checks` below) and `submit()` refuses on `preview.data?.admissible !== true`. So
   * a slug that is in fact taken is never reported as free while both requests are in flight.
   */
  const instances = useInstances(
    {},
    { enabled: step === STEPS.length - 1 && preview.data === undefined },
  );

  const exception = useMemo(
    () =>
      (exceptions.data ?? []).find(
        (item) =>
          item.scope.includes(entryKey) &&
          (item.state === 'approved' || item.state === 'requested'),
      ) ?? null,
    [exceptions.data, entryKey],
  );

  /** Same function the API uses, so the preview cannot disagree with admission. */
  const verdict = useMemo<AdmissionOutcome | null>(() => {
    if (!capacity.data) return null;
    return admissionVerdict({
      host: {
        cpu: capacity.data.host.cpuCores,
        memoryMb: capacity.data.host.memoryMb,
        diskMb: capacity.data.host.diskMb,
      },
      reserve: {
        cpu: capacity.data.platformReserve.cpuCores,
        memoryMb: capacity.data.platformReserve.memoryMb,
        diskMb: capacity.data.platformReserve.diskMb,
      },
      allocated: {
        cpu: capacity.data.allocated.cpuCores,
        memoryMb: capacity.data.allocated.memoryMb,
        diskMb: capacity.data.allocated.diskMb,
      },
      request: values.resources,
      oversubscriptionFactor: capacity.data.oversubscriptionFactor,
    });
  }, [capacity.data, values.resources]);

  const routeHost = preview.data?.routeHost;
  const slugTaken =
    preview.data !== undefined
      ? !preview.data.slugAvailable
      : (instances.data ?? []).some((item) => item.slug === values.slug);

  const planErrors = () => {
    const found: Record<string, string> = {};
    for (const issue of plan.data?.fieldErrors ?? []) found[`env.${issue.field}`] = issue.message;
    return found;
  };

  const next = () => {
    const found = {
      ...validate(step, values, vars, entry.data?.resources, planValues),
      ...(step >= 2 ? planErrors() : {}),
    };
    setErrors(found);
    if (Object.keys(found).length === 0)
      setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const back = () => {
    setStep((current) => Math.max(current - 1, 0));
  };

  const submit = () => {
    // The debounced plan may be a few hundred milliseconds stale; the API re-resolves before provisioning
    // and returns field-level errors, so only the local checks gate submission here.
    const found = {
      ...validate(0, values, vars),
      ...validate(2, values, vars, undefined, planValues),
      ...validate(3, values, vars, entry.data?.resources),
    };
    if (slugTaken) found.slug = 'That route is already published; choose another slug.';
    // A profile is required by the API; sending an empty key would have asked it to resolve nothing.
    if (values.profileKey === '') found.profile = 'Choose an environment profile.';
    setErrors(found);
    // Both verdicts, for the same reason as the pre-flight check: the browser's arithmetic is
    // advisory, the API's admission decision is the one that refuses.
    if (Object.keys(found).length > 0 || !verdict?.admissible || preview.data?.admissible !== true)
      return;
    const envOverrides = Object.fromEntries(
      vars
        .filter((variable) => variable.overrideCeiling === 'profile_and_instance')
        .filter((variable) => {
          const value = values.env[variable.name] ?? '';
          return value !== '' && value !== (variable.defaultValue ?? '');
        })
        .map((variable) => [variable.name, values.env[variable.name] ?? '']),
    );
    deploy.mutate(
      {
        entryKey,
        slug: values.slug,
        profile: values.profileKey,
        resources: values.resources,
        envOverrides,
      },
      { onSuccess: (accepted) => setJobId(accepted.jobId) },
    );
  };

  /**
   * The variables the plan could not resolve, by name. The check used to count them ("8 field(s)
   * need attention"), which told the operator that something was wrong but not which field to fix,
   * and the wizard offers no way back to the environment step from the summary.
   */
  const unresolvedFields = (plan.data?.fieldErrors ?? []).map((issue) => issue.field);

  /*
   * The screen stops at its loading and error gates before rendering anything, so while the entry
   * is absent there is no verdict to report: an empty list is what the page shows anyway, and it
   * keeps this derivation out of the render gate. `entryData` is the narrowed entry every row below
   * reads, which the old top-level early return used to provide.
   */
  const entryData: CatalogEntry | undefined = entry.data;
  const checks: PreflightCheck[] =
    entryData === undefined
      ? []
      : [
          {
            label: 'Slug is free and valid',
            ok: !errors.slug && !slugTaken && preview.data?.slugAvailable === true,
            // A preview that has not answered yet is *pending*, not failed: rendering it as FAIL made the
            // deploy action look refused for a check the platform had never run. A preview that answered
            // with an error is a failure and now says so instead of waiting forever.
            pending: preview.data === undefined && !preview.isError,
            // The API knows *why* the name is unavailable — a live deployment or a 30-day reservation after
            // a deletion — and "already routed" was wrong for the second case. Use its sentence when it
            // has one; fall back only when the preview has not answered yet.
            detail: slugTaken
              ? (preview.data?.headline ??
                `${routeHost ?? values.slug} is already in use; choose another slug.`)
              : preview.isError
                ? `The route preview failed: ${problemText(preview.error)}`
                : preview.data === undefined
                  ? 'Asking the API for the published host and the slug availability…'
                  : `${routeHost ?? values.slug} will be published only after verification.`,
            action: preview.isError
              ? { label: 'Retry preview', onClick: () => void preview.refetch() }
              : { label: 'Edit the slug', onClick: () => setStep(0) },
          },
          {
            label: 'Environment profile is selected',
            /**
             * `submit()` already refuses an empty key, but the review step rendered no error for it: the
             * click returned before it issued a request, and the only place the failure existed was the
             * identity step's field. With a host that has no `env_profile` row at all the select is empty
             * and unselectable, so the button looked live and did nothing. A pre-flight row puts the
             * reason where the operator is standing.
             */
            ok: values.profileKey !== '',
            detail:
              values.profileKey !== ''
                ? `${values.profileKey} supplies the values between the catalog defaults and the instance overrides.`
                : (profiles.data?.length ?? 0) === 0
                  ? 'This host has no environment profile, so the environment cannot be resolved. At least one `env_profile` row must exist before anything can be deployed.'
                  : 'Choose one of the host profiles on the identity step.',
            action: { label: 'Go to the identity step', onClick: () => setStep(0) },
          },
          {
            label: 'Environment resolves without errors',
            // `?? 0` used to answer "no errors" for a plan that never resolved — an absent plan is not a
            // clean plan, and the check must not claim a validation the platform did not perform.
            ok:
              plan.data !== undefined &&
              plan.isError === false &&
              plan.data.fieldErrors.length === 0,
            pending: plan.data === undefined && !plan.isError,
            detail: plan.isError
              ? `The environment could not be resolved: ${problemText(plan.error)}`
              : plan.data === undefined
                ? 'Resolving the environment through the precedence chain…'
                : plan.data.fieldErrors.length === 0
                  ? `${plan.data.values.length} declared variables resolved (default → profile → instance → secret).`
                  : `${plan.data.fieldErrors.length} environment value(s) need attention: ${unresolvedFields.slice(0, 4).join(', ')}${unresolvedFields.length > 4 ? ` and ${unresolvedFields.length - 4} more` : ''}.`,
            action: { label: 'Go to the environment step', onClick: () => setStep(2) },
          },
          {
            label: exception ? 'Source path allowed by exception' : 'Source path allowed by policy',
            ok: exception ? exception.state === 'approved' : true,
            detail: exception
              ? `${exception.id} · ${exception.rule} · ${exception.state === 'approved' ? `approved by ${exception.approver}` : 'awaiting a second party'}.`
              : `${PACKAGING_LABELS[entryData.packaging]} path; no exception required.`,
          },
          {
            label: 'Admission fits the oversubscription rule',
            /**
             * The server's verdict, not only the browser's. `admissionVerdict` here and `capacity.admit` in
             * the API read different inputs, so a check built on the local function could say "pass" —
             * "10.0 vCPU and 4.6 GB memory headroom" — while `POST /instances` refused the same plan with
             * `CAPACITY_EXCEEDED`. The operator confirmed a plan the control plane had already rejected.
             */
            ok: (verdict?.admissible ?? false) && preview.data?.admissible === true,
            pending: verdict === null && capacity.isPending,
            detail: capacity.isError
              ? `The capacity snapshot could not be read: ${problemText(capacity.error)}`
              : preview.data !== undefined && !preview.data.admissible
                ? `${preview.data.headline}. ${preview.data.detail}`
                : (verdict?.headline ?? 'Waiting for the capacity snapshot.'),
            ...(capacity.isError
              ? { action: { label: 'Retry capacity', onClick: () => void capacity.refetch() } }
              : { action: { label: 'Adjust the resources', onClick: () => setStep(3) } }),
          },
          {
            label: 'Catalog metadata is current',
            ok: !entryData.integration.stale,
            detail: `Verified ${formatRelative(entryData.integration.verifiedAt)}; next review ${formatDate(entryData.integration.nextReviewAt)}.`,
          },
        ];
  const blocked = checks.some((check) => !check.ok);
  /**
   * A *pending* check has not run yet, so calling it unsatisfied claims a failure that does not exist
   * — the step-1 notice named the environment and admission rules as failing while neither read had
   * been issued. Failed and waiting are reported separately.
   */
  const failing = checks
    .filter((check) => !check.ok && check.pending !== true)
    .map((check) => check.label.toLowerCase());
  const waiting = checks
    .filter((check) => !check.ok && check.pending === true)
    .map((check) => check.label.toLowerCase());

  return {
    entry,
    profiles,
    capacity,
    deploy,
    plan,
    preview,
    vars,
    values,
    update,
    errors,
    step,
    setStep,
    next,
    back,
    submit,
    verdict,
    checks,
    blocked,
    failing,
    waiting,
    unresolvedFields,
    exception,
    routeHost,
    jobId,
    setJobId,
  };
}
