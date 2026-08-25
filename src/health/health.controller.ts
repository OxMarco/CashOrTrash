import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

import { Public } from 'src/common/decorators/public.decorator';
import { RawResponse } from 'src/common/interceptors/dto-serializer.interceptor';
import { QueueHealthIndicator } from './queue.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * The only controller carrying `@RawResponse()`: Terminus owns the payload
 * shape and it contains no domain data, so there is nothing here for the
 * serializer to protect.
 */
@ApiTags('health')
@RawResponse()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly queue: QueueHealthIndicator,
  ) {}

  /**
   * Liveness answers "is this process wedged" and nothing else. It must not
   * touch a dependency: a Postgres blip should not make the orchestrator kill
   * every replica.
   */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — process only, no dependencies.' })
  live(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness answers "can this replica serve traffic", so it does check —
   * but only the things that stop it serving. Content is not one of them: an
   * empty catalogue still answers every route, and gating on it would take a
   * working replica out of rotation over a state no deploy can change.
   */
  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe — database, Redis and queue.',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 2000 }),
      () => this.redis.isHealthy('redis'),
      () => this.queue.isHealthy('queue'),
    ]);
  }
}
