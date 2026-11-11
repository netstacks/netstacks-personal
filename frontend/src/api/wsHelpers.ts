/**
 * Append a bearer token to a WebSocket URL as a query parameter.
 * Handles URLs that already contain query parameters.
 */
export function appendTokenToWsUrl(baseUrl: string, token: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}
