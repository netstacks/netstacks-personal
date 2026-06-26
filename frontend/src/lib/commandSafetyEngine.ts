// Command safety analysis engine for proactive dangerous command detection
// Phase 24: Smart Warnings & Suggestions
//
// This engine classifies commands into safety levels and provides warnings
// for potentially dangerous operations. It extends the read-only filter
// patterns with proactive warning generation.
//
// Exports:
//   Analysis:
//     - analyzeCommandSafety(command, context) - Full safety analysis
//     - commandNeedsWarning(command, cliFlavor?) - Quick boolean check
//
//   UI Helpers:
//     - getSafetyColor(level) - CSS color for safety level
//     - getSafetyIcon(level) - Unicode icon for safety level
//     - formatWarningsForDisplay(analysis) - Multi-line warning text
//     - getSafetySummary(analysis) - Brief summary for tooltips
//
//   Convenience:
//     - isDangerous(analysis) - Check if dangerous or blocked
//     - hasWarning(analysis) - Check if level is not safe
//     - getSafeAlternatives(command, cliFlavor) - Suggest read-only commands

import type { CliFlavor } from '../types/enrichment';
import type {
  SafetyAnalysis,
  SafetyLevel,
  SafetyPattern,
  SafetyContext,
  Warning,
  WarningCategory,
} from '../types/commandSafety';

/**
 * Universal dangerous patterns (apply to all vendors)
 * These patterns are checked against all commands regardless of CLI flavor
 */
const DANGEROUS_PATTERNS: SafetyPattern[] = [
  // Destructive commands - HIGH severity
  {
    pattern: /\breload\b/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'Device reload will cause outage',
    severity: 'high',
  },
  {
    pattern: /\breboot\b/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'Device reboot will cause outage',
    severity: 'high',
  },
  {
    pattern: /\bshutdown\b/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'Interface/device shutdown will cause outage',
    severity: 'high',
  },
  {
    pattern: /\bformat\b/i,
    level: 'dangerous',
    category: 'data-loss',
    message: 'Format will erase all data',
    severity: 'high',
  },
  {
    pattern: /\brm\s+-rf?\b/i,
    level: 'dangerous',
    category: 'data-loss',
    message: 'Recursive delete is irreversible',
    severity: 'high',
  },

  // Configuration mode - MEDIUM severity (warning, not blocked)
  {
    pattern: /\bconf(ig(ure)?)?\s*t(erm(inal)?)?\b/i,
    level: 'warn',
    category: 'config-mode',
    message: 'Entering configuration mode',
    severity: 'medium',
  },
  {
    pattern: /\bedit\b/i,
    level: 'warn',
    category: 'config-mode',
    message: 'Entering edit mode (Juniper)',
    severity: 'medium',
    vendors: ['juniper'],
  },

  // Privilege escalation
  {
    pattern: /\benable\b/i,
    level: 'warn',
    category: 'privilege',
    message: 'Entering privileged mode',
    severity: 'low',
  },
  {
    pattern: /\bsudo\s+/i,
    level: 'warn',
    category: 'privilege',
    message: 'Running with elevated privileges',
    severity: 'medium',
  },

  // Data modification
  {
    pattern: /\bdelete\b/i,
    level: 'warn',
    category: 'data-loss',
    message: 'Delete operation',
    severity: 'medium',
  },
  {
    pattern: /\bclear\s+(?!screen|line)/i,
    level: 'warn',
    category: 'destructive',
    message: 'Clear operation may disrupt service',
    severity: 'medium',
  },
  {
    pattern: /\breset\b/i,
    level: 'warn',
    category: 'destructive',
    message: 'Reset may disrupt service',
    severity: 'medium',
  },

  // Write/save operations
  {
    pattern: /\b(wr(ite)?)\s+er(ase)?\b/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'Erases startup configuration - device will boot with no config. Try: show startup-config, copy startup-config tftp:',
    severity: 'high',
  },
  {
    pattern: /\b(wr(ite)?)\s+mem(ory)?\b/i,
    level: 'warn',
    category: 'irreversible',
    message: 'Saving running config to startup',
    severity: 'medium',
  },
  {
    pattern: /\bcopy\s+run(ning)?/i,
    level: 'warn',
    category: 'irreversible',
    message: 'Copying running config',
    severity: 'low',
  },
  {
    pattern: /\bcommit\b/i,
    level: 'warn',
    category: 'irreversible',
    message: 'Committing configuration changes',
    severity: 'medium',
    vendors: ['juniper', 'arista'],
  },

  // Routing changes
  {
    pattern: /\bno\s+(ip\s+)?route\b/i,
    level: 'warn',
    category: 'mass-impact',
    message: 'Removing route may affect connectivity',
    severity: 'high',
  },
  {
    pattern: /\bclear\s+(ip\s+)?(bgp|ospf|eigrp)/i,
    level: 'dangerous',
    category: 'mass-impact',
    message: 'Clearing routing protocol will cause reconvergence',
    severity: 'high',
  },

  // Interface changes
  {
    pattern: /\bno\s+interface\b/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'Removing interface configuration',
    severity: 'high',
  },

  // VLAN changes
  {
    pattern: /\bno\s+vlan\s+\d+/i,
    level: 'warn',
    category: 'mass-impact',
    message: 'Removing VLAN may affect connected devices',
    severity: 'high',
  },

  // System-level operations (Juniper)
  {
    pattern: /\brequest\s+system\s+(halt|power-off|reboot)/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'System operation will cause outage',
    severity: 'high',
    vendors: ['juniper'],
  },

  // Fortinet diagnostics that modify state
  {
    pattern: /\bexecute\s+(formatlogdisk|factory|shutdown)/i,
    level: 'dangerous',
    category: 'destructive',
    message: 'Destructive execute command',
    severity: 'high',
    vendors: ['fortinet'],
  },
];

