import { envValidationSchema } from './env.validation';

const validEnv = () => ({
  DATABASE_HOST: 'postgres',
  DATABASE_USER: 'cashortrash',
  DATABASE_PASSWORD: 'secret',
  DATABASE_NAME: 'cashortrash',
  REDIS_HOST: 'redis',
  JWT_ACCESS_SECRET: 'access-secret-at-least-sixteen-characters',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-sixteen-characters',
  OPENAI_API_KEY: 'sk-test-key',
});

describe('environment validation', () => {
  it('accepts independent player secrets', () => {
    expect(envValidationSchema.validate(validEnv()).error).toBeUndefined();
  });

  it('rejects one secret reused for access and refresh tokens', () => {
    const env = validEnv();
    env.JWT_REFRESH_SECRET = env.JWT_ACCESS_SECRET;

    expect(envValidationSchema.validate(env).error?.message).toContain(
      'JWT_REFRESH_SECRET must differ',
    );
  });

  /**
   * The import writes every title and description in the catalogue. Booting it
   * without a key would import raw filenames and only look wrong once someone
   * played a round, so the contract refuses the combination up front.
   */
  it('requires an OpenAI key when the import runs on boot', () => {
    const { OPENAI_API_KEY: _omitted, ...env } = validEnv();

    expect(envValidationSchema.validate(env).error?.message).toContain(
      'OPENAI_API_KEY',
    );
  });

  it('allows the key to be absent when the import is switched off', () => {
    const { OPENAI_API_KEY: _omitted, ...env } = validEnv();

    expect(
      envValidationSchema.validate({ ...env, IMPORT_ON_BOOT: false }).error,
    ).toBeUndefined();
  });
});
