import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  capabilitySets,
  type Capability,
  type CapabilitySets,
  type PlatformRole,
} from '@seamnex/domain';
import {
  createCapabilityGates,
  type CapabilityGates,
  type SessionRoleSource,
} from '../../src/capabilities';

/**
 * ADR-FE-01: one gate implementation per app, built from the app's own `useSession`. These cases
 * pin the two things the factory must not get wrong — which matrix set each gate reads (`held`
 * includes a `scoped` grant, `mutable` does not) and what the refusal hands to the presentation
 * layer — plus the memoisation the derived sets rely on.
 */
type RoleState = { role: PlatformRole };

function build(role: PlatformRole): {
  state: RoleState;
  useSession: Mock<SessionRoleSource>;
  gates: CapabilityGates;
} {
  const state: RoleState = { role };
  // A fresh envelope per call, like a real `useSession`: only `session.role` may drive the memo.
  const useSession = vi.fn<SessionRoleSource>(() => ({ session: state }));
  return { state, useSession, gates: createCapabilityGates(useSession) };
}

function SetsProbe({ gates, seen }: { gates: CapabilityGates; seen: CapabilitySets[] }) {
  seen.push(gates.useCapabilities());
  return null;
}

function latest(seen: CapabilitySets[]): CapabilitySets {
  const value = seen.at(-1);
  if (!value) throw new Error('the probe did not render');
  return value;
}

function deniedFallback(label: string) {
  return vi.fn((denied: Capability | undefined) => <p>{`${label}:${denied ?? 'none'}`}</p>);
}

