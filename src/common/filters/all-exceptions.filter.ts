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

import {
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from 'src/common/database/pg-error-codes';
import { redactHealthDetails } from 'src/health/redact-health';

/** RFC7807-ish body. `type` stays a stable machine-readable slug. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: unknown;
  /**
   * Per-dependency up/down; only set on a failed readiness probe. Deliberately
   * no more than that — see `redactHealthDetails`.
   */
  checks?: Record<string, { status: 'up' | 'down' }>;
}

const SERVER_ERROR: number = HttpStatus.INTERNAL_SERVER_ERROR;

/**
 * Terminus reports a failed probe as a `ServiceUnavailableException` carrying a
 * `HealthCheckResult`: which dependencies are up, which are down, and the
 * details each indicator attached. That map is the entire point of readiness —
 * every indicator produces one rather than let a driver error escape — and the
 * generic object branch below would flatten it to the bare title "Service
 * Unavailable Exception", leaving a 503 that says something is wrong but not
 * which dependency. Recognised here so the envelope stays problem+json while
 * the map survives — reduced to up/down per dependency before it leaves.
 */
interface HealthCheckPayload {
  status: string;
  error?: Record<string, unknown>;
  details: Record<string, unknown>;
}

const asHealthCheck = (
  body: Record<string, unknown>,
): HealthCheckPayload | undefined =>
  body.status === 'error' && isRecord(body.details)
    ? (body as unknown as HealthCheckPayload)
    : undefined;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const problem = this.toProblem(exception, request?.url);

    // An unhealthy probe is expected operational state, not an unhandled
    // application exception. Keep it visible without emitting a misleading
    // stack trace every time an orchestrator polls readiness. The full
    // indicator details go to the log — the only place they are kept, since
    // the response carries up/down alone.
    if (problem.checks) {
      this.logger.warn(
        { path: problem.instance, checks: healthDetailsOf(exception) },
        problem.title,
      );
    } else if (problem.status >= SERVER_ERROR) {
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

      const health = asHealthCheck(body);
      if (health) {
        const down = Object.keys(health.error ?? {});
        return {
          // Unchanged from what the generic branch derives from the exception
          // name, so the machine-readable contract does not move; the detail
          // arrives in `checks` instead.
          type: slug(exception.name),
          title: down.length
            ? `Health check failed: ${down.join(', ')}`
            : 'Health check failed',
          status,
          checks: redactHealthDetails(health.details),
          instance: path,
        };
      }

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
      if (code === PG_FOREIGN_KEY_VIOLATION || code === PG_CHECK_VIOLATION) {
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

/** The unredacted Terminus details on a failed probe, for the log only. */
const healthDetailsOf = (exception: unknown): unknown => {
  if (!(exception instanceof HttpException)) return undefined;
  const response = exception.getResponse();
  return isRecord(response) ? asHealthCheck(response)?.details : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const slug = (value: string): string =>
  value
    .replace(/Exception$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();
