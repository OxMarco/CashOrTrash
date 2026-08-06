import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

import { REDIS_CLIENT } from 'src/redis/redis.constants';

/**
 * Without this, two clients on different replicas would sit in the same
 * logical `match:{id}` room and never hear each other — which is exactly the
 * head-to-head failure mode the Phase 6 exit criterion tests for.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const client = this.app.get<Redis>(REDIS_CLIENT);

    // Pub/sub connections cannot issue ordinary commands, so both ends are
    // duplicates of the shared client rather than the client itself.
    const pubClient = client.duplicate();
    const subClient = client.duplicate();
    this.clients = [pubClient, subClient];

    // ioredis connects lazily, so without this the adapter would report
    // success at boot and only reveal an unreachable Redis on the first bet
    // pushed to an opponent.
    await Promise.all([pubClient.ping(), subClient.ping()]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.io Redis adapter connected');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      (server as { adapter: (a: unknown) => void }).adapter(
        this.adapterConstructor,
      );
    }
    return server;
  }

  /**
   * These two are duplicates, so nothing else owns them: without this they
   * outlive `app.close()` and a rolling deploy leaves a pair of connections
   * per replica behind until Redis times them out.
   */
  async close(server: Parameters<IoAdapter['close']>[0]): Promise<void> {
    await super.close(server);

    await Promise.all(
      this.clients.map((client) =>
        client.status === 'end'
          ? Promise.resolve()
          : client
              .quit()
              .catch((error: Error) =>
                this.logger.warn(`Adapter shutdown: ${error.message}`),
              ),
      ),
    );
    this.clients = [];
  }
}