describe('createCapabilityGates', () => {
  describe('useCapabilities', () => {
    it('derives both sets from the matrix for the current role', () => {
      const { gates, useSession } = build('R3');
      const seen: CapabilitySets[] = [];

      render(<SetsProbe gates={gates} seen={seen} />);

      const sets = latest(seen);
      expect(useSession).toHaveBeenCalled();
      expect(sets).toEqual(capabilitySets('R3'));
      // A `scoped` grant opens the screen but never enables the control.
      expect(sets.held.has('instance.configure')).toBe(true);
      expect(sets.mutable.has('instance.configure')).toBe(false);
      expect(sets.held.has('profile.request')).toBe(true);
      expect(sets.mutable.has('profile.request')).toBe(true);
      // A `none` grant is absent from both.
      expect(sets.held.has('instance.deploy')).toBe(false);
      expect(sets.mutable.has('instance.deploy')).toBe(false);
    });

    it('memoises on the role, not on the session envelope', () => {
      const { gates, state } = build('R1');
      const seen: CapabilitySets[] = [];
      const { rerender } = render(<SetsProbe gates={gates} seen={seen} />);

      rerender(<SetsProbe gates={gates} seen={seen} />);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0]);

      state.role = 'R5';
      rerender(<SetsProbe gates={gates} seen={seen} />);
      expect(seen[2]).not.toBe(seen[0]);
      expect(latest(seen)).toEqual(capabilitySets('R5'));
    });
  });

  describe('RequireCapability', () => {
    it('opens the screen on a scoped grant and never consults the fallback', () => {
      const { gates } = build('R3');
      const fallback = deniedFallback('denied');

      render(
        <gates.RequireCapability capability="instance.configure" fallback={fallback}>
          <p>instance settings</p>
        </gates.RequireCapability>,
      );

      expect(screen.getByText('instance settings')).toBeDefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it('replaces the children with the fallback and names the refused capability', () => {
      const { gates } = build('R5');
      const fallback = deniedFallback('denied');

      const { container } = render(
        <gates.RequireCapability capability="settings.manage" fallback={fallback}>
          <p>never rendered</p>
        </gates.RequireCapability>,
      );

      expect(container.textContent).toBe('denied:settings.manage');
      expect(screen.queryByText('never rendered')).toBeNull();
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith('settings.manage');
    });
  });

  describe('RequireFullCapability', () => {
    it('renders the children on an outright grant', () => {
      const { gates } = build('R1');
      const fallback = deniedFallback('denied');

      render(
        <gates.RequireFullCapability capability="instance.deploy" fallback={fallback}>
          <p>deploy</p>
        </gates.RequireFullCapability>,
      );

      expect(screen.getByText('deploy')).toBeDefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it('refuses the scoped grant that `RequireCapability` would admit', () => {
      const { gates } = build('R3');
      const fallback = deniedFallback('denied');

      const { container } = render(
        <gates.RequireFullCapability capability="instance.configure" fallback={fallback}>
          <p>never rendered</p>
        </gates.RequireFullCapability>,
      );

      expect(container.textContent).toBe('denied:instance.configure');
      expect(screen.queryByText('never rendered')).toBeNull();
      expect(fallback).toHaveBeenCalledWith('instance.configure');
    });
  });

  describe('RequireAnyCapability', () => {
    it('opens when any named capability is held, even only within a scope', () => {
      const { gates } = build('R3');
      const fallback = deniedFallback('denied');

      render(
        <gates.RequireAnyCapability
          capabilities={['instance.deploy', 'identity.manage_users']}
          fallback={fallback}
        >
          <p>directory</p>
        </gates.RequireAnyCapability>,
      );

      expect(screen.getByText('directory')).toBeDefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it('names the first capability the role does not hold when it holds none', () => {
      const { gates } = build('R5');
      const fallback = deniedFallback('denied');

      const { container } = render(
        <gates.RequireAnyCapability
          capabilities={['instance.configure', 'instance.env', 'audit.view']}
          fallback={fallback}
        >
          <p>never rendered</p>
        </gates.RequireAnyCapability>,
      );

      expect(container.textContent).toBe('denied:instance.configure');
      expect(fallback).toHaveBeenCalledWith('instance.configure');
    });

    it('reports `undefined` when the entry declares no capability at all', () => {
      const { gates } = build('R1');
      const fallback = deniedFallback('denied');

      const { container } = render(
        <gates.RequireAnyCapability capabilities={[]} fallback={fallback}>
          <p>never rendered</p>
        </gates.RequireAnyCapability>,
      );

      expect(container.textContent).toBe('denied:none');
      expect(fallback).toHaveBeenCalledWith(undefined);
    });
  });

  describe('RequireAnyFullCapability', () => {
    it('opens on any outright grant among the named capabilities', () => {
      const { gates } = build('R3');
      const fallback = deniedFallback('denied');

      render(
        <gates.RequireAnyFullCapability
          capabilities={['instance.configure', 'profile.request']}
          fallback={fallback}
        >
          <p>environment profiles</p>
        </gates.RequireAnyFullCapability>,
      );

      expect(screen.getByText('environment profiles')).toBeDefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it('refuses a list of scoped grants and names the first unscoped one', () => {
      const { gates } = build('R3');
      const fallback = deniedFallback('denied');

      const { container } = render(
        <gates.RequireAnyFullCapability
          capabilities={['instance.configure', 'instance.env']}
          fallback={fallback}
        >
          <p>never rendered</p>
        </gates.RequireAnyFullCapability>,
      );

      expect(container.textContent).toBe('denied:instance.configure');
      expect(screen.queryByText('never rendered')).toBeNull();
      expect(fallback).toHaveBeenCalledWith('instance.configure');
    });

    it('reports `undefined` for an empty capability list', () => {
      const { gates } = build('R1');
      const fallback = deniedFallback('denied');

      render(
        <gates.RequireAnyFullCapability capabilities={[]} fallback={fallback}>
          <p>never rendered</p>
        </gates.RequireAnyFullCapability>,
      );

      expect(fallback).toHaveBeenCalledWith(undefined);
    });
  });

  it('keeps two apps’ gates independent of each other', () => {
    const consoleGates = build('R1');
    const portalGates = build('R6');

    render(
      <>
        <consoleGates.gates.RequireFullCapability
          capability="instance.deploy"
          fallback={deniedFallback('console')}
        >
          <p>console deploy</p>
        </consoleGates.gates.RequireFullCapability>
        <portalGates.gates.RequireCapability
          capability="instance.deploy"
          fallback={deniedFallback('portal')}
        >
          <p>portal deploy</p>
        </portalGates.gates.RequireCapability>
      </>,
    );

    expect(screen.getByText('console deploy')).toBeDefined();
    expect(screen.getByText('portal:instance.deploy')).toBeDefined();
    expect(screen.queryByText('portal deploy')).toBeNull();
  });
});
