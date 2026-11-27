import type { ComposeRule } from '@seamnex/domain';
import { evaluateCompose, parseCompose } from './compose-policy';
import type { ComposePatchEntry, ComposeViolation, SourcePolicyResult } from './policy-result';

/**
 * The shared policy entry points (NFR-4.15).
 *
 * Three source paths reach the same control — a Compose file, a Dockerfile, and the Dockerfile or
 * compose file an approved scaffold draft carries — and the resolver must evaluate whichever one it
 * actually found. These helpers keep the dispatch in one place so a fourth path cannot quietly skip
 * the check the way the Dockerfile path did.
 */
export function evaluateComposeText(
  content: string,
  waived: ReadonlySet<ComposeRule>,
  trustedRegistries: readonly string[] | null = null,
): SourcePolicyResult {
  return evaluateCompose(parseCompose(content), waived, trustedRegistries);
}

/**
 * The evidence an approver decides on, and the record kept with the exception.
 *
 * Two kinds of line, because they mean opposite things: `=` is a construct the platform could not
 * govern and is therefore **leaving exactly as the upstream file declares**, which is what the
 * approval grants; `~` is a substitution the platform makes in its own copy regardless of any
 * exception (`ports:` → `expose:`, design §11.5). An approver reading only "privileged" would be
 * granting the rule, not the deviation, and the deviation is the thing with consequences.
 *
 * The text is derived from rows the platform wrote itself — never from the request body — so it
 * cannot describe a patch that does not exist.
 */
export function describePolicyDecision(input: {
  readonly rule: ComposeRule;
  readonly violations: readonly ComposeViolation[];
  readonly patch: readonly ComposePatchEntry[];
}): string {
  const waived = input.violations
    .filter((violation) => violation.rule === input.rule)
    .map(
      (violation) =>
        `= ${violation.rule} kept as declared${violation.service === null ? '' : ` (${violation.service})`}: ${violation.detail}`,
    );
  const normalised = input.patch.map(
    (entry) => `~ ${entry.path}: ${render(entry.from)} → ${render(entry.to)}`,
  );
  const lines = [...waived, ...normalised];
  return lines.length === 0
    ? `= ${input.rule} waived; no deviation was observed in the last resolved source, so the exception applies to the next deployment that trips the rule.`
    : lines.join('\n');
}

function render(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
