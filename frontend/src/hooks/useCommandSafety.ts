// Hook for managing command safety analysis state
// Phase 24: Smart Warnings & Suggestions
//
// This hook provides a clean interface for components to:
// - Analyze commands as the user types (for warning indicator)
// - Check commands before execution (for warning dialog)
// - Track pending commands awaiting user decision
//
// Usage:
//   const { currentAnalysis, checkBeforeSend, ... } = useCommandSafety({
//     cliFlavor: session?.cli_flavor || 'auto',
//     deviceHostname: session?.name,
//   })

import { useState, useCallback, useMemo } from 'react';
import type { SafetyAnalysis, SafetyContext } from '../types/commandSafety';
import { analyzeCommandSafety } from '../lib/commandSafetyEngine';
import type { CliFlavor } from '../api/sessions';

interface UseCommandSafetyOptions {
  cliFlavor: CliFlavor;
  deviceHostname?: string;
  enabled?: boolean;  // Allow disabling safety checks
}

interface UseCommandSafetyReturn {
  // Current analysis for the typing indicator
  currentAnalysis: SafetyAnalysis | null;
  // Pending analysis for the dialog (waiting for user decision)
  pendingAnalysis: SafetyAnalysis | null;
  // Analyze command (call on each keystroke)
  analyzeCommand: (command: string) => SafetyAnalysis | null;
  // Check if command should show dialog (call on Enter)
  checkBeforeSend: (command: string) => { shouldWarn: boolean; analysis: SafetyAnalysis };
  // Clear pending state (after user decision)
  clearPending: () => void;
  // Set pending (show dialog)
  setPending: (analysis: SafetyAnalysis) => void;
}

export function useCommandSafety({
  cliFlavor,
  deviceHostname,
  enabled = true,
}: UseCommandSafetyOptions): UseCommandSafetyReturn {
  const [currentAnalysis, setCurrentAnalysis] = useState<SafetyAnalysis | null>(null);
  const [pendingAnalysis, setPendingAnalysis] = useState<SafetyAnalysis | null>(null);

  const context = useMemo<SafetyContext>(() => ({
    cliFlavor,
    deviceHostname,
  }), [cliFlavor, deviceHostname]);

  const analyzeCommand = useCallback((command: string): SafetyAnalysis | null => {
    if (!enabled || !command.trim()) {
      setCurrentAnalysis(null);
      return null;
    }

    const analysis = analyzeCommandSafety(command, context);
    setCurrentAnalysis(analysis);
    return analysis;
  }, [enabled, context]);

  const checkBeforeSend = useCallback((command: string): { shouldWarn: boolean; analysis: SafetyAnalysis } => {
    const analysis = analyzeCommandSafety(command, context);

    // Only warn for 'warn' and 'dangerous' levels
    // 'blocked' commands should be handled differently (by readOnlyFilter)
    const shouldWarn = enabled && (analysis.level === 'warn' || analysis.level === 'dangerous');

    return { shouldWarn, analysis };
  }, [enabled, context]);

  const clearPending = useCallback(() => {
    setPendingAnalysis(null);
    setCurrentAnalysis(null);
  }, []);

  const setPending = useCallback((analysis: SafetyAnalysis) => {
    setPendingAnalysis(analysis);
  }, []);

  return {
    currentAnalysis,
    pendingAnalysis,
    analyzeCommand,
    checkBeforeSend,
    clearPending,
    setPending,
  };
}
