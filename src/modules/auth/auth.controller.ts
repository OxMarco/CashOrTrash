import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';

import { Public } from 'src/common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { AccessTokenDto } from './dto/anonymous-auth.dto';
import { AnonymousAuthDto } from './dto/anonymous-auth.schema';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('anonymous')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Exchange a device id for a short-lived access token, registering on first sight.',
  })
  async anonymous(
    @Body() dto: AnonymousAuthDto,
    @Req() req: FastifyRequest,
  ): Promise<AccessTokenDto> {
    // Fastify trusts exactly the one ingress hop (see `trustProxy`), so this is
    // the client behind it rather than the hop itself.
    return this.auth.authenticateDevice(dto.deviceId, req.ip ?? null);
  }
}
