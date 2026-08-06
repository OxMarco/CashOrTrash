export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_SUBSCRIBER = Symbol('REDIS_SUBSCRIBER');

/**
 * The Keyv store behind `@nestjs/cache-manager`. It opens its own connection
 * (Keyv v5 speaks node-redis, not ioredis, so it cannot share the client
 * above), which is precisely why it is a provider here rather than an
 * anonymous instance inside `CacheModule.registerAsync` — something has to
 * own closing it.
 */
export const CACHE_STORE = Symbol('CACHE_STORE');
