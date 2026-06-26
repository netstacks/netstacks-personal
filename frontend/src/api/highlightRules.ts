// API client for highlight rules (smart keyword highlighting)
// In enterprise mode, rules are stored in localStorage (no sidecar API).
// In standalone mode, rules are stored via the sidecar backend API.

import { getClient } from './client';
import { getCurrentMode } from './client';

/**
 * Highlight rule for keyword highlighting in terminal output
 */
export interface HighlightRule {
  id: string;
  /** User-friendly name for the rule */
  name: string;
  /** Pattern to match (regex or literal string) */
  pattern: string;
  /** True if pattern is regex, false if literal */
  is_regex: boolean;
  /** Whether pattern matching is case sensitive */
  case_sensitive: boolean;
  /** Whether to match whole words only */
  whole_word: boolean;
  /** Foreground color as hex (#RRGGBB) */
  foreground: string | null;
  /** Background color as hex (#RRGGBB) */
  background: string | null;
  /** Bold text style */
  bold: boolean;
  /** Italic text style */
  italic: boolean;
  /** Underline text style */
  underline: boolean;
  /** Category for organization (Network, Status, Security, Custom) */
  category: string;
  /** Priority for rule ordering (lower = higher priority) */
  priority: number;
  /** Whether the rule is enabled */
  enabled: boolean;
  /** Session ID for session-specific rules (null = global rule) */
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Request to create a new highlight rule
 */
export interface NewHighlightRule {
  name: string;
  pattern: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  foreground?: string | null;
  background?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  category?: string;
  priority?: number;
  enabled?: boolean;
  /** Session ID for session-specific rules (null = global rule) */
  session_id?: string | null;
}

/**
 * Request to update a highlight rule (all fields optional for partial updates)
 */
export interface UpdateHighlightRule {
  name?: string;
  pattern?: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  foreground?: string | null;
  background?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  category?: string;
  priority?: number;
  enabled?: boolean;
  session_id?: string | null;
}

// =============================================================================
// localStorage backend for enterprise mode
// =============================================================================

const STORAGE_KEY = 'netstacks-highlight-rules';

function isEnterpriseMode(): boolean {
  return getCurrentMode() === 'enterprise';
}

function loadLocalRules(): HighlightRule[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveLocalRules(rules: HighlightRule[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// =============================================================================
// Public API — delegates to localStorage or sidecar depending on mode
// =============================================================================

/**
 * List all highlight rules, optionally filtered by session ID
 */
export async function listHighlightRules(sessionId?: string): Promise<HighlightRule[]> {
  if (isEnterpriseMode()) {
    let rules = loadLocalRules();
    if (sessionId) {
      rules = rules.filter(r => r.session_id === sessionId || r.session_id === null);
    }
    return rules;
  }

  const { data } = await getClient().http.get('/highlight-rules', {
    params: sessionId ? { session_id: sessionId } : undefined,
  });
  return data;
}

/**
 * Get a single highlight rule by ID
 */
export async function getHighlightRule(id: string): Promise<HighlightRule> {
  if (isEnterpriseMode()) {
    const rule = loadLocalRules().find(r => r.id === id);
    if (!rule) throw new Error('Highlight rule not found');
    return rule;
  }

  const { data } = await getClient().http.get(`/highlight-rules/${id}`);
  return data;
}

/**
 * Create a new highlight rule
 */
export async function createHighlightRule(rule: NewHighlightRule): Promise<HighlightRule> {
  if (isEnterpriseMode()) {
    const now = new Date().toISOString();
    const newRule: HighlightRule = {
      id: generateId(),
      name: rule.name,
      pattern: rule.pattern,
      is_regex: rule.is_regex ?? false,
      case_sensitive: rule.case_sensitive ?? false,
      whole_word: rule.whole_word ?? false,
      foreground: rule.foreground ?? null,
      background: rule.background ?? null,
      bold: rule.bold ?? false,
      italic: rule.italic ?? false,
      underline: rule.underline ?? false,
      category: rule.category ?? 'Custom',
      priority: rule.priority ?? 100,
      enabled: rule.enabled ?? true,
      session_id: rule.session_id ?? null,
      created_at: now,
      updated_at: now,
    };
    const rules = loadLocalRules();
    rules.push(newRule);
    saveLocalRules(rules);
    return newRule;
  }

  const { data } = await getClient().http.post('/highlight-rules', rule);
  return data;
}

/**
 * Update an existing highlight rule
 */
export async function updateHighlightRule(id: string, update: UpdateHighlightRule): Promise<HighlightRule> {
  if (isEnterpriseMode()) {
    const rules = loadLocalRules();
    const idx = rules.findIndex(r => r.id === id);
    if (idx === -1) throw new Error('Highlight rule not found');
    rules[idx] = { ...rules[idx], ...update, updated_at: new Date().toISOString() };
    saveLocalRules(rules);
    return rules[idx];
  }

  const { data } = await getClient().http.put(`/highlight-rules/${id}`, update);
  return data;
}

/**
 * Delete a highlight rule
 */
export async function deleteHighlightRule(id: string): Promise<void> {
  if (isEnterpriseMode()) {
    const rules = loadLocalRules().filter(r => r.id !== id);
    saveLocalRules(rules);
    return;
  }

  await getClient().http.delete(`/highlight-rules/${id}`);
}

/**
 * Get effective highlight rules for a session (merged global + session-specific)
 * Session-specific rules override global rules with the same name
 * Rules are sorted by priority (lower = higher priority)
 */
export async function getEffectiveHighlightRules(sessionId: string): Promise<HighlightRule[]> {
  if (isEnterpriseMode()) {
    const rules = loadLocalRules();
    const global = rules.filter(r => r.session_id === null);
    const session = rules.filter(r => r.session_id === sessionId);
    // Session rules override global rules with the same name
    const sessionNames = new Set(session.map(r => r.name));
    const merged = [...global.filter(r => !sessionNames.has(r.name)), ...session];
    return merged.sort((a, b) => a.priority - b.priority);
  }

  const { data } = await getClient().http.get(`/sessions/${sessionId}/highlight-rules/effective`);
  return data;
}
