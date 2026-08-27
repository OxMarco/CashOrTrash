import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const AnonymousAuthSchema = z.strictObject({
  /**
   * Client-generated, stable per install. Re-posting the same id returns the
   * same player, which is what makes a reinstall-free app relaunch seamless.
   */
  deviceId: z
    .string({ error: 'must be a string' })
    .min(8, { error: 'must be at least 8 characters' })
    .max(128, { error: 'must be at most 128 characters' })
    .regex(/^[A-Za-z0-9._:-]+$/, { error: 'must be url-safe' })
    .describe(
      'Client-generated, stable per install. Re-posting the same id returns the\n' +
        'same player, which is what makes a reinstall-free app relaunch seamless.',
    )
    .meta({ example: '6f1c0a3e-8b6e-4a2f-9a9a-1c2d3e4f5a6b' }),
});

export class AnonymousAuthDto extends createZodDto(AnonymousAuthSchema) {}
