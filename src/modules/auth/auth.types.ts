export enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
}

export interface AccessTokenPayload {
  sub: string;
  typ: TokenType;
  username?: string | null;
}

export interface RefreshTokenPayload {
  sub: string;
  typ: TokenType;
}
