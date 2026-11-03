/**
 * Decode an OSC 52 clipboard payload (base64 of UTF-8 bytes). `atob()` alone
 * yields one char per byte, which turns every non-ASCII character into
 * Latin-1 mojibake (· → Â·, é → Ã©). Throws on malformed base64/UTF-8.
 */
export function decodeOsc52Payload(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
