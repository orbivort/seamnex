import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisSessionService } from '../../../../src/modules/m10-portal-bff/session.service';

/**
 * The revocation edge cases that `session.service.test.ts` leaves open.
 *
 * `killSubject` deliberately swallows an audit failure — a disabled account must not stay signed in
 * because the audit chain is unavailable — but it still has to log *something* an operator can act
 * on. The failing audit arrives as an `Error`, and the log line carries its `message` rather than
 * the stringified object; that arm is the one branch the main suite never reaches.
 */
afterEach(() => {
  vi.useRealTimers();
});

describe('killSubject audit failure', () => {
  it('logs the message of an Error when the revocation cannot be audited', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const store = {
      subjectSessionIds: vi.fn(async () => ['sid-1', 'sid-2']),
      delete: vi.fn(async () => undefined),
      clearSubject: vi.fn(async () => undefined),
    };
    const audit = { append: vi.fn().mockRejectedValue(new Error('audit chain locked')) };
    const service = new RedisSessionService(
      {} as never,
      store as never,
      { settings: vi.fn() } as never,
      audit as never,
    );

    // The sign-out completes regardless: the audit log is evidence, not the credential.
    await expect(service.killSubject('uuid-1', 'disabled')).resolves.toBe(2);

    expect(store.delete).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'uuid-1', err: 'audit chain locked' }),
    );
  });
});
