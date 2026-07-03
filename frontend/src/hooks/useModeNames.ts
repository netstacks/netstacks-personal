/**
 * useModeNames — reactive access to the user-customizable AI agent-mode display
 * names, so every UI label updates live when a mode is renamed in Settings.
 * (For non-React contexts like the system prompt, use getModeName() from aiModes.)
 */
import { useSettings } from './useSettings'
import { AGENT_TYPES, type AgentType } from '../lib/aiModes'

export function useModeNames(): Record<AgentType, string> {
  const { settings } = useSettings()
  return {
    autopilot: settings['ai.modes.autopilot.name']?.trim() || AGENT_TYPES.autopilot.label,
    overlord: settings['ai.modes.overlord.name']?.trim() || AGENT_TYPES.overlord.label,
  }
}
