import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { Agent } from 'undici';

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

/** Owns the official SDK and its bounded HTTP connection pool. */
@Injectable()
export class ExpoGateway implements OnModuleDestroy {
  private readonly agent: Agent;
  private readonly expo: Expo;

  constructor(config: ConfigService) {
    const timeoutMs = config.getOrThrow<PushConfig>('push').timeoutMs;
    this.agent = new Agent({
      connectTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    this.expo = new Expo({ httpAgent: this.agent });
  }

  chunk(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
    return this.expo.chunkPushNotifications(messages);
  }

  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    return this.expo.sendPushNotificationsAsync(messages);
  }

  async onModuleDestroy(): Promise<void> {
    await this.agent.close();
  }
}

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

  constructor(private readonly expo: ExpoGateway) {
    super();
  }

  async send(
    tokens: PushToken[],
    message: PushMessage,
  ): Promise<PushSendResult> {
    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    const messages: ExpoPushMessage[] = tokens.map((target) => ({
      to: target.token,
      title: message.title,
      body: message.body,
      data: message.data,
      sound: 'default',
    }));
    const byToken = new Map(tokens.map((target) => [target.token, target]));

    for (const chunk of this.expo.chunk(messages)) {
      // Each chunk is mapped back to its tokens through the recipient the SDK
      // is actually going to send to, not by slicing `tokens` at a running
      // offset. The offset version was only correct while `chunkPushNotifications`
      // packed messages in order and dropped none — an invariant it does not
      // promise and nothing here could detect. Drifting by one would attribute
      // every ticket to its neighbour, so a `DeviceNotRegistered` would retire
      // a live device and leave the dead one registered to fail again forever.
      const batch = chunk
        .map((entry) =>
          typeof entry.to === 'string' ? byToken.get(entry.to) : undefined,
        )
        .filter((target): target is PushToken => target !== undefined);

      if (batch.length !== chunk.length) {
        // A recipient this batch cannot be traced back to. No ticket in the
        // chunk can be safely attributed, so none of them retires a token.
        failed += chunk.length;
        this.logger.warn('Expo push chunk carried an unrecognised recipient');
        continue;
      }

      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.send(chunk);
      } catch (error) {
        failed += batch.length;
        this.logger.warn(
          `Expo push batch of ${batch.length} failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      if (tickets.length !== batch.length) {
        failed += batch.length;
        this.logger.warn('Expo push gateway returned malformed tickets');
        continue;
      }

      tickets.forEach((raw, index) => {
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
}
