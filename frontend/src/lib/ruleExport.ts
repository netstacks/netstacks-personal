/**
 * Rule Export/Import utilities for sharing highlight rules
 *
 * Export format is a JSON file containing rule configurations that can be
 * shared between users or backed up. The format excludes IDs and timestamps
 * to allow clean importing into different installations.
 */

import type { HighlightRule, NewHighlightRule } from '../api/highlightRules';
import { downloadFile } from './formatters';

/**
 * Exported rule format - excludes IDs, timestamps, and session_id
 */
export interface ExportedRule {
  name: string;
  pattern: string;
  is_regex: boolean;
  case_sensitive: boolean;
  whole_word: boolean;
  foreground: string | null;
  background: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  category: string;
  priority: number;
}

/**
 * Export file structure
 */
export interface RuleExportFile {
  version: '1.0';
  exported_at: string;
  source?: string;
  rules: ExportedRule[];
}

/**
 * Import result
 */
export interface RuleImportResult {
  rules: NewHighlightRule[];
  warnings: string[];
}

/**
 * Convert a HighlightRule to exportable format (strips IDs, timestamps, session_id)
 */
export function ruleToExport(rule: HighlightRule): ExportedRule {
  return {
    name: rule.name,
    pattern: rule.pattern,
    is_regex: rule.is_regex,
    case_sensitive: rule.case_sensitive,
    whole_word: rule.whole_word,
    foreground: rule.foreground,
    background: rule.background,
    bold: rule.bold,
    italic: rule.italic,
    underline: rule.underline,
    category: rule.category,
    priority: rule.priority,
  };
}

/**
 * Convert exported rule back to NewHighlightRule for import
 */
export function exportToNewRule(exported: ExportedRule, sessionId?: string | null): NewHighlightRule {
  return {
    name: exported.name,
    pattern: exported.pattern,
    is_regex: exported.is_regex,
    case_sensitive: exported.case_sensitive,
    whole_word: exported.whole_word,
    foreground: exported.foreground,
    background: exported.background,
    bold: exported.bold,
    italic: exported.italic,
    underline: exported.underline,
    category: exported.category,
    priority: exported.priority,
    enabled: true,
    session_id: sessionId || null,
  };
}

/**
 * Export rules to JSON string
 *
 * @param rules - Rules to export
 * @param source - Optional source identifier (e.g., "NetStacks Export")
 * @returns JSON string ready for download
 */
export function exportRulesToJson(rules: HighlightRule[], source?: string): string {
  const exportData: RuleExportFile = {
    version: '1.0',
    exported_at: new Date().toISOString(),
    source: source || 'NetStacks',
    rules: rules.map(ruleToExport),
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Parse rules from JSON string
 *
 * @param json - JSON string from import file
 * @returns Parsed rules and any warnings
 * @throws Error if JSON is invalid or format is unrecognized
 */
export function parseRulesFromJson(json: string): RuleImportResult {
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON format');
  }

  // Handle array format (simple rule list)
  if (Array.isArray(parsed)) {
    const rules = parseRuleArray(parsed, warnings);
    return { rules, warnings };
  }

  // Handle object format with metadata
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    // Check for our export format
    if (obj.version === '1.0' && Array.isArray(obj.rules)) {
      const rules = parseRuleArray(obj.rules, warnings);
      return { rules, warnings };
    }

    // Legacy format - try to extract rules
    if (Array.isArray(obj.rules)) {
      warnings.push('Unknown format version, attempting import');
      const rules = parseRuleArray(obj.rules, warnings);
      return { rules, warnings };
    }

    // Single rule object
    if (typeof obj.pattern === 'string') {
      const rule = parseRuleObject(obj as Record<string, unknown>, warnings);
      if (rule) {
        return { rules: [rule], warnings };
      }
    }
  }

  throw new Error('Unrecognized format: expected rules array or export file');
}

/**
 * Parse an array of rule objects
 */
function parseRuleArray(arr: unknown[], warnings: string[]): NewHighlightRule[] {
  const rules: NewHighlightRule[] = [];

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'object' || item === null) {
      warnings.push(`Skipped item ${i + 1}: not an object`);
      continue;
    }

    const rule = parseRuleObject(item as Record<string, unknown>, warnings, i);
    if (rule) {
      rules.push(rule);
    }
  }

  return rules;
}

