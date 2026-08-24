import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PushConfig } from 'src/config/configuration';

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
  /**
   * Messages the provider would not take — a batch that errored, or a ticket
   * that came back neither ok nor `DeviceNotRegistered`.
   *
   * Counted rather than thrown, because these notifications are a nudge and
   * the retry is what does the damage: a job that fails after delivering half
   * its batches is re-run whole, and every device already notified is notified
   * again. A number the caller can log costs one line and no duplicates.
   */
  failed: number;
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
    return Promise.resolve({
      sent: tokens.length,
      invalidTokens: [],
      failed: 0,
    });
  }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

type ExpoTicket = {
  status?: unknown;
  details?: { error?: unknown };
};

/**
 * Production delivery through Expo's push gateway.
 *
 * A failing batch is counted, never thrown. The batches are independent
 * requests and the ones before the failure have already been delivered — so
 * unwinding the whole call would throw that fact away and let the job retry
 * re-notify every device it had already reached. The count comes back with the
 * result and the caller logs it.
 */
@Injectable()
export class ExpoPushSender extends PushSender {
  private readonly logger = new Logger(ExpoPushSender.name);
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.timeoutMs = config.getOrThrow<PushConfig>('push').timeoutMs;
  }

  async send(
    tokens: PushToken[],
    message: PushMessage,
  ): Promise<PushSendResult> {
    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    for (let offset = 0; offset < tokens.length; offset += EXPO_BATCH_SIZE) {
      const batch = tokens.slice(offset, offset + EXPO_BATCH_SIZE);

      let tickets: ExpoTicket[];
      try {
        tickets = await this.deliver(batch, message);
      } catch (error) {
        failed += batch.length;
        this.logger.warn(
          `Expo push batch of ${batch.length} failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      tickets.forEach((raw: ExpoTicket, index: number) => {
        if (raw?.status === 'ok') {
          sent += 1;
        } else if (raw?.details?.error === 'DeviceNotRegistered') {
          invalidTokens.push(batch[index].token);
        } else {
          // A ticket that is neither delivered nor a dead device: a throttle,
          // a malformed message, an Expo-side fault. Not a token to retire.
          failed += 1;
        }
      });
    }

    return { sent, invalidTokens, failed };
  }

  /** One batch, or a throw the caller turns into a count. */
  private async deliver(
    batch: PushToken[],
    message: PushMessage,
  ): Promise<ExpoTicket[]> {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        batch.map((target) => ({
          to: target.token,
          title: message.title,
          body: message.body,
          data: message.data,
          sound: 'default',
        })),
      ),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Expo push gateway answered ${response.status}`);
    }
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data) || body.data.length !== batch.length) {
      throw new Error('Expo push gateway returned malformed tickets');
    }
    return body.data as ExpoTicket[];
  }
}
