import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from 'src/common/decorators/public.decorator';
import { AuthService } from './auth.service';
import {
  AnonymousAuthDto,
  RefreshTokenDto,
  TokenPairDto,
} from './dto/anonymous-auth.dto';

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
      'Exchange a device id for a token pair, registering on first sight.',
  })
  async anonymous(@Body() dto: AnonymousAuthDto): Promise<TokenPairDto> {
    return this.auth.authenticateDevice(dto.deviceId);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Trade a refresh token for a fresh pair.' })
  async refresh(@Body() dto: RefreshTokenDto): Promise<TokenPairDto> {
    return this.auth.refresh(dto.refreshToken);
  }
}
