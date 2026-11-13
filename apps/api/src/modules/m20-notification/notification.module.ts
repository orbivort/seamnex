import { Module } from '@nestjs/common';
import { NOTIFICATION_SERVICE } from './notification.contract';
import { PostgresNotificationService } from './notification.service';

/**
 * M20 — alert channels and delivery (4B.3).
 *
 * Not global: the modules that raise an alert (the scheduler's health evaluation, and later the
 * governance workstream's expiry notices) declare the edge to the *interface*, which is what
 * "tell someone" should cost. A global turned every alert sender into an invisible dependency on a
 * delivery implementation.
 */
@Module({
  providers: [{ provide: NOTIFICATION_SERVICE, useClass: PostgresNotificationService }],
  exports: [NOTIFICATION_SERVICE],
})
export class NotificationModule {}
