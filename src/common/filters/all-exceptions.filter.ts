import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { QueryFailedError } from 'typeorm';

/** RFC7807-ish body. `type` stays a stable machine-readable slug. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: unknown;
}

const SERVER_ERROR: number = HttpStatus.INTERNAL_SERVER_ERROR;

const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const problem = this.toProblem(exception, request?.url);

    // 4xx are the client's problem and are already described in the body;
    // only 5xx means something here is broken and wants a stack trace.
    if (problem.status >= SERVER_ERROR) {
      this.logger.error(
        { err: exception, path: problem.instance },
        'Unhandled exception',
      );
    }

    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send(problem);
  }

  private toProblem(exception: unknown, path?: string): ProblemDetails {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return {
          type: slug(exception.name),
          title: response,
          status,
          instance: path,
        };
      }

      const body = response as Record<string, unknown>;
      const message = body.message;
      // ValidationPipe hands us an array of constraint strings.
      const isFieldErrors = Array.isArray(message);

      return {
        type:
          typeof body.error === 'string'
            ? slug(body.error)
            : slug(exception.name),
        title: isFieldErrors
          ? 'Validation failed'
          : ((message as string) ?? exception.message),
        status,
        errors: isFieldErrors ? message : undefined,
        instance: path,
      };
    }

    if (exception instanceof QueryFailedError) {
      const code = (exception as QueryFailedError & { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return {
          type: 'conflict',
          title: 'Resource already exists',
          status: HttpStatus.CONFLICT,
          instance: path,
        };
      }
      if (code === PG_FK_VIOLATION || code === PG_CHECK_VIOLATION) {
        return {
          type: 'constraint-violation',
          title: 'Request violates a data constraint',
          status: HttpStatus.BAD_REQUEST,
          instance: path,
        };
      }
    }

    return {
      type: 'internal-error',
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      instance: path,
    };
  }
}

const slug = (value: string): string =>
  value
    .replace(/Exception$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();
