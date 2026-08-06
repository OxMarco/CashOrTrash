import { Inject, Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import Redis from 'ioredis';

import { withTimeout } from 'src/common/utils/with-timeout';
import { REDIS_CLIENT } from 'src/redis/redis.constants';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const started = Date.now();
      // Typed as the literal 'PONG' by ioredis; widened so the guard below is
      // a real runtime check rather than a comparison the compiler folds away.
      const pong: string = await withTimeout(
        this.redis.ping(),
        2_000,
        'Redis health check',
      );
      if (pong !== 'PONG') throw new Error(`Unexpected reply: ${pong}`);

      return this.getStatus(key, true, {
        responseTimeMs: Date.now() - started,
      });
    } catch (error) {
      throw new HealthCheckError(
        'Redis is unreachable',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }
}
