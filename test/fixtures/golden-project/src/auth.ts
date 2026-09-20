export function validateToken(token: string): boolean {
  return token.length > 0;
}

export function refreshToken(token: string): string {
  return `refreshed-${token}`;
}
