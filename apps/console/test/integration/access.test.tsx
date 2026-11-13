import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('capability gates', () => {
  it('lets the auditor read the user directory but not disable anyone', async () => {
    openAs('R2', '/admin/users/usr-lena-hoff');
    render(<App />);

    expect(await screen.findByRole('heading', { name: /Lena Hoff/ })).toBeDefined();
    expect(await screen.findByText('Product entitlements')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Disable user/i })).toBeNull();
  });

  it('denies the user directory to a domain owner', async () => {
    openAs('R3', '/admin/users');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Users' })).toBeNull();
  });

  it('denies the user directory to a product administrator', async () => {
    openAs('R4', '/admin/users');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });

  it('denies deployment to a product administrator', async () => {
    openAs('R4', '/deploy/D01-01');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
    expect(screen.queryByRole('heading', { name: /Deploy/ })).toBeNull();
  });

  it('denies the audit trail to an end user', async () => {
    openAs('R5', '/governance/audit');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });

  it('shows the platform administrator the disable affordance', async () => {
    openAs('R1', '/admin/users/usr-lena-hoff');
    render(<App />);

    expect(await screen.findByRole('button', { name: /Disable user/i })).toBeDefined();
  });

  it('keeps the auditor out of the deploy wizard', async () => {
    openAs('R2', '/deploy/D01-01');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });
});
