import {
  CallHandler,
  ClassSerializerInterceptor,
  ExecutionContext,
  Injectable,
  PlainLiteralObject,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

export const SKIP_SERIALIZATION = 'skipSerialization';

/**
 * Opt out of `excludeExtraneousValues` for one handler.
 *
 * Use this *only* for responses whose shape the framework owns and which carry
 * no domain data — the Terminus health payload is the sole case today. Never
 * put it on an endpoint that touches an entity: the whole point of the global
 * serializer is that a field reaches the client only if a DTO exposed it, and
 * that guarantee is what keeps `truePriceCents` off the wire.
 */
export const RawResponse = () => SetMetadata(SKIP_SERIALIZATION, true);

@Injectable()
export class DtoSerializerInterceptor extends ClassSerializerInterceptor {
  constructor(private readonly reflectorRef: Reflector) {
    super(reflectorRef, {
      excludeExtraneousValues: true,
      strategy: 'excludeAll',
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflectorRef.getAllAndOverride<boolean>(
      SKIP_SERIALIZATION,
      [context.getHandler(), context.getClass()],
    );

    return skip ? next.handle() : super.intercept(context, next);
  }

  /**
   * Guards against the failure this class exists to prevent: with
   * `excludeExtraneousValues`, class-transformer silently returns `{}` for a
   * plain object literal, because metadata lives on the class. Returning an
   * object literal from a controller would therefore ship an empty body
   * instead of leaking — safe, but baffling to debug. Fail loudly instead.
   */
  serialize(
    response: PlainLiteralObject | PlainLiteralObject[],
    options: Parameters<ClassSerializerInterceptor['serialize']>[1],
  ): PlainLiteralObject | PlainLiteralObject[] {
    assertNotPlain(response);
    return super.serialize(response, options);
  }
}

const assertNotPlain = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(assertNotPlain);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date || value instanceof Buffer) return;

  if (Object.getPrototypeOf(value) === Object.prototype) {
    throw new Error(
      'Controller returned a plain object. Wrap it with toDto(SomeDto, …) — ' +
        'a literal has no @Expose metadata and would serialize to {}.',
    );
  }
};
