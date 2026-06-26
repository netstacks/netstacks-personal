// API types and utilities for the AI troubleshooting agent
// These types are used by the agent loop implementation (Plan 10-03)

import type { CliFlavor } from './sessions';
import type { AgentTool, ToolResult } from '../lib/agentTools';
import type { ValidationResult } from '../lib/readOnlyFilter';

// Re-export for convenience
export type { AgentTool, ToolResult };

/**
 * Permission modes (mirrors Claude Code approach)
 * - ask: User approves every tool call
 * - auto: Read-only commands auto-execute, writes need approval
 * - yolo: Everything auto-executes — no approval needed
 */
export type PermissionMode = 'ask' | 'auto' | 'yolo';

/**
 * Agent state machine states
 */
export type AgentState =
  | 'idle'              // Waiting for user input
  | 'thinking'          // AI is processing/reasoning
  | 'executing'         // Running a command
  | 'waiting_approval'  // Waiting for user to approve an action
  | 'error';            // An error occurred

/**
 * Message types in the agent conversation
 */
export type AgentMessageType =
  | 'user'              // User input message
  | 'agent-thinking'    // Agent reasoning/analysis
  | 'command-request'   // Agent wants to run a command
  | 'command-result'    // Result of command execution
  | 'recommendation'    // Config recommendation (not executed)
  | 'error'             // Error message
  | 'approval-request'; // Waiting for user approval

/**
 * A message in the agent conversation
 */
export interface AgentMessage {
  id: string;
  type: AgentMessageType;
  content: string;
  timestamp: Date;
  // For command-related messages
  command?: string;
  sessionId?: string;
  sessionName?: string;
  // For approval requests
  pendingCommands?: PendingCommand[];
  // For command results
  output?: string;
  exitCode?: number;
}

/**
 * A command pending user approval
 */
export interface PendingCommand {
  id: string;
  command: string;
  sessionId: string;
  sessionName: string;
  validation: ValidationResult;
}

/**
 * Session context available to the agent
 */
export interface AgentSessionContext {
  sessionId: string;
  sessionName: string;
  host: string;
  connected: boolean;
  cliFlavor: CliFlavor;
  recentOutput?: string;
}

/**
 * Tool call parsed from AI response
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Configuration recommendation from the agent
 */
export interface ConfigRecommendation {
  sessionId: string;
  sessionName: string;
  issue: string;
  configSnippet: string;
  explanation: string;
  timestamp: Date;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

/**
 * Generate a unique tool call ID
 */
export function generateToolCallId(): string {
  return `toolu_${crypto.randomUUID()}`;
}

/**
 * Format command output for display, truncating if too long
 * @param output The raw command output
 * @param maxLines Maximum lines to show (default: 100)
 * @returns Formatted output with truncation notice if needed
 */
export function formatCommandOutput(output: string, maxLines: number = 100): string {
  const lines = output.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
  }
  return output;
}

/**
 * Create a user message
 */
export function createUserMessage(content: string): AgentMessage {
  return {
    id: generateMessageId(),
    type: 'user',
    content,
    timestamp: new Date(),
  };
}

/**
 * Create an agent thinking message
 */
export function createThinkingMessage(content: string): AgentMessage {
  return {
    id: generateMessageId(),
    type: 'agent-thinking',
    content,
    timestamp: new Date(),
  };
}

/**
 * Create a command result message
 */
export function createCommandResultMessage(
  command: string,
  output: string,
  sessionId: string,
  sessionName: string,
  exitCode?: number
): AgentMessage {
  return {
    id: generateMessageId(),
    type: 'command-result',
    content: `Executed: ${command}`,
    command,
    output,
    sessionId,
    sessionName,
    exitCode,
    timestamp: new Date(),
  };
}

/**
 * Create an error message
 */
export function createErrorMessage(error: string): AgentMessage {
  return {
    id: generateMessageId(),
    type: 'error',
    content: error,
    timestamp: new Date(),
  };
}

/**
 * Create a recommendation message
 */
export function createRecommendationMessage(
  recommendation: ConfigRecommendation
): AgentMessage {
  return {
    id: generateMessageId(),
    type: 'recommendation',
    content: `**Issue:** ${recommendation.issue}\n\n**Recommended Configuration:**\n\`\`\`\n${recommendation.configSnippet}\n\`\`\`\n\n**Explanation:** ${recommendation.explanation}`,
    sessionId: recommendation.sessionId,
    sessionName: recommendation.sessionName,
    timestamp: new Date(),
  };
}
