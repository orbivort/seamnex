import { describe, expect, it } from 'vitest';
import {
  COMPOSE_RULES,
  COMPOSE_RULE_LABELS,
  ComposeRuleSchema,
  composeRuleLabel,
  isComposeRule,
} from '../../src/compose-rules';

/**
 * NFR-4.15 / DD-12 — one vocabulary for the evaluator, the waiver query and the console.
 *
 * The rule list used to exist three times: in the evaluator, in a copy inside the resolver and
 * nowhere in the console, which printed whatever the column held. A rule the form offers but the
 * policy never emits is a control that silently does nothing, so the list, its wire schema and its
 * labels are asserted together here.
 */
describe('compose rules', () => {
  it('names exactly the five constructs the policy refuses and nothing else', () => {
    expect([...COMPOSE_RULES]).toEqual([
      'network_mode_host',
      'privileged',
      'host_path_mount',
      'external_network',
      'unpinned_image',
    ]);
  });

  it('describes every rule for the person granting an exception', () => {
    for (const rule of COMPOSE_RULES) {
      expect(COMPOSE_RULE_LABELS[rule].label.length).toBeGreaterThan(0);
      expect(COMPOSE_RULE_LABELS[rule].description.length).toBeGreaterThan(0);
    }
    expect(Object.keys(COMPOSE_RULE_LABELS)).toHaveLength(COMPOSE_RULES.length);
  });

  it('accepts each rule on the wire and refuses anything else', () => {
    for (const rule of COMPOSE_RULES) {
      expect(ComposeRuleSchema.parse(rule)).toBe(rule);
      expect(isComposeRule(rule)).toBe(true);
    }
    expect(ComposeRuleSchema.safeParse('published_port').success).toBe(false);
    expect(isComposeRule('published_port')).toBe(false);
  });

  it('labels a known rule and passes an unknown one through unchanged', () => {
    expect(composeRuleLabel('host_path_mount')).toBe('Host-path bind mount');
    // A row written before this vocabulary existed stays readable rather than becoming blank.
    expect(composeRuleLabel('no-hosted-service')).toBe('no-hosted-service');
  });
});
