export enum TokenType {
  ACCESS = 'access',
}

export interface AccessTokenPayload {
  sub: string;
  typ: TokenType;
  username?: string | null;
}
