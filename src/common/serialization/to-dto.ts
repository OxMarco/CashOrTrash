import { plainToInstance } from 'class-transformer';

type Constructor<T> = new (...args: never[]) => T;

/**
 * Builds a real response-DTO instance.
 *
 * This matters more than it looks. The global serializer runs with
 * `excludeExtraneousValues: true`, which only does its job when it can find
 * `@Expose()` metadata — and metadata lives on the class, not on an object
 * literal that merely satisfies the same TypeScript type. Returning a literal
 * would type-check while silently bypassing the filter that keeps
 * `truePriceCents` off the wire.
 *
 * Rule: controllers return `toDto(...)`, never an entity and never a literal.
 */
export const toDto = <T, S>(cls: Constructor<T>, source: S): T =>
  plainToInstance(cls, source, { excludeExtraneousValues: true });

export const toDtoArray = <T, S>(cls: Constructor<T>, source: S[]): T[] =>
  source.map((item) => toDto(cls, item));
