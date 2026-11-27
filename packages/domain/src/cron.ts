/**
 * FR-5.4 — the cron expression a scheduled workflow is compiled from.
 *
 * There was no check anywhere: the panel refused only an *empty* expression, `validate()` had no rule
 * at all, and `cron 61 * * * *` therefore saved, validated clean and failed at activation with n8n's
 * bare `400` — reported as "a platform adapter is not configured", which sent the operator to inspect
 * an API key that was working. A schedule that can never fire must be refused where it is typed.
 *
 * The grammar is the five-field one the compiler emits (`minute hour day-of-month month day-of-week`),
 * with `*`, numbers, ranges, steps and lists, plus the month and weekday names n8n also accepts. The
 * examples are written without the step form on purpose: its two characters end a block comment.
 */

type FieldSpec = {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** Named values the field accepts in place of a number (`JAN`, `MON`). */
  readonly names?: Readonly<Record<string, number>>;
};

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/**
 * Weekday accepts `7` as a second name for Sunday, which is what cron has always allowed; the named
 * form is capped at `SAT` because `SUN` already means zero.
 */
const FIELDS: readonly FieldSpec[] = [
  // Capitalised because the name opens the sentence the panel shows under the field.
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Hour', min: 0, max: 23 },
  { name: 'Day of month', min: 1, max: 31 },
  { name: 'Month', min: 1, max: 12, names: MONTHS },
  { name: 'Day of week', min: 0, max: 7, names: WEEKDAYS },
];

/**
 * The reason an expression cannot be compiled, or `null` when it can.
 *
 * The message is written for the person who typed the field: it names the field and the token, and
 * says what the field accepts, because "invalid cron" leaves them reading documentation to discover
 * which of five numbers is wrong.
 */
export function cronExpressionProblem(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELDS.length) {
    return `A cron expression has five fields (minute hour day month weekday), and this has ${fields.length}.`;
  }
  for (const [index, spec] of FIELDS.entries()) {
    // The count check above makes the two lists the same length, so the field is always there: a
    // `?? ''` guard would be a branch no input reaches.
    const problem = fieldProblem(fields[index] as string, spec);
    if (problem !== null) return problem;
  }
  return null;
}

function fieldProblem(field: string, spec: FieldSpec): string | null {
  for (const item of field.split(',')) {
    const problem = itemProblem(item.trim(), spec);
    if (problem !== null) return problem;
  }
  return null;
}

function itemProblem(item: string, spec: FieldSpec): string | null {
  if (item.length === 0) return `${spec.name} has an empty list item.`;
  if (item === '*') return null;

  // `indexOf` rather than `split`: read this way the base is always a string, so neither the step
  // nor the range check needs a fallback for a part that is not there.
  const slash = item.indexOf('/');
  const base = slash === -1 ? item : item.slice(0, slash);
  const step = slash === -1 ? null : item.slice(slash + 1);
  if (step !== null) {
    if (step.includes('/')) return `${spec.name} "${item}" has more than one "/".`;
    if (!isWholeNumber(step) || Number(step) < 1) {
      return `${spec.name} "${item}" needs a whole step of at least 1.`;
    }
  }

  // A bare `*` returned above, so a `*` base here is the stepped form the engine also reads.
  if (base === '*') return null;

  const dash = base.indexOf('-');
  const startToken = dash === -1 ? base : base.slice(0, dash);
  const endToken = dash === -1 ? null : base.slice(dash + 1);
  if (endToken !== null && endToken.includes('-')) {
    return `${spec.name} "${item}" has more than one "-".`;
  }

  const start = value(startToken, spec);
  if (start === null) return `${spec.name} "${startToken}" is not ${describe(spec)}.`;
  if (endToken === null) return null;

  const end = value(endToken, spec);
  if (end === null) return `${spec.name} "${endToken}" is not ${describe(spec)}.`;
  if (end < start) return `${spec.name} "${item}" is a range that runs backwards.`;
  return null;
}

function value(token: string, spec: FieldSpec): number | null {
  const named = spec.names?.[token.toUpperCase()];
  if (named !== undefined) return named;
  if (!isWholeNumber(token)) return null;
  const parsed = Number(token);
  return parsed >= spec.min && parsed <= spec.max ? parsed : null;
}

function isWholeNumber(token: string): boolean {
  return /^\d+$/.test(token);
}

function describe(spec: FieldSpec): string {
  const base = `a number from ${spec.min} to ${spec.max}`;
  if (spec.names === undefined) return base;
  return `${base}, or one of ${Object.keys(spec.names).join(', ')}`;
}
