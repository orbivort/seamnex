import { describe, expect, it } from 'vitest';
import { describePolicyDecision } from '../../../../src/common/compose/source-policy';

/**
 * FR-1.20 / NFR-4.15 — the text an approver decides on.
 *
 * Two kinds of line, because they mean opposite things: `=` is a construct the platform could not
 * govern and is therefore leaving exactly as the upstream file declares, which is what the approval
 * grants; `~` is a substitution the platform makes in its own copy regardless of any exception. An
 * approver reading only the rule name would be granting a word, not a deviation.
 */
describe('describePolicyDecision', () => {
  it('quotes the waived construct and the substitution the platform still applies', () => {
    const text = describePolicyDecision({
      rule: 'privileged',
      violations: [
        { rule: 'privileged', service: 'app', detail: 'service app requests privileged mode.' },
        // A different rule in the same attempt is not part of this exception.
        { rule: 'external_network', service: null, detail: 'network legacy is declared external.' },
      ],
      patch: [{ path: 'services.app.ports', from: ['8080:80'], to: ['80'] }],
    });

    expect(text).toBe(
      [
        '= privileged kept as declared (app): service app requests privileged mode.',
        '~ services.app.ports: ["8080:80"] → ["80"]',
      ].join('\n'),
    );
  });

  it('names a violation that belongs to no service without a parenthetical', () => {
    const text = describePolicyDecision({
      rule: 'external_network',
      violations: [
        { rule: 'external_network', service: null, detail: 'network legacy is declared external.' },
      ],
      patch: [],
    });

    expect(text).toBe('= external_network kept as declared: network legacy is declared external.');
  });

  it('renders a scalar patch value as written and a missing one as none', () => {
    const text = describePolicyDecision({
      rule: 'unpinned_image',
      violations: [],
      patch: [
        { path: 'services.app.image', from: 'node:latest', to: null },
        { path: 'services.app.command', from: null, to: 'serve' },
      ],
    });

    expect(text).toBe(
      ['~ services.app.image: node:latest → none', '~ services.app.command: none → serve'].join(
        '\n',
      ),
    );
  });

  it('says plainly that nothing was observed, rather than inventing a diff', () => {
    const text = describePolicyDecision({ rule: 'privileged', violations: [], patch: [] });

    expect(text).toContain('no deviation was observed');
    expect(text).toContain('privileged');
  });
});