/**
 * Production device detection patterns
 * Hostnames matching these patterns are likely production devices
 */
const PRODUCTION_HOSTNAME_PATTERNS = [
  /^(prod|prd|pr)-/i,
  /-prod$/i,
  /^core-/i,
  /^edge-/i,
  /^border-/i,
  /^dc\d+-/i, // dc1-, dc2-, etc.
  /^spine-/i,
  /^leaf-/i,
  /^fw-/i,   // firewall
  /^lb-/i,   // load balancer
];

/**
 * Level priority for comparison
 */
const LEVEL_PRIORITY: Record<SafetyLevel, number> = {
  safe: 0,
  warn: 1,
  dangerous: 2,
  blocked: 3,
};

/**
 * Analyze a command for safety
 * Returns detailed analysis including warnings and context
 *
 * @param command The command to analyze
 * @param context Safety context with CLI flavor and device info
 * @returns SafetyAnalysis with level, warnings, and suggestions
 */
export function analyzeCommandSafety(
  command: string,
  context: SafetyContext
): SafetyAnalysis {
  const trimmed = command.trim();
  const warnings: Warning[] = [];
  const categories: Set<WarningCategory> = new Set();
  let highestLevel: SafetyLevel = 'safe';

  // Check all dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    // Skip if pattern is vendor-specific and doesn't match
    if (
      pattern.vendors &&
      pattern.vendors.length > 0 &&
      !pattern.vendors.includes(context.cliFlavor)
    ) {
      continue;
    }

    if (pattern.pattern.test(trimmed)) {
      warnings.push({
        category: pattern.category,
        message: pattern.message,
        severity: pattern.severity,
      });
      categories.add(pattern.category);

      // Update highest level
      if (LEVEL_PRIORITY[pattern.level] > LEVEL_PRIORITY[highestLevel]) {
        highestLevel = pattern.level;
      }
    }
  }

  // Check hostname for production indicators
  if (context.deviceHostname && !context.isProductionDevice) {
    for (const pattern of PRODUCTION_HOSTNAME_PATTERNS) {
      if (pattern.test(context.deviceHostname)) {
        context.isProductionDevice = true;
        break;
      }
    }
  }

  // Contextual warnings - production device
  if (context.isProductionDevice && highestLevel !== 'safe') {
    warnings.push({
      category: 'production',
      message: `Running on production device: ${context.deviceHostname || 'unknown'}`,
      severity: 'high',
    });
    categories.add('production');
    // Escalate warn to dangerous on production
    if (highestLevel === 'warn') {
      highestLevel = 'dangerous';
    }
  }

  // Get safe alternatives if there are warnings
  const suggestions =
    warnings.length > 0 ? getSafeAlternatives(trimmed, context.cliFlavor) : undefined;

  return {
    level: highestLevel,
    command: trimmed,
    categories: Array.from(categories),
    warnings,
    suggestions: suggestions && suggestions.length > 0 ? suggestions : undefined,
    context,
  };
}

/**
 * Quick check if command needs warning
 * Use this for simple boolean checks without full analysis
 *
 * @param command The command to check
 * @param cliFlavor Optional CLI flavor for vendor-specific rules
 * @returns true if command needs a warning
 */
export function commandNeedsWarning(
  command: string,
  cliFlavor: CliFlavor = 'auto'
): boolean {
  const result = analyzeCommandSafety(command, { cliFlavor });
  return result.level !== 'safe';
}

/**
 * Get severity color for UI display
 *
 * @param level Safety level
 * @returns CSS color string
 */
export function getSafetyColor(level: SafetyLevel): string {
  switch (level) {
    case 'safe':
      return '#22c55e'; // green
    case 'warn':
      return '#eab308'; // yellow
    case 'dangerous':
      return '#f97316'; // orange
    case 'blocked':
      return '#dc2626'; // red
  }
}

/**
 * Get icon for safety level
 *
 * @param level Safety level
 * @returns Unicode icon character
 */
