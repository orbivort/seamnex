import { z } from 'zod';

/**
 * NFR-4.15 / DD-12 — the single compose policy vocabulary.
 *
 * The rule list lived in `apps/api/src/common/compose/compose-policy.ts` and was copied a second
 * time in the resolver's `isComposeRule()`, while the console had no list at all and printed whatever
 * string a row held. A request form that offers a rule the policy does not implement, or a waiver
 * query that matches a rule name the evaluator never emits, is a control that silently does nothing —
 * so the list, its wire schema and its human labels live here, in the contract package, and the
 * evaluator, the waiver query and the selector all read them.
 */
export const COMPOSE_RULES = [
  'network_mode_host',
  'privileged',
  'host_path_mount',
  'external_network',
  'unpinned_image',
  /*
   * NFR-4.16: an image outside the trusted-registry allow-list. It is a rule here so the evaluator,
   * the console and the resolution evidence share one vocabulary — but it is **not waivable**:
   * NFR-4.16's only remedy is adding the namespace to the allow-list, and a time-boxed exception
   * that let a deployment proceed anyway would be the exact control the requirement names.
   */
  'untrusted_registry',
] as const;

export type ComposeRule = (typeof COMPOSE_RULES)[number];

export const ComposeRuleSchema = z.enum(COMPOSE_RULES);

/**
 * NFR-4.16 — the subset no `policy_exception` may waive.
 *
 * Kept out of the exception request schema and out of the waiver query, so a rule the platform
 * cannot honestly waive is not offered to an approver in the first place.
 */
export const NON_WAIVABLE_RULES = ['untrusted_registry'] as const;

export type NonWaivableRule = (typeof NON_WAIVABLE_RULES)[number];

export type WaivableComposeRule = Exclude<ComposeRule, NonWaivableRule>;

export function isNonWaivableRule(value: string): value is NonWaivableRule {
  return (NON_WAIVABLE_RULES as readonly string[]).includes(value);
}

export const WAIVABLE_RULES: readonly WaivableComposeRule[] = COMPOSE_RULES.filter(
  (rule): rule is WaivableComposeRule => !isNonWaivableRule(rule),
);

export const WaivableComposeRuleSchema = z.enum(
  WAIVABLE_RULES as unknown as [WaivableComposeRule, ...WaivableComposeRule[]],
);

/**
 * What each rule means to the person granting an exception. The label is the rule's own wording:
 * an approver reading "unpinned image" is granting "a tag that can move under us", which is not the
 * same decision as granting a host bind mount.
 */
export const COMPOSE_RULE_LABELS: Readonly<
  Record<ComposeRule, { readonly label: string; readonly description: string }>
> = {
  network_mode_host: {
    label: 'Host networking',
    description:
      'The service runs on the host network, which bypasses the platform network and every route control.',
  },
  privileged: {
    label: 'Privileged mode',
    description:
      'The container has host-level capabilities and can reach devices and kernel surfaces.',
  },
  host_path_mount: {
    label: 'Host-path bind mount',
    description:
      'A directory of the host is mounted into the container, outside the platform volume.',
  },
  external_network: {
    label: 'External network',
    description: 'The service joins a network the platform does not create or govern.',
  },
  unpinned_image: {
    label: 'Unpinned image',
    description:
      'The image reference has no digest or version tag, so what runs can change silently.',
  },
  untrusted_registry: {
    label: 'Untrusted registry',
    description:
      'The image comes from a registry or namespace outside the trusted-registry allow-list (NFR-4.16).',
  },
};

export function isComposeRule(value: string): value is ComposeRule {
  return (COMPOSE_RULES as readonly string[]).includes(value);
}

/**
 * A rule as a screen should name it.
 *
 * `policy_exception.rule` stores the machine name the evaluator emits (`host_path_mount`). A screen
 * that prints the column raw shows an identifier where a decision is made; one that stores the label
 * instead breaks the comparison the waiver depends on. This maps for display and falls back to the
 * stored value, so a row written before the vocabulary existed is still readable.
 */
export function composeRuleLabel(value: string): string {
  return isComposeRule(value) ? COMPOSE_RULE_LABELS[value].label : value;
}
