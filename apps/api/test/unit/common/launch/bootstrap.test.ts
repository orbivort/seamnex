import { describe, expect, it } from 'vitest';
import {
  LAUNCH_BOOTSTRAP_PATH,
  launchBootstrapUrl,
  launchTicketKey,
} from '../../../../src/common/launch/bootstrap';

describe('launch bootstrap', () => {
  it('names one path that both ends read', () => {
    expect(LAUNCH_BOOTSTRAP_PATH).toBe('/__seamnex/session');
  });

  it('derives the Redis key of a single-use ticket', () => {
    expect(launchTicketKey('abc')).toBe('seamnex:launch:abc');
    expect(launchTicketKey('')).toBe('seamnex:launch:');
  });

  it('opens the bootstrap at the product origin, not at a subpath', () => {
    expect(launchBootstrapUrl('https://shop.test/products/42', 'ticket-1')).toBe(
      'https://shop.test/__seamnex/session?ticket=ticket-1',
    );
  });

  it('percent-encodes a ticket that contains reserved characters', () => {
    expect(launchBootstrapUrl('https://shop.test', 'a+b/c=')).toBe(
      'https://shop.test/__seamnex/session?ticket=a%2Bb%2Fc%3D',
    );
  });

  it('keeps the port of a development product', () => {
    expect(launchBootstrapUrl('http://shop.localhost:8080/x', 't')).toBe(
      'http://shop.localhost:8080/__seamnex/session?ticket=t',
    );
  });

  it('refuses a product URL that is not a URL', () => {
    expect(() => launchBootstrapUrl('not-a-url', 't')).toThrow();
  });
});
