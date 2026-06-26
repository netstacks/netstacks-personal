// Command safety types for proactive dangerous command detection
// Phase 24: Smart Warnings & Suggestions

import type { CliFlavor } from '../api/sessions';

/**
 * Safety levels for commands
 * - safe: Command is read-only and safe to execute
 * - warn: Command may have side effects, user should be aware
 * - dangerous: Command could cause outage or data loss
 * - blocked: Command is never allowed (reserved for future use)
 */
export type SafetyLevel = 'safe' | 'warn' | 'dangerous' | 'blocked';

/**
 * Warning categories for better messaging and UI presentation
 */
export type WarningCategory =
  | 'config-mode'      // Entering configuration mode
  | 'destructive'      // Could cause outage (shutdown, reload, clear)
  | 'data-loss'        // Could lose data (delete, format, rm)
  | 'privilege'        // Privilege escalation (sudo, enable)
  | 'no-backup'        // Making changes without backup
  | 'production'       // Running on production device
  | 'irreversible'     // Cannot be undone easily
  | 'mass-impact';     // Affects multiple devices/services

/**
 * Result of command safety analysis
 */
export interface SafetyAnalysis {
  /** The highest safety level found */
  level: SafetyLevel;
  /** The original command that was analyzed */
  command: string;
  /** All warning categories that apply */
  categories: WarningCategory[];
  /** Detailed warnings with messages */
  warnings: Warning[];
  /** AI-generated safe alternatives (optional) */
  suggestions?: string[];
  /** Context that affected the analysis */
  context?: SafetyContext;
}

/**
 * Individual warning with category, message, and severity
 */
export interface Warning {
  /** The category of this warning */
  category: WarningCategory;
  /** Human-readable warning message */
  message: string;
  /** Severity affects how prominently the warning is displayed */
  severity: 'low' | 'medium' | 'high';
  /** Additional details (optional) */
  details?: string;
}

/**
 * Contextual information that affects safety analysis
 * Provides additional context to make better safety decisions
 */
export interface SafetyContext {
  /** The CLI flavor for vendor-specific rules */
  cliFlavor: CliFlavor;
  /** Whether the device is currently in configuration mode */
  inConfigMode?: boolean;
  /** The device hostname (used for production detection) */
  deviceHostname?: string;
  /** Whether this is a production device (can be inferred from hostname) */
  isProductionDevice?: boolean;
  /** Whether a recent backup exists */
  hasBackupRecent?: boolean;
  /** Whether we're in a maintenance window */
  maintenanceWindow?: boolean;
}

/**
 * Pattern definition for safety rules
 * Used internally by the safety engine
 */
export interface SafetyPattern {
  /** Regex pattern to match against command */
  pattern: RegExp;
  /** Safety level for matching commands */
  level: SafetyLevel;
  /** Category for the warning */
  category: WarningCategory;
  /** Human-readable warning message */
  message: string;
  /** Severity of the warning */
  severity: 'low' | 'medium' | 'high';
  /** Vendor-specific pattern (empty array = applies to all vendors) */
  vendors?: CliFlavor[];
}
