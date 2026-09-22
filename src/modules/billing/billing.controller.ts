import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { toDto } from 'src/common/serialization/to-dto';
import { BillingConfig } from 'src/config/configuration';
import { BillingService } from './billing.service';
import {
  BillingStateDto,
  RevenueCatWebhookBody,
  WebhookAckDto,
} from './dto/billing.dto';

@ApiTags('billing')
@Controller('me/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Re-read the player’s entitlement from the store.',
    description:
      'Called after a purchase or restore so the unlock is immediate. The ' +
      'server asks RevenueCat; nothing in the request is taken as proof.',
  })
  sync(@CurrentUser('id') userId: number): Promise<BillingStateDto> {
    return this.billing.sync(userId);
  }
}

/** Compared as digests so the check takes the same time however wrong it is. */
const digest = (value: string) => createHash('sha256').update(value).digest();

@Controller('webhooks')
export class RevenueCatWebhookController {
  private readonly expected: Buffer | null;

  constructor(
    private readonly billing: BillingService,
    config: ConfigService,
  ) {
    const auth =
      config.getOrThrow<BillingConfig>('billing').revenueCatWebhookAuth;
    this.expected = auth ? digest(auth) : null;
  }

  /**
   * Public, because RevenueCat has no player token; the shared secret it sends
   * as `Authorization` stands in for one. Unthrottled, because every event
   * arrives from a handful of RevenueCat addresses and a renewal wave must not
   * trip a per-address limit. A failure answers 5xx so RevenueCat retries.
   */
  @Public()
  @SkipThrottle()
  @Post('revenuecat')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async revenueCat(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RevenueCatWebhookBody,
  ): Promise<WebhookAckDto> {
    if (!this.expected) {
      throw new ServiceUnavailableException('Billing is not configured');
    }
    if (
      !authorization ||
      !timingSafeEqual(digest(authorization), this.expected)
    ) {
      throw new UnauthorizedException();
    }
    const synced = await this.billing.handleWebhook(body);
    return toDto(WebhookAckDto, { synced });
  }
}
