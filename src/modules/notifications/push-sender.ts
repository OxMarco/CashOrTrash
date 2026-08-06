import { Injectable, Logger } from '@nestjs/common';

import { PushToken } from './entities/push-token.entity';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSendResult {
  sent: number;
  /** Tokens the provider rejected as permanently invalid; we deactivate these. */
  invalidTokens: string[];
}

export abstract class PushSender {
  abstract send(
    tokens: PushToken[],
    message: PushMessage,
  ): Promise<PushSendResult>;
}

/**
 * The default adapter logs instead of sending. Wiring a real provider (APNs,
 * FCM, Expo) means implementing this one method and swapping the binding in
 * NotificationsModule — nothing above this line knows which provider it is.
 */
@Injectable()
export class LoggingPushSender extends PushSender {
  private readonly logger = new Logger(LoggingPushSender.name);

  send(tokens: PushToken[], message: PushMessage): Promise<PushSendResult> {
    this.logger.log(
      `[push:noop] "${message.title}" → ${tokens.length} device(s)`,
    );
    // Not `async`: there is nothing to await until a real provider is wired
    // in, and the signature stays a promise so swapping one in changes only
    // this file.
    return Promise.resolve({ sent: tokens.length, invalidTokens: [] });
  }
}