export function getSafetyIcon(level: SafetyLevel): string {
  switch (level) {
    case 'safe':
      return '\u2713'; // checkmark
    case 'warn':
      return '\u26A0'; // warning triangle
    case 'dangerous':
      return '\u26A0\uFE0F'; // warning emoji
    case 'blocked':
      return '\uD83D\uDED1'; // stop sign
  }
}

/**
 * Get suggested safe alternatives for a command
 * Provides read-only alternatives when possible
 *
 * @param command The command to get alternatives for
 * @param cliFlavor The CLI flavor for vendor-specific suggestions
 * @returns Array of suggested safe commands
 */
export function getSafeAlternatives(
  command: string,
  cliFlavor: CliFlavor
): string[] {
  const alternatives: string[] = [];
  const lower = command.toLowerCase().trim();

  // Config mode -> suggest show commands
  if (/conf(ig)?/.test(lower)) {
    alternatives.push('show running-config');
    alternatives.push('show startup-config');
  }

  // Clear BGP -> suggest show first
  if (/clear.*bgp/.test(lower)) {
    alternatives.push('show ip bgp summary');
    alternatives.push('show ip bgp neighbors');
  }

  // Reload -> suggest saving config first
  if (/reload|reboot/.test(lower)) {
    alternatives.push('write memory (save config first)');
    alternatives.push('show running-config | diff startup-config');
  }

  // Shutdown -> suggest show interface
  if (/shutdown/.test(lower)) {
    alternatives.push('show interface status');
    alternatives.push('show interface brief');
  }

  // Clear routing -> suggest show routes
  if (/clear.*(ospf|bgp|eigrp)/.test(lower)) {
    if (/ospf/.test(lower)) {
      alternatives.push('show ip ospf neighbor');
      alternatives.push('show ip ospf database');
    }
    if (/bgp/.test(lower)) {
      alternatives.push('show ip bgp summary');
    }
    if (/eigrp/.test(lower)) {
      alternatives.push('show ip eigrp neighbors');
    }
  }

  // Vendor-specific alternatives
  if (cliFlavor === 'juniper') {
    if (/commit/.test(lower)) {
      alternatives.push('show | compare');
      alternatives.push('commit check');
    }
    if (/request\s+system/.test(lower)) {
      alternatives.push('show system uptime');
      alternatives.push('show chassis alarms');
    }
  }

  if (cliFlavor === 'fortinet') {
    if (/execute\s+shutdown/.test(lower)) {
      alternatives.push('get system status');
      alternatives.push('diagnose sys top');
    }
  }

  return alternatives;
}

/**
 * Format warnings for display in UI
 * Creates a human-readable multi-line string
 *
 * @param analysis The safety analysis to format
 * @returns Formatted string for display
 */
export function formatWarningsForDisplay(analysis: SafetyAnalysis): string {
  if (analysis.warnings.length === 0) return '';

  const lines: string[] = [];
  lines.push(`Command: ${analysis.command}`);
  lines.push(`Safety Level: ${analysis.level.toUpperCase()}`);
  lines.push('');
  lines.push('Warnings:');

  for (const warning of analysis.warnings) {
    const icon =
      warning.severity === 'high'
        ? '\uD83D\uDD34' // red circle
        : warning.severity === 'medium'
          ? '\uD83D\uDFE1' // yellow circle
          : '\uD83D\uDFE2'; // green circle
    lines.push(`${icon} ${warning.message}`);
  }

  if (analysis.suggestions && analysis.suggestions.length > 0) {
    lines.push('');
    lines.push('Safe alternatives:');
    for (const suggestion of analysis.suggestions) {
      lines.push(`  - ${suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if analysis indicates a dangerous operation
 * Convenience function for conditional rendering
 *
 * @param analysis The safety analysis
 * @returns true if level is dangerous or blocked
 */
export function isDangerous(analysis: SafetyAnalysis): boolean {
  return analysis.level === 'dangerous' || analysis.level === 'blocked';
}

/**
 * Check if analysis indicates any warning
 * Convenience function for conditional rendering
 *
 * @param analysis The safety analysis
 * @returns true if level is not safe
 */
export function hasWarning(analysis: SafetyAnalysis): boolean {
  return analysis.level !== 'safe';
}

/**
 * Get a brief summary message for a safety analysis
 * Suitable for tooltips or status messages
 *
 * @param analysis The safety analysis
 * @returns Brief summary string
 */
export function getSafetySummary(analysis: SafetyAnalysis): string {
  if (analysis.level === 'safe') {
    return 'Command is safe to execute';
  }

  const warningCount = analysis.warnings.length;
  const highSeverityCount = analysis.warnings.filter(
    (w) => w.severity === 'high'
  ).length;

  if (analysis.level === 'dangerous') {
    return `Dangerous: ${highSeverityCount} critical warning${highSeverityCount !== 1 ? 's' : ''}`;
  }

  return `${warningCount} warning${warningCount !== 1 ? 's' : ''} detected`;
}
