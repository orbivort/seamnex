import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import type { SessionRecord } from './session.contract';

/**
 * Raw Redis access for sessions. No policy lives here: expiry, rotation and audit are the
 * service's job. Keeping the key layout in one file means `killSubject` cannot miss a key shape.
 *
 * Layout:
 *   seamnex:sess:<sid>        JSON record, TTL = idle lifetime
 *   seamnex:sess:sub:<sub>    SET of session ids, TTL = absolute lifetime
 */
@Injectable()
export class SessionStore {
  private readonly logger = new Logger('session.store');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private recordKey(sid: string): string {
    return `seamnex:sess:${sid}`;
  }

  private subjectKey(sub: string): string {
    return `seamnex:sess:sub:${sub}`;
  }

  async save(record: SessionRecord, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const subjectTtl = Math.max(ttl, Math.ceil((record.absoluteExpiresAt - Date.now()) / 1_000));
    await this.redis
      .multi()
      .set(this.recordKey(record.sid), JSON.stringify(record), 'EX', ttl)
      .sadd(this.subjectKey(record.sub), record.sid)
      .expire(this.subjectKey(record.sub), subjectTtl)
      .exec();
  }

  async get(sid: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.recordKey(sid));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      // A corrupted value is not a session; drop it rather than fail every request that carries it.
      this.logger.warn('discarded an unreadable session record');
      await this.delete(sid);
      return null;
    }
  }

  async touch(record: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      this.recordKey(record.sid),
      JSON.stringify(record),
      'EX',
      Math.max(1, Math.floor(ttlSeconds)),
    );
  }

  async delete(sid: string, sub?: string): Promise<void> {
    const pipeline = this.redis.multi().del(this.recordKey(sid));
    if (sub !== undefined) pipeline.srem(this.subjectKey(sub), sid);
    await pipeline.exec();
  }

  async subjectSessionIds(sub: string): Promise<string[]> {
    return this.redis.smembers(this.subjectKey(sub));
  }

  async clearSubject(sub: string): Promise<void> {
    await this.redis.del(this.subjectKey(sub));
  }
}
