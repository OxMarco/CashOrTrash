import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Expo,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket,
} from 'expo-server-sdk';
import { Agent } from 'undici';

import { PushConfig } from 'src/config/configuration';

import { PushToken } from './entities/push-token.entity';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** One notification for one device. A sweep hands over all of them at once. */
export interface PushDelivery {
  token: PushToken;
  message: PushMessage;
}

/**
 * A notification the gateway accepted, and the device it was for.
 *
 * Accepted is not delivered. Expo answers the send with a ticket and only
 * learns later — from Apple or Google — whether the device still exists; that
 * answer is the receipt, fetched with this id. Kept alongside the token
 * because a receipt names only the ticket.
 */
export interface PushTicket {
  id: string;
  token: string;
}

export interface PushReceiptResult {
  /** Ticket ids that have a receipt, of any kind — nothing more to learn. */
  settled: string[];
  /** The subset whose receipt says the device is gone for good. */
  deviceNotRegistered: string[];
  /** Receipts that reported some other failure, for the log. */
  failed: number;
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
  /** One per accepted notification, for the receipt check to follow up. */
  tickets: PushTicket[];
}

export abstract class PushSender {
  /**
   * Every delivery in one call, which the adapter batches as its provider
   * requires. The caller builds the whole sweep first rather than calling once
   * per player: a hundred players is one request to Expo, not a hundred.
   */
  abstract send(deliveries: PushDelivery[]): Promise<PushSendResult>;

  /** What became of earlier tickets. Ids with no receipt yet are simply absent. */
  abstract receipts(ticketIds: string[]): Promise<PushReceiptResult>;
}

/**
 * The default adapter logs instead of sending. Wiring a real provider (APNs,
 * FCM, Expo) means implementing this one method and swapping the binding in
 * NotificationsModule — nothing above this line knows which provider it is.
 */
@Injectable()
export class LoggingPushSender extends PushSender {
  private readonly logger = new Logger(LoggingPushSender.name);

  send(deliveries: PushDelivery[]): Promise<PushSendResult> {
    this.logger.log(`[push:noop] ${deliveries.length} notification(s)`);
    // Not `async`: there is nothing to await until a real provider is wired
    // in, and the signature stays a promise so swapping one in changes only
    // this file. No tickets: there is nothing to ask about later.
    return Promise.resolve({
      sent: deliveries.length,
      invalidTokens: [],
      failed: 0,
      tickets: [],
    });
  }

  receipts(): Promise<PushReceiptResult> {
    return Promise.resolve({ settled: [], deviceNotRegistered: [], failed: 0 });
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

  chunkReceiptIds(ids: string[]): string[][] {
    return this.expo.chunkPushNotificationReceiptIds(ids);
  }

  /** POSTs to Expo's `/--/api/v2/push/getReceipts`. */
  receipts(ids: string[]): Promise<Record<string, ExpoPushReceipt>> {
    return this.expo.getPushNotificationReceiptsAsync(ids);
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

  async send(deliveries: PushDelivery[]): Promise<PushSendResult> {
    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];
    const tickets: PushTicket[] = [];

    const messages: ExpoPushMessage[] = deliveries.map(
      ({ token, message }) => ({
        to: token.token,
        title: message.title,
        body: message.body,
        data: message.data,
        sound: 'default',
      }),
    );
    const byToken = new Map(
      deliveries.map(({ token }) => [token.token, token]),
    );

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

      let received: ExpoPushTicket[];
      try {
        received = await this.expo.send(chunk);
      } catch (error) {
        failed += batch.length;
        this.logger.warn(
          `Expo push batch of ${batch.length} failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      if (received.length !== batch.length) {
        failed += batch.length;
        this.logger.warn('Expo push gateway returned malformed tickets');
        continue;
      }

      received.forEach((raw, index) => {
        if (raw?.status === 'ok') {
          sent += 1;
          tickets.push({ id: raw.id, token: batch[index].token });
        } else if (raw?.details?.error === 'DeviceNotRegistered') {
          invalidTokens.push(batch[index].token);
        } else {
          // A ticket that is neither delivered nor a dead device: a throttle,
          // a malformed message, an Expo-side fault. Not a token to retire.
          failed += 1;
        }
      });
    }

    return { sent, invalidTokens, failed, tickets };
  }

  /**
   * Receipts for earlier tickets, a chunk (Expo's limit is 1000 ids) at a
   * time.
   *
   * A chunk that fails is logged and left out of `settled`, so its ids stay
   * stashed and are asked about again on the next check. Nothing is lost by
   * waiting: the only action a receipt can prompt is retiring a dead token,
   * and that is no more urgent in an hour than now.
   */
  async receipts(ticketIds: string[]): Promise<PushReceiptResult> {
    const settled: string[] = [];
    const deviceNotRegistered: string[] = [];
    let failed = 0;

    for (const chunk of this.expo.chunkReceiptIds(ticketIds)) {
      let receipts: Record<string, ExpoPushReceipt>;
      try {
        receipts = await this.expo.receipts(chunk);
      } catch (error) {
        this.logger.warn(
          `Expo receipt fetch for ${chunk.length} ticket(s) failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      for (const [id, receipt] of Object.entries(receipts)) {
        settled.push(id);
        if (receipt.status === 'ok') continue;
        if (receipt.details?.error === 'DeviceNotRegistered') {
          deviceNotRegistered.push(id);
        } else {
          failed += 1;
        }
      }
    }

    return { settled, deviceNotRegistered, failed };
  }
}
