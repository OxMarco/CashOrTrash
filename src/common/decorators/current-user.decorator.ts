import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  id: number;
  username: string | null;
}

/**
 * Pulls the JWT-derived principal off the request. Populated by JwtStrategy.
 * `@CurrentUser('id')` narrows to a single field.
 */
export const CurrentUser = createParamDecorator(
  (
    field: keyof AuthenticatedUser | undefined,
    ctx: ExecutionContext,
  ): AuthenticatedUser | AuthenticatedUser[keyof AuthenticatedUser] => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return field ? request.user?.[field] : request.user;
  },
);