/**
 * Parse a single rule object
 */
function parseRuleObject(
  obj: Record<string, unknown>,
  warnings: string[],
  index?: number
): NewHighlightRule | null {
  const prefix = index !== undefined ? `Rule ${index + 1}` : 'Rule';

  // Pattern is required
  if (typeof obj.pattern !== 'string' || !obj.pattern.trim()) {
    warnings.push(`${prefix}: missing required 'pattern' field, skipped`);
    return null;
  }

  // Name defaults to pattern if not provided
  const name = typeof obj.name === 'string' && obj.name.trim()
    ? obj.name.trim()
    : obj.pattern.substring(0, 50);

  // Validate is_regex pattern if enabled
  const isRegex = Boolean(obj.is_regex);
  if (isRegex) {
    try {
      new RegExp(obj.pattern);
    } catch {
      warnings.push(`${prefix}: invalid regex pattern '${obj.pattern}', importing as literal`);
      return {
        name,
        pattern: obj.pattern,
        is_regex: false,
        case_sensitive: Boolean(obj.case_sensitive),
        whole_word: Boolean(obj.whole_word),
        foreground: parseColor(obj.foreground) || '#00d4aa',
        background: parseColor(obj.background),
        bold: Boolean(obj.bold),
        italic: Boolean(obj.italic),
        underline: Boolean(obj.underline),
        category: parseCategory(obj.category),
        priority: parseNumber(obj.priority, 100),
        enabled: true,
        session_id: null,
      };
    }
  }

  return {
    name,
    pattern: obj.pattern,
    is_regex: isRegex,
    case_sensitive: Boolean(obj.case_sensitive),
    whole_word: Boolean(obj.whole_word),
    foreground: parseColor(obj.foreground) || '#00d4aa',
    background: parseColor(obj.background),
    bold: Boolean(obj.bold),
    italic: Boolean(obj.italic),
    underline: Boolean(obj.underline),
    category: parseCategory(obj.category),
    priority: parseNumber(obj.priority, 100),
    enabled: true,
    session_id: null,
  };
}

/**
 * Parse and validate a color value
 */
function parseColor(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;

  // Accept hex colors
  if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
    return value;
  }

  // Accept 3-digit hex
  if (/^#[0-9A-Fa-f]{3}$/.test(value)) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  // Try to parse named colors or other formats
  // For now, just return null for invalid colors
  return null;
}

/**
 * Parse and validate a category value
 */
function parseCategory(value: unknown): string {
  const validCategories = ['Network', 'Status', 'Security', 'Custom'];
  if (typeof value === 'string' && validCategories.includes(value)) {
    return value;
  }
  return 'Custom';
}

/**
 * Parse a number with default fallback
 */
function parseNumber(value: unknown, defaultValue: number): number {
  if (typeof value === 'number' && !isNaN(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

/**
 * Download rules as JSON file
 *
 * @param rules - Rules to export
 * @param filename - Filename for download (without extension)
 */
export function downloadRulesAsJson(rules: HighlightRule[], filename: string = 'highlight-rules'): void {
  const json = exportRulesToJson(rules);
  downloadFile(json, `${filename}.json`, 'application/json');
}

/**
 * Read and parse a JSON file
 *
 * @param file - File object from file input
 * @returns Parsed rules and warnings
 */
export async function readRulesFromFile(file: File): Promise<RuleImportResult> {
  const content = await file.text();
  return parseRulesFromJson(content);
}

/**
 * Validate that content looks like a valid rules JSON file
 */
export function isValidRulesJson(content: string): boolean {
  try {
    const parsed = JSON.parse(content);

    // Check for array format
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.some((item) => typeof item === 'object' && item !== null && 'pattern' in item);
    }

    // Check for object format
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.rules)) {
        return obj.rules.some(
          (item: unknown) => typeof item === 'object' && item !== null && 'pattern' in item
        );
      }
      // Single rule
      return 'pattern' in obj;
    }

    return false;
  } catch {
    return false;
  }
}
