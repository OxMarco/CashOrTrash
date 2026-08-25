/**
 * Imported before `AppModule` — on purpose, and it has to stay first.
 *
 * `ConfigModule.forRoot` validates the environment synchronously, inside the
 * `@Module` decorator, so the check runs the moment `app.module` is required
 * rather than when Nest boots. The env schema requires a JWT secret, which CI
 * does not have: it emits the contract from a bare checkout with no `.env`.
 * Nothing in the emit signs a token and the document never depends on the
 * value, so a placeholder is supplied when none is set. A real `.env` still
 * wins — `??=` only fills the gap.
 */
process.env.JWT_ACCESS_SECRET ??= 'openapi-emit-placeholder-secret-not-used';
