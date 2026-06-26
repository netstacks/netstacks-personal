/**
 * Troubleshooting Session Recorder Types
 *
 * Types for the troubleshooting session recorder feature that captures
 * terminal commands, outputs, and AI conversations during troubleshooting.
 */

/**
 * Settings for troubleshooting session behavior
 */
export interface TroubleshootingSettings {
  /** Inactivity timeout in minutes before auto-ending session (default: 15) */
  inactivityTimeout: number;
  /** Whether to auto-generate documentation on timeout (default: true) */
  autoSaveOnTimeout: boolean;
  /** Whether to capture AI chat conversations (default: true) */
  captureAIConversations: boolean;
  /** Default category for generated documentation (default: 'troubleshooting') */
  defaultCategory: string;
}

/**
 * Entry types for session recording
 */
export type SessionEntryType = 'command' | 'output' | 'ai-chat';

/**
 * A single entry in a troubleshooting session
 */
export interface SessionEntry {
  /** Timestamp when entry was recorded */
  timestamp: Date;
  /** ID of the terminal where this occurred */
  terminalId: string;
  /** Display name of the terminal */
  terminalName: string;
  /** Type of entry */
  type: SessionEntryType;
  /** The actual content (command text, output, or AI message) */
  content: string;
}

/**
 * A complete troubleshooting session with all captured data
 */
export interface TroubleshootingSession {
  /** Unique session identifier */
  id: string;
  /** User-provided session name/description */
  name: string;
  /** When the session started */
  startTime: Date;
  /** Terminal IDs being captured in this session */
  terminalIds: string[];
  /** All captured entries in chronological order */
  entries: SessionEntry[];
  /** Optional attached topology snapshot ID */
  topologyId?: string;
  /** Timestamp of last activity (for timeout detection) */
  lastActivityTime: Date;
}

/**
 * Session state for UI display
 */
export type TroubleshootingSessionState = 'inactive' | 'recording' | 'ending';
