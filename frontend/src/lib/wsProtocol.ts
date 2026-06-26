/**
 * WebSocket binary message protocol for terminal data transfer.
 *
 * Implements the same binary protocol as Controller's ws/protocol.rs.
 * Format: [1 byte type][variable payload]
 *
 * This is efficient for terminal data where most messages are raw bytes.
 *
 * IMPORTANT: WebSocket must use binaryType = 'arraybuffer' for this protocol.
 */

/**
 * WebSocket message types (binary protocol).
 * Must match Controller's WsMessageType enum values exactly.
 */
export const WsMessageType = {
  /** Terminal data (stdin/stdout) */
  Data: 0x01,
  /** Terminal resize: payload = cols(u16) + rows(u16) big-endian */
  Resize: 0x02,
  /** Keepalive ping */
  Ping: 0x03,
  /** Keepalive pong */
  Pong: 0x04,
  /** Graceful close */
  Close: 0x05,
  /** Error message (UTF-8 string) */
  Error: 0x06,
  /** Reconnection token (16 bytes UUID) */
  Reconnect: 0x07,
  /** Session info (JSON) */
  SessionInfo: 0x08,
} as const;

export type WsMessageType = (typeof WsMessageType)[keyof typeof WsMessageType];

/**
 * Decoded WebSocket message with type and payload.
 */
export interface WsMessage {
  type: WsMessageType;
  payload: Uint8Array;
}

/**
 * Session info payload structure.
 */
export interface SessionInfo {
  session_id: string;
  credential_id: string;
}

/**
 * Encode a data message (terminal stdin/stdout).
 * @param data - String or binary data to send
 * @returns ArrayBuffer ready for ws.send()
 */
export function encodeDataMessage(data: string | Uint8Array): ArrayBuffer {
  const payload = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;

  const buffer = new ArrayBuffer(1 + payload.byteLength);
  const view = new Uint8Array(buffer);
  view[0] = WsMessageType.Data;
  view.set(payload, 1);

  return buffer;
}

/**
 * Encode a resize message with terminal dimensions.
 * Payload format: cols(u16 big-endian) + rows(u16 big-endian) = 4 bytes.
 * Total message size: 5 bytes (1 type + 4 payload).
 *
 * @param cols - Terminal columns
 * @param rows - Terminal rows
 * @returns ArrayBuffer ready for ws.send()
 */
export function encodeResizeMessage(cols: number, rows: number): ArrayBuffer {
  const buffer = new ArrayBuffer(5); // 1 type byte + 4 payload bytes
  const view = new DataView(buffer);

  view.setUint8(0, WsMessageType.Resize);
  view.setUint16(1, cols, false); // false = big-endian
  view.setUint16(3, rows, false); // false = big-endian

  return buffer;
}

/**
 * Encode a ping message for keepalive.
 * @returns ArrayBuffer ready for ws.send()
 */
export function encodePingMessage(): ArrayBuffer {
  const buffer = new ArrayBuffer(1);
  new Uint8Array(buffer)[0] = WsMessageType.Ping;
  return buffer;
}

/**
 * Encode a close message for graceful disconnect.
 * @returns ArrayBuffer ready for ws.send()
 */
export function encodeCloseMessage(): ArrayBuffer {
  const buffer = new ArrayBuffer(1);
  new Uint8Array(buffer)[0] = WsMessageType.Close;
  return buffer;
}

/**
 * Decode a binary WebSocket message.
 * @param data - ArrayBuffer received from WebSocket
 * @returns Decoded message with type and payload
 * @throws Error if message is empty or has invalid type
 */
export function decodeMessage(data: ArrayBuffer): WsMessage {
  if (data.byteLength === 0) {
    throw new Error('Empty WebSocket message');
  }

  const view = new Uint8Array(data);
  const type = view[0];

  // Validate message type
  if (type < 0x01 || type > 0x08) {
    throw new Error(`Invalid WebSocket message type: 0x${type.toString(16)}`);
  }

  // Extract payload (everything after the type byte)
  const payload = view.slice(1);

  return {
    type: type as WsMessageType,
    payload,
  };
}

/**
 * Helper: Decode payload as UTF-8 text.
 * Use for Data and Error message types.
 *
 * @param payload - Message payload bytes
 * @returns Decoded UTF-8 string
 */
export function payloadAsText(payload: Uint8Array): string {
  return new TextDecoder().decode(payload);
}

/**
 * Helper: Parse resize payload into dimensions.
 * Expects 4 bytes: cols(u16 big-endian) + rows(u16 big-endian).
 *
 * @param payload - Resize message payload
 * @returns Terminal dimensions
 * @throws Error if payload is not 4 bytes
 */
export function payloadAsResize(payload: Uint8Array): { cols: number; rows: number } {
  if (payload.byteLength !== 4) {
    throw new Error(`Invalid resize payload length: ${payload.byteLength} (expected 4)`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const cols = view.getUint16(0, false); // false = big-endian
  const rows = view.getUint16(2, false); // false = big-endian

  return { cols, rows };
}

/**
 * Helper: Parse reconnect token from 16-byte UUID payload.
 * Formats as standard UUID string (8-4-4-4-12 hex groups).
 *
 * @param payload - Reconnect message payload (16 bytes)
 * @returns UUID string
 * @throws Error if payload is not 16 bytes
 */
export function payloadAsReconnectToken(payload: Uint8Array): string {
  if (payload.byteLength !== 16) {
    throw new Error(`Invalid reconnect token length: ${payload.byteLength} (expected 16)`);
  }

  // Format as UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const hex = Array.from(payload)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Helper: Parse session info from JSON payload.
 *
 * @param payload - SessionInfo message payload (JSON string)
 * @returns Parsed session info
 * @throws Error if JSON is invalid
 */
export function payloadAsSessionInfo(payload: Uint8Array): SessionInfo {
  const text = payloadAsText(payload);
  return JSON.parse(text) as SessionInfo;
}
