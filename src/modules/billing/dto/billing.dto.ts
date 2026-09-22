import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/** Where the player stands against the freemium line. Part of `/me`. */
export class BillingStateDto {
  @ApiProperty({
    description:
      'The id to configure the RevenueCat SDK with. Not the player id, and ' +
      'not to be shown or logged.',
  })
  @Expose()
  billingId: string;

  @ApiProperty({ description: 'True while the premium entitlement is live.' })
  @Expose()
  premium: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'When premium runs out as last confirmed with the store; renewals move ' +
      'it. Null when free.',
  })
  @Expose()
  premiumExpiresAt: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'Quick rounds a free player gets per UTC day; null if unlimited.',
  })
  @Expose()
  freeQuickRoundsPerDay: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Quick rounds left today; null if unlimited.',
  })
  @Expose()
  freeQuickRoundsRemaining: number | null;

  @ApiProperty({
    description: 'When the free allowance refills — next UTC midnight.',
  })
  @Expose()
  freeQuickRoundsResetAt: Date;
}

export class WebhookAckDto {
  @ApiProperty({ description: 'Players re-read from RevenueCat.' })
  @Expose()
  synced: number;
}

/**
 * The body RevenueCat posts. Only the ids are read; the event says who to
 * re-read, never what they now own.
 */
export type RevenueCatWebhookBody = {
  event?: {
    type?: string;
    app_user_id?: string;
    original_app_user_id?: string;
    aliases?: string[];
    transferred_from?: string[];
    transferred_to?: string[];
  };
};
