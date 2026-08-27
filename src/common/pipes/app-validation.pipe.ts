import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { createZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';

const isZodDto = (metatype: unknown): boolean =>
  typeof metatype === 'function' &&
  (metatype as unknown as { isZodDto?: boolean }).isZodDto === true;

const validationMessages = (error: unknown): string[] => {
  if (!(error instanceof z.ZodError)) return ['Request validation failed'];

  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
};

const AppZodValidationPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new BadRequestException(validationMessages(error)),
});

/**
 * Lets request DTOs move to Zod one boundary at a time while the remaining
 * class-validator DTOs retain the application's strict whitelist semantics.
 */
export class AppValidationPipe extends ValidationPipe {
  private readonly zod = new AppZodValidationPipe();

  constructor() {
    super({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });
  }

  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    if (isZodDto(metadata.metatype)) {
      return (await this.zod.transform(value, metadata)) as unknown;
    }
    return (await super.transform(value, metadata)) as unknown;
  }
}
