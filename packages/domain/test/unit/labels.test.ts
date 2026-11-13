import { describe, expect, it } from 'vitest';
import {
  PLAIN_STATUS_LABELS,
  authLabelFor,
  forwardsIdentity,
  guaranteeShort,
  plainStatusFor,
  requiresEdgeSession,
  ssoIsProven,
} from '../../src/labels';

/**
 * The sign-in label is the one claim on a launcher tile a user acts on. These cases pin the two
 * ways it used to be wrong: a deployment that asks for a product password labelled as single
 * sign-on, and a proxy gate never labelled as a gate.
 */
describe('authLabelFor', () => {
  it('names the class when the deployment really signs the user in', () => {
    expect(authLabelFor('native', 'sso')).toBe('Native SSO');
    expect(authLabelFor('fa_header', 'sso')).toBe('Header SSO');
    expect(authLabelFor('fa_delegated', 'sso')).toBe('Delegated SSO');
  });

  it('falls back to a sign-in when the deployment does not provide one', () => {
    expect(authLabelFor('native', 'sign_in_required')).toBe(guaranteeShort('fa_gate'));
    expect(authLabelFor('fa_header', 'sign_in_required')).toBe(guaranteeShort('fa_gate'));
  });

  it('never calls a proxy gate single sign-on, whatever the deployment reports', () => {
    expect(authLabelFor('fa_gate', 'sso')).toBe(guaranteeShort('fa_gate'));
    expect(authLabelFor('fa_gate', 'sign_in_required')).toBe(guaranteeShort('fa_gate'));
  });

  it('follows the guarantee class when the deployment has not been verified', () => {
    expect(authLabelFor('native', null)).toBe('Native SSO');
    expect(authLabelFor('fa_gate', null)).toBe(guaranteeShort('fa_gate'));
  });
});

describe('ssoIsProven', () => {
  it('believes the deployment when it has been verified', () => {
    expect(ssoIsProven('sso', 'native')).toBe(true);
    expect(ssoIsProven('sign_in_required', 'native')).toBe(false);
    expect(ssoIsProven('sso_unverified', 'native')).toBe(false);
  });

  it('falls back to the class when the deployment has not been verified', () => {
    expect(ssoIsProven(null, 'native')).toBe(true);
    expect(ssoIsProven(null, 'fa_gate')).toBe(false);
  });
});

describe('authLabelFor, unverified deployment', () => {
  it('gives a registered-but-unproven path its own label, not a promise', () => {
    expect(authLabelFor('native', 'sso_unverified')).toBe('SSO unverified');
    expect(authLabelFor('fa_header', 'sso_unverified')).toBe('SSO unverified');
  });
});

describe('plainStatusFor', () => {
  it('reduces container truth to one plain-language status', () => {
    expect(plainStatusFor('ready', true)).toBe('available');
    expect(plainStatusFor('ready', false)).toBe('degraded');
    expect(plainStatusFor('degraded', true)).toBe('degraded');
    expect(plainStatusFor('stopped', false)).toBe('unavailable');
    expect(plainStatusFor('failed', false)).toBe('unavailable');
  });

  it('has a label, a tone and a description for every status', () => {
    for (const status of ['available', 'degraded', 'unavailable', 'maintenance'] as const) {
      expect(PLAIN_STATUS_LABELS[status].label.length).toBeGreaterThan(0);
      expect(PLAIN_STATUS_LABELS[status].description.length).toBeGreaterThan(0);
    }
  });
});

describe('forwardsIdentity', () => {
  it('is true only for the two forward-auth modes that carry the identity', () => {
    expect(forwardsIdentity('fa_header')).toBe(true);
    expect(forwardsIdentity('fa_delegated')).toBe(true);
  });

  it('is false for a gate, a native product and a missing route', () => {
    expect(forwardsIdentity('fa_gate')).toBe(false);
    expect(forwardsIdentity('native')).toBe(false);
    expect(forwardsIdentity(null)).toBe(false);
  });
});

/**
 * The gate is the case the two questions disagree on: it does not forward an identity, but it does
 * refuse a request without a session — which is why a launch ticket is still needed for it.
 */
describe('requiresEdgeSession', () => {
  it('is true for every gated class, including the proxy gate', () => {
    expect(requiresEdgeSession('fa_header')).toBe(true);
    expect(requiresEdgeSession('fa_delegated')).toBe(true);
    expect(requiresEdgeSession('fa_gate')).toBe(true);
  });

  it('is false for a native product and a missing route', () => {
    expect(requiresEdgeSession('native')).toBe(false);
    expect(requiresEdgeSession(null)).toBe(false);
  });
});
