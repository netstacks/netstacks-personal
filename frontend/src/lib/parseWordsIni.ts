// SecureCRT words.ini parser
// Converts SecureCRT keyword highlighting format to our highlight rules

import type { NewHighlightRule } from '../api/highlightRules';

/**
 * Parsed result from words.ini import
 */
export interface ParseWordsIniResult {
  rules: NewHighlightRule[];
  warnings: string[];
}

/**
 * Convert BGR hex color (SecureCRT format) to RGB hex color
 * SecureCRT uses BGR format: 00FF00 = Red (not Green)
 * We need to convert to RGB format: 00FF00 = Green
 */
function bgrToRgb(bgrHex: string): string {
  // Remove any leading zeros or padding to get just the hex
  const bgr = bgrHex.padStart(6, '0');

  // Extract BGR components
  const blue = bgr.substring(0, 2);
  const green = bgr.substring(2, 4);
  const red = bgr.substring(4, 6);

  // Return RGB format
  return `#${red}${green}${blue}`;
}

/**
 * Parse a single rule line from words.ini
 * Format: "pattern"=enabled,foreground(BGR),background(BGR)
 * Example: "Error"=1,0000FF,FFFFFF
 */
function parseRuleLine(line: string, category: string): { rule: NewHighlightRule | null; warning: string | null } {
  // Match pattern: "pattern"=enabled,fg,bg
  const match = line.match(/^"(.+)"=(\d+),([0-9A-Fa-f]+),([0-9A-Fa-f]+)$/);

  if (!match) {
    return { rule: null, warning: `Could not parse line: ${line}` };
  }

  const [, pattern, enabledStr, fgBgr, bgBgr] = match;
  const enabled = enabledStr === '1';

  // Convert colors from BGR to RGB
  const foreground = bgrToRgb(fgBgr);
  const background = bgrToRgb(bgBgr);

  // Check if background is black (000000) - treat as no background
  const hasBackground = background.toLowerCase() !== '#000000';

  // Determine if pattern is regex (SecureCRT uses simple regex patterns)
  // Patterns with special regex characters are likely regex
  const isRegex = /[.*+?^${}()|[\]\\]/.test(pattern);

  const rule: NewHighlightRule = {
    name: pattern.length > 30 ? pattern.substring(0, 30) + '...' : pattern,
    pattern: pattern,
    is_regex: isRegex,
    case_sensitive: true, // SecureCRT default
    whole_word: false,
    foreground: foreground,
    background: hasBackground ? background : null,
    bold: false,
    italic: false,
    underline: false,
    category: category || 'Custom',
    priority: 100,
    enabled: enabled,
  };

  return { rule, warning: null };
}

/**
 * Parse SecureCRT words.ini file content
 *
 * Format:
 * [SectionName]
 * "pattern"=enabled,foreground(BGR),background(BGR)
 * "pattern2"=enabled,foreground(BGR),background(BGR)
 *
 * [AnotherSection]
 * ...
 */
export function parseWordsIni(content: string): ParseWordsIniResult {
  const rules: NewHighlightRule[] = [];
  const warnings: string[] = [];

  let currentSection = 'Custom';
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }

    // Check for section header
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      // Map common section names to our categories
      const sectionLower = currentSection.toLowerCase();
      if (sectionLower.includes('network') || sectionLower.includes('ip')) {
        currentSection = 'Network';
      } else if (sectionLower.includes('status') || sectionLower.includes('state')) {
        currentSection = 'Status';
      } else if (sectionLower.includes('security') || sectionLower.includes('error') || sectionLower.includes('warn')) {
        currentSection = 'Security';
      } else {
        currentSection = 'Custom';
      }
      continue;
    }

    // Try to parse as a rule
    if (trimmed.startsWith('"')) {
      const { rule, warning } = parseRuleLine(trimmed, currentSection);
      if (rule) {
        rules.push(rule);
      }
      if (warning) {
        warnings.push(warning);
      }
    }
  }

  if (rules.length === 0 && lines.length > 0) {
    warnings.push('No valid rules found in the file. Make sure it follows SecureCRT words.ini format.');
  }

  return { rules, warnings };
}

/**
 * Validate that content looks like a words.ini file
 */
export function isValidWordsIniContent(content: string): boolean {
  // Check for at least one pattern line
  const hasPatternLine = /"[^"]+"\s*=\s*\d+,/.test(content);
  return hasPatternLine;
}
