import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { IsString } from 'class-validator';

import { AnonymousAuthDto } from 'src/modules/auth/dto/anonymous-auth.schema';
import { AppValidationPipe } from './app-validation.pipe';

const bodyMetadata = (metatype: ArgumentMetadata['metatype']) => ({
  type: 'body' as const,
  metatype,
});

class LegacyDto {
  @IsString()
  name: string;
}

describe('AppValidationPipe', () => {
  const pipe = new AppValidationPipe();

  it('parses strict Zod DTOs', async () => {
    await expect(
      pipe.transform(
        { deviceId: 'device-123' },
        bodyMetadata(AnonymousAuthDto),
      ),
    ).resolves.toEqual({ deviceId: 'device-123' });

    await expect(
      pipe.transform(
        { deviceId: 'device-123', unexpected: true },
        bodyMetadata(AnonymousAuthDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('retains strict class-validator behavior during migration', async () => {
    await expect(
      pipe.transform({ name: 'Sam' }, bodyMetadata(LegacyDto)),
    ).resolves.toMatchObject({ name: 'Sam' });

    await expect(
      pipe.transform(
        { name: 'Sam', unexpected: true },
        bodyMetadata(LegacyDto),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
