import { describe, expect, it } from 'vitest';
import { digestPinVerdict } from '../../../../src/common/docker/digest-pin';

const PINNED = `sha256:${'a'.repeat(64)}`;
const MOVED = `sha256:${'b'.repeat(64)}`;

/**
 * `docker compose up` starts whatever the tag resolves to, so this function is the only place a pin is
 * compared with the image that would run. Each branch therefore has to be distinguishable by an
 * operator, and none of them may pass by accident: an absent digest is not a match in registry mode,
 * while in local mode an absent *build* is the one thing that must never pass.
 */
describe('digest pin verdict: registry mode', () => {
  it('passes when the daemon digest equals the pin', () => {
    expect(
      digestPinVerdict({
        mode: 'registry',
        reference: 'repo/crm:7.4',
        expected: PINNED,
        observed: PINNED,
      }),
    ).toEqual({ ok: true });
  });

  it('passes when the entry pins nothing, which is how a pull-free entry is handled', () => {
    for (const expected of [null, undefined, '', '   ']) {
      expect(
        digestPinVerdict({
          mode: 'registry',
          reference: 'seamnex/instance-1:abc',
          expected,
          observed: null,
        }),
      ).toEqual({ ok: true });
    }
  });

  it('refuses a pin that has moved, naming both digests', () => {
    const verdict = digestPinVerdict({
      mode: 'registry',
      reference: 'repo/crm:7.4',
      expected: PINNED,
      observed: MOVED,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toContain(PINNED);
    expect(verdict.detail).toContain(MOVED);
    expect(verdict.remediation).toContain('Nothing was started');
  });

  it('refuses when the host holds no repository digest, rather than reading the config id as one', () => {
    const verdict = digestPinVerdict({
      mode: 'registry',
      reference: 'repo/crm:7.4',
      expected: PINNED,
      observed: null,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toContain('no repository digest');
    expect(verdict.remediation).toContain('Publish the pinned build');
  });

  it('refuses a pin that is not a sha256 digest instead of comparing it', () => {
    const verdict = digestPinVerdict({
      mode: 'registry',
      reference: 'repo/crm:7.4',
      expected: 'sha256:abc',
      observed: 'sha256:abc',
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toContain('not a sha256 digest');
  });

  it('normalises case and padding, because a pin pasted from a registry UI carries both', () => {
    expect(
      digestPinVerdict({
        mode: 'registry',
        reference: 'repo/crm:7.4',
        expected: ` ${PINNED.toUpperCase()} `,
        observed: `${PINNED}\n`,
      }),
    ).toEqual({ ok: true });
  });
});

/**
 * Local mode answers a different question — "is the tag still the image this run built?" — so its
 * outcomes cannot be shared with the registry branch. The asymmetry is the point: a registry pin that
 * is absent means "nothing to check", a local build that is absent means "the deployment produced
 * nothing", and treating those the same would let a missing image pass as verified.
 */
describe('digest pin verdict: local mode', () => {
  it('passes when the tag resolves to the image the build produced', () => {
    expect(
      digestPinVerdict({
        mode: 'local',
        reference: 'seamnex/orangehrm:5.9',
        expected: PINNED,
        observed: PINNED,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses when the build produced nothing, instead of treating it as unpinned', () => {
    for (const expected of [null, undefined, '', '  ']) {
      const verdict = digestPinVerdict({
        mode: 'local',
        reference: 'seamnex/orangehrm:5.9',
        expected,
        observed: PINNED,
      });

      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.detail).toContain('produced no image');
      expect(verdict.remediation).toContain('build log');
    }
  });

  it('refuses when the tag is absent, because the definition forbids pulling it', () => {
    const verdict = digestPinVerdict({
      mode: 'local',
      reference: 'seamnex/orangehrm:5.9',
      expected: PINNED,
      observed: null,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toContain('not present on this host');
    expect(verdict.detail).toContain('forbids pulling');
  });

  it('refuses a tag that was retagged or replaced after the build', () => {
    const verdict = digestPinVerdict({
      mode: 'local',
      reference: 'seamnex/orangehrm:5.9',
      expected: PINNED,
      observed: MOVED,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toContain('retagged or replaced');
    expect(verdict.remediation).toContain('Nothing was started');
  });
});
