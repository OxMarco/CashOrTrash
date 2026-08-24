import { envValidationSchema } from './env.validation';

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_HOST: 'postgres',
  DATABASE_USER: 'cashortrash',
  DATABASE_PASSWORD: 'secret',
  DATABASE_NAME: 'cashortrash',
  REDIS_HOST: 'redis',
  JWT_ACCESS_SECRET: 'access-secret-with-at-least-32-characters',
  OPENAI_API_KEY: 'sk-test-key',
  SLIDER_SEED_SECRET: 'slider-secret-with-at-least-32-characters',
  DAILY_SEED_SECRET: 'daily-secret-with-at-least-32-characters!',
  SUPPORT_EMAIL: 'support@example.com',
  // No app identity: the app is not in the stores yet, and production must
  // boot without it.
  APPLE_APP_ID: '',
  ANDROID_SHA256_CERT_FINGERPRINT: '',
  ADMIN_PASSWORD_HASH: `${'a'.repeat(32)}:${'b'.repeat(128)}`,
  ADMIN_JWT_SECRET: 'admin-secret-with-at-least-32-characters',
};

describe('production environment validation', () => {
  it('rejects a malformed app identity rather than serving it', () => {
    expect(
      envValidationSchema.validate({
        ...productionEnvironment,
        APPLE_APP_ID: 'not-a-team-id.fun.cashortrash.app',
      }).error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({
        ...productionEnvironment,
        ANDROID_SHA256_CERT_FINGERPRINT: 'AA:BB',
      }).error,
    ).toBeDefined();
  });

  it('defaults to migrations, real push delivery, and leaderboard probation', () => {
    const { error, value } = envValidationSchema.validate(
      productionEnvironment,
    );

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      PUSH_PROVIDER: 'expo',
      LEADERBOARD_MIN_ACCOUNT_AGE_HOURS: 24,
    });
  });

  it('turns the dwell floor on, and keeps the draw exclusions armed', () => {
    const { value } = envValidationSchema.validate(productionEnvironment);

    expect(value).toMatchObject({
      MIN_ROUND_SECONDS: 1,
      ITEM_COOLDOWN_DAYS: 30,
      DAILY_PREGENERATE_DAYS: 1,
      QUICK_SESSIONS_PER_HOUR: 30,
      ACCOUNTS_PER_IP_PER_DAY: 50,
    });
  });

  it('rejects a logging-only push sender or a missing seed secret', () => {
    expect(
      envValidationSchema.validate({
        ...productionEnvironment,
        PUSH_PROVIDER: 'logging',
      }).error,
    ).toBeDefined();
    const { SLIDER_SEED_SECRET: _noSlider, ...withoutSlider } =
      productionEnvironment;
    expect(envValidationSchema.validate(withoutSlider).error).toBeDefined();

    // The draw's key, on the same footing as the slider's: without it every
    // future daily is computable from a calendar.
    const { DAILY_SEED_SECRET: _noDaily, ...withoutDaily } =
      productionEnvironment;
    expect(envValidationSchema.validate(withoutDaily).error).toBeDefined();
  });
});

describe('PUBLIC_ORIGIN', () => {
  const validate = (overrides: Record<string, unknown>) =>
    envValidationSchema.validate({ ...productionEnvironment, ...overrides });

  it('defaults to empty, which drops the link from a shared result', () => {
    const { error, value } = validate({});

    expect(error).toBeUndefined();
    expect(value.PUBLIC_ORIGIN).toBe('');
  });

  it('accepts the deployment origin', () => {
    const { error, value } = validate({
      PUBLIC_ORIGIN: 'https://cashortrash.fun',
    });

    expect(error).toBeUndefined();
    expect(value.PUBLIC_ORIGIN).toBe('https://cashortrash.fun');
  });

  // A share is read on other people's phones. An http origin would hand every
  // one of those readers a downgrade warning, which is worse than no link.
  it('refuses an insecure origin rather than shipping it to readers', () => {
    const { error } = validate({ PUBLIC_ORIGIN: 'http://cashortrash.fun' });

    expect(error).toBeDefined();
  });

  it('refuses something that is not a URL at all', () => {
    const { error } = validate({ PUBLIC_ORIGIN: 'cashortrash.fun' });

    expect(error).toBeDefined();
  });
});

describe('admin portal', () => {
  const without = (key: string) => {
    const environment: Record<string, unknown> = { ...productionEnvironment };
    delete environment[key];
    return envValidationSchema.validate(environment).error;
  };

  // The catalogue can only be filled through the portal, so a production
  // deployment without one has no way to become playable.
  it.each(['ADMIN_PASSWORD_HASH', 'ADMIN_JWT_SECRET'])(
    'refuses a production boot with no %s',
    (key) => {
      expect(without(key)?.message).toContain(key);
    },
  );

  // The likeliest mistake is pasting the password itself here. That would store
  // a plaintext credential and reject every login, which reads as a forgotten
  // password rather than as the misconfiguration it is.
  it('refuses a password hash that is not a salt:key pair', () => {
    const { error } = envValidationSchema.validate({
      ...productionEnvironment,
      ADMIN_PASSWORD_HASH: 'my-actual-password',
    });
    expect(error?.message).toContain('ADMIN_PASSWORD_HASH');
  });

  it('refuses an admin secret short enough to be a memorable phrase', () => {
    const { error } = envValidationSchema.validate({
      ...productionEnvironment,
      ADMIN_JWT_SECRET: 'hunter2',
    });
    expect(error?.message).toContain('ADMIN_JWT_SECRET');
  });

  // Sharing one secret would let any player token — which every install holds —
  // be replayed against the portal with one claim changed.
  it('keeps the admin secret separate from the player secret', () => {
    const { value } = envValidationSchema.validate(productionEnvironment);
    expect(value.ADMIN_JWT_SECRET).not.toEqual(value.JWT_ACCESS_SECRET);
  });

  it('leaves the portal optional outside production, so a checkout boots', () => {
    const {
      ADMIN_PASSWORD_HASH: _hash,
      ADMIN_JWT_SECRET: _secret,
      OPENAI_API_KEY: _key,
      ...rest
    } = productionEnvironment;
    const { error } = envValidationSchema.validate({
      ...rest,
      NODE_ENV: 'development',
    });
    expect(error).toBeUndefined();
  });
});
