import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  listHighlightRules,
  createHighlightRule,
  updateHighlightRule,
  deleteHighlightRule,
  type HighlightRule,
  type NewHighlightRule,
  type UpdateHighlightRule,
} from '../api/highlightRules';
import { presetLibraries, type PresetLibrary } from '../data/highlightPresets';
import { parseWordsIni, isValidWordsIniContent, type ParseWordsIniResult } from '../lib/parseWordsIni';
import {
  downloadRulesAsJson,
  parseRulesFromJson,
  isValidRulesJson,
  type RuleImportResult,
} from '../lib/ruleExport';
import ColorPicker from './ColorPicker';
import AITabInput from './AITabInput';
import Switch from './Switch';
import { useSettings } from '../hooks/useSettings';
import './SettingsHighlighting.css';
import SearchField from './SearchField';
import SettingsSection from './settings/SettingsSection';
import SettingRow from './settings/SettingRow';

// Category options
import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import ModalFrame from './ModalFrame';
const CATEGORIES = ['Network', 'Status', 'Security', 'Custom'];

// Icons
const Icons = {
  chevron: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
      <polyline points="5 3 10 8 5 13" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

interface SettingsHighlightingProps {
  /** Optional session ID to filter rules for a specific session */
  sessionId?: string | null;
}

// Default values for new rule
const DEFAULT_RULE: Omit<NewHighlightRule, 'name' | 'pattern'> = {
  is_regex: false,
  case_sensitive: false,
  whole_word: false,
  foreground: '#00d4aa',
  background: null,
  bold: false,
  italic: false,
  underline: false,
  category: 'Custom',
  priority: 100,
  enabled: true,
  session_id: null,
};

export default function SettingsHighlighting({ sessionId }: SettingsHighlightingProps) {
  // App settings for detection highlighting toggle
  const { settings: appSettings, updateSetting } = useSettings();

  const [rules, setRules] = useState<HighlightRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Editor state
  const [selectedRule, setSelectedRule] = useState<HighlightRule | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [editedRule, setEditedRule] = useState<Partial<HighlightRule>>({});
  const [saving, setSaving] = useState(false);
  const [testText, setTestText] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<HighlightRule | null>(null);

  // Import preset state
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<PresetLibrary | null>(null);
  const [selectedRuleIndices, setSelectedRuleIndices] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // File import state
  const [showFileImportDialog, setShowFileImportDialog] = useState(false);
  const [fileImportResult, setFileImportResult] = useState<ParseWordsIniResult | null>(null);
  const [fileImportSelectedIndices, setFileImportSelectedIndices] = useState<Set<number>>(new Set());
  const [fileImporting, setFileImporting] = useState(false);
  const [fileImportSuccess, setFileImportSuccess] = useState<string | null>(null);

  // JSON import state
  const [showJsonImportDialog, setShowJsonImportDialog] = useState(false);
  const [jsonImportResult, setJsonImportResult] = useState<RuleImportResult | null>(null);
  const [jsonImportSelectedIndices, setJsonImportSelectedIndices] = useState<Set<number>>(new Set());
  const [jsonImporting, setJsonImporting] = useState(false);
  const [jsonImportSuccess, setJsonImportSuccess] = useState<string | null>(null);

  // Load rules
  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    try {
      setLoading(true);
      const data = await listHighlightRules();
      setRules(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load highlight rules'));
    } finally {
      setLoading(false);
    }
  };

  // Filter and group rules
  const filteredRules = useMemo(() => {
    let result = rules;

    // Filter by search
    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(searchLower) ||
          r.pattern.toLowerCase().includes(searchLower)
      );
    }

    // Filter by category
    if (categoryFilter !== 'all') {
      result = result.filter((r) => r.category === categoryFilter);
    }

    // Filter by session if provided
    if (sessionId) {
      result = result.filter((r) => r.session_id === null || r.session_id === sessionId);
    }

    return result;
  }, [rules, search, categoryFilter, sessionId]);

  // Group rules by category
  const groupedRules = useMemo(() => {
    const groups: Record<string, HighlightRule[]> = {};
    for (const rule of filteredRules) {
      if (!groups[rule.category]) {
        groups[rule.category] = [];
      }
      groups[rule.category].push(rule);
    }
    // Sort rules within each category by priority
    for (const category of Object.keys(groups)) {
      groups[category].sort((a, b) => a.priority - b.priority);
    }
    return groups;
  }, [filteredRules]);

  // Toggle category collapse
  const toggleCategory = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Handle creating new rule
  const handleCreateNew = () => {
    setSelectedRule(null);
    setIsCreating(true);
    setEditedRule({
      ...DEFAULT_RULE,
      name: '',
      pattern: '',
      session_id: sessionId || null,
    });
    setTestText('');
  };

  // Handle selecting a rule
  const handleSelectRule = (rule: HighlightRule) => {
    setSelectedRule(rule);
    setIsCreating(false);
    setEditedRule({ ...rule });
    setTestText('');
  };

  // Handle field change
  const handleFieldChange = <K extends keyof HighlightRule>(
    field: K,
    value: HighlightRule[K]
  ) => {
    setEditedRule((prev) => ({ ...prev, [field]: value }));
  };

  // Handle save
  const handleSave = async () => {
    if (!editedRule.name?.trim() || !editedRule.pattern?.trim()) {
      setError('Name and pattern are required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isCreating) {
        const newRule: NewHighlightRule = {
          name: editedRule.name!.trim(),
          pattern: editedRule.pattern!.trim(),
          is_regex: editedRule.is_regex,
          case_sensitive: editedRule.case_sensitive,
          whole_word: editedRule.whole_word,
          foreground: editedRule.foreground,
          background: editedRule.background,
          bold: editedRule.bold,
          italic: editedRule.italic,
          underline: editedRule.underline,
          category: editedRule.category,
          priority: editedRule.priority,
          enabled: editedRule.enabled,
          session_id: editedRule.session_id,
        };
        const created = await createHighlightRule(newRule);
        setRules([...rules, created]);
        setSelectedRule(created);
        setIsCreating(false);
        setEditedRule({ ...created });
      } else if (selectedRule) {
        const update: UpdateHighlightRule = {
          name: editedRule.name?.trim(),
          pattern: editedRule.pattern?.trim(),
          is_regex: editedRule.is_regex,
          case_sensitive: editedRule.case_sensitive,
          whole_word: editedRule.whole_word,
          foreground: editedRule.foreground,
          background: editedRule.background,
          bold: editedRule.bold,
          italic: editedRule.italic,
          underline: editedRule.underline,
          category: editedRule.category,
          priority: editedRule.priority,
          enabled: editedRule.enabled,
          session_id: editedRule.session_id,
        };
        const updated = await updateHighlightRule(selectedRule.id, update);
        setRules(rules.map((r) => (r.id === updated.id ? updated : r)));
        setSelectedRule(updated);
        setEditedRule({ ...updated });
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save rule'));
    } finally {
      setSaving(false);
    }
  };

  // Handle cancel
  const handleCancel = () => {
    if (isCreating) {
      setIsCreating(false);
      setEditedRule({});
    } else if (selectedRule) {
      setEditedRule({ ...selectedRule });
    }
    setError(null);
  };

  // Handle delete
  const handleDelete = async () => {
    if (!deleteConfirm) return;

    try {
      await deleteHighlightRule(deleteConfirm.id);
      setRules(rules.filter((r) => r.id !== deleteConfirm.id));
      if (selectedRule?.id === deleteConfirm.id) {
        setSelectedRule(null);
        setEditedRule({});
      }
      setDeleteConfirm(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete rule'));
    }
  };

  // Handle opening import dialog
  const handleOpenImport = () => {
    setShowImportDialog(true);
    setSelectedPreset(null);
    setSelectedRuleIndices(new Set());
    setImportSuccess(null);
    setError(null);
  };

  // Handle selecting a preset
  const handleSelectPreset = (preset: PresetLibrary) => {
    setSelectedPreset(preset);
    // Select all rules by default
    setSelectedRuleIndices(new Set(preset.rules.map((_, i) => i)));
    setImportSuccess(null);
  };

  // Toggle rule selection
  const toggleRuleSelection = (index: number) => {
    setSelectedRuleIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Select/deselect all rules
  const toggleSelectAll = () => {
    if (!selectedPreset) return;
    if (selectedRuleIndices.size === selectedPreset.rules.length) {
      setSelectedRuleIndices(new Set());
    } else {
      setSelectedRuleIndices(new Set(selectedPreset.rules.map((_, i) => i)));
    }
  };

  // Check if a rule already exists (by pattern)
  const checkDuplicate = (pattern: string): boolean => {
    return rules.some((r) => r.pattern === pattern);
  };

  // Handle import
  const handleImport = async () => {
    if (!selectedPreset || selectedRuleIndices.size === 0) return;

    setImporting(true);
    setError(null);

    try {
      const rulesToImport = selectedPreset.rules.filter((_, i) => selectedRuleIndices.has(i));
      const created: HighlightRule[] = [];
      const skipped: string[] = [];

      for (const rule of rulesToImport) {
        // Check for duplicates
        if (checkDuplicate(rule.pattern)) {
          skipped.push(rule.name);
          continue;
        }

        const newRule = await createHighlightRule({
          ...rule,
          session_id: sessionId || null,
        });
        created.push(newRule);
      }

      // Update rules list
      setRules([...rules, ...created]);

      // Show success message
      let message = `Imported ${created.length} rule${created.length !== 1 ? 's' : ''}`;
      if (skipped.length > 0) {
        message += ` (${skipped.length} skipped as duplicates)`;
      }
      setImportSuccess(message);

      // Clear selection after successful import
      setSelectedRuleIndices(new Set());
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to import rules'));
    } finally {
      setImporting(false);
    }
  };

  // Close import dialog
  const handleCloseImport = () => {
    setShowImportDialog(false);
    setSelectedPreset(null);
    setSelectedRuleIndices(new Set());
    setImportSuccess(null);
  };

  // Handle file selection for import
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();

      if (!isValidWordsIniContent(content)) {
        setError('Invalid file format. Expected SecureCRT words.ini format.');
        return;
      }

      const result = parseWordsIni(content);
      setFileImportResult(result);
      setFileImportSelectedIndices(new Set(result.rules.map((_, i) => i)));
      setShowFileImportDialog(true);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to read file'));
    }

    // Reset file input
    event.target.value = '';
  };

  // Toggle file import rule selection
  const toggleFileImportRuleSelection = (index: number) => {
    setFileImportSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Select/deselect all file import rules
  const toggleFileImportSelectAll = () => {
    if (!fileImportResult) return;
    if (fileImportSelectedIndices.size === fileImportResult.rules.length) {
      setFileImportSelectedIndices(new Set());
    } else {
      setFileImportSelectedIndices(new Set(fileImportResult.rules.map((_, i) => i)));
    }
  };

  // Handle file import
  const handleFileImport = async () => {
    if (!fileImportResult || fileImportSelectedIndices.size === 0) return;

    setFileImporting(true);
    setError(null);

    try {
      const rulesToImport = fileImportResult.rules.filter((_, i) => fileImportSelectedIndices.has(i));
      const created: HighlightRule[] = [];
      const skipped: string[] = [];

      for (const rule of rulesToImport) {
        // Check for duplicates
        if (checkDuplicate(rule.pattern)) {
          skipped.push(rule.name);
          continue;
        }

        const newRule = await createHighlightRule({
          ...rule,
          session_id: sessionId || null,
        });
        created.push(newRule);
      }

      // Update rules list
      setRules([...rules, ...created]);

      // Show success message
      let message = `Imported ${created.length} rule${created.length !== 1 ? 's' : ''}`;
      if (skipped.length > 0) {
        message += ` (${skipped.length} skipped as duplicates)`;
      }
      setFileImportSuccess(message);

      // Clear selection after successful import
      setFileImportSelectedIndices(new Set());
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to import rules'));
    } finally {
      setFileImporting(false);
    }
  };

  // Close file import dialog
  const handleCloseFileImport = () => {
    setShowFileImportDialog(false);
    setFileImportResult(null);
    setFileImportSelectedIndices(new Set());
    setFileImportSuccess(null);
  };

  // Handle JSON file selection for import
  const handleJsonFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();

      if (!isValidRulesJson(content)) {
        setError('Invalid JSON format. Expected array of rules or NetStacks export file.');
        return;
      }

      const result = parseRulesFromJson(content);
      setJsonImportResult(result);
      setJsonImportSelectedIndices(new Set(result.rules.map((_, i) => i)));
      setShowJsonImportDialog(true);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to read file'));
    }

    // Reset file input
    event.target.value = '';
  };

  // Toggle JSON import rule selection
  const toggleJsonImportRuleSelection = (index: number) => {
    setJsonImportSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Select/deselect all JSON import rules
  const toggleJsonImportSelectAll = () => {
    if (!jsonImportResult) return;
    if (jsonImportSelectedIndices.size === jsonImportResult.rules.length) {
      setJsonImportSelectedIndices(new Set());
    } else {
      setJsonImportSelectedIndices(new Set(jsonImportResult.rules.map((_, i) => i)));
    }
  };

  // Handle JSON import
  const handleJsonImport = async () => {
    if (!jsonImportResult || jsonImportSelectedIndices.size === 0) return;

    setJsonImporting(true);
    setError(null);

    try {
      const rulesToImport = jsonImportResult.rules.filter((_, i) => jsonImportSelectedIndices.has(i));
      const created: HighlightRule[] = [];
      const skipped: string[] = [];

      for (const rule of rulesToImport) {
        // Check for duplicates
        if (checkDuplicate(rule.pattern)) {
          skipped.push(rule.name);
          continue;
        }

        const newRule = await createHighlightRule({
          ...rule,
          session_id: sessionId || null,
        });
        created.push(newRule);
      }

      // Update rules list
      setRules([...rules, ...created]);

      // Show success message
      let message = `Imported ${created.length} rule${created.length !== 1 ? 's' : ''}`;
      if (skipped.length > 0) {
        message += ` (${skipped.length} skipped as duplicates)`;
      }
      setJsonImportSuccess(message);

      // Clear selection after successful import
      setJsonImportSelectedIndices(new Set());
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to import rules'));
    } finally {
      setJsonImporting(false);
    }
  };

  // Close JSON import dialog
  const handleCloseJsonImport = () => {
    setShowJsonImportDialog(false);
    setJsonImportResult(null);
    setJsonImportSelectedIndices(new Set());
    setJsonImportSuccess(null);
  };

  // Handle export - export all or selected rules as JSON
  const handleExport = () => {
    // Get global rules (not session-specific) for export
    const globalRules = rules.filter(r => r.session_id === null);
    if (globalRules.length === 0) {
      setError('No rules to export');
      return;
    }

    const timestamp = new Date().toISOString().split('T')[0];
    downloadRulesAsJson(globalRules, `netstacks-highlight-rules-${timestamp}`);
  };

  // Test pattern matching
  const getTestResult = useCallback(() => {
    if (!testText || !editedRule.pattern) return { html: testText, error: null };

    try {
      let pattern = editedRule.pattern;

      if (!editedRule.is_regex) {
        // Escape regex special characters for literal match
        pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      if (editedRule.whole_word) {
        pattern = `\\b${pattern}\\b`;
      }

      const flags = editedRule.case_sensitive ? 'g' : 'gi';
      const regex = new RegExp(pattern, flags);

      // Build style for highlighted text
      const style: string[] = [];
      if (editedRule.foreground) {
        style.push(`color: ${editedRule.foreground}`);
      }
      if (editedRule.background) {
        style.push(`background-color: ${editedRule.background}`);
      }
      if (editedRule.bold) {
        style.push('font-weight: bold');
      }
      if (editedRule.italic) {
        style.push('font-style: italic');
      }
      if (editedRule.underline) {
        style.push('text-decoration: underline');
      }
      const styleStr = style.join('; ');

      // Walk the test text, emitting escaped chunks between matches and
      // styled spans for matches. Previous version used .replace() which
      // only escaped the matched text — the surrounding testText was
      // concatenated raw into the html string, allowing self-XSS if the
      // user typed e.g. `<script>` into their own test box.
      let html = '';
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(testText)) !== null) {
        html += escapeHtml(testText.slice(lastIndex, m.index));
        html += `<span class="highlight" style="${styleStr}">${escapeHtml(m[0])}</span>`;
        lastIndex = m.index + m[0].length;
        // Zero-width matches would loop forever; advance lastIndex manually.
        if (m[0].length === 0) regex.lastIndex++;
      }
      html += escapeHtml(testText.slice(lastIndex));

      return { html, error: null };
    } catch (err) {
      return { html: testText, error: getErrorMessage(err, 'Invalid pattern') };
    }
  }, [testText, editedRule]);

  const testResult = getTestResult();

  if (loading) {
    return (
      <p className="form-hint">Loading highlight rules…</p>
    );
  }

  const isEditorActive = selectedRule || isCreating;
  const hasChanges =
    isCreating ||
    (selectedRule &&
      JSON.stringify(editedRule) !== JSON.stringify(selectedRule));

  return (
    <>
      <SettingsSection title="Detection & Safety">
        <div className="settings-group">
          <SettingRow
            label="Highlight detected network identifiers"
            description="Underline IP addresses, MAC addresses, hostnames, and ASNs in terminal output. Right-click highlighted items for lookup options."
          >
            <Switch
              checked={appSettings['detection.highlighting']}
              onChange={(checked) => updateSetting('detection.highlighting', checked)}
              label="Highlight detected network identifiers"
            />
          </SettingRow>
          <SettingRow
            label="Warn on dangerous commands"
            description="Show a warning while typing commands like reload, wr erase or shutdown; Enter opens a confirmation with safe alternatives."
          >
            <Switch
              checked={appSettings['commandSafety.enabled']}
              onChange={(checked) => updateSetting('commandSafety.enabled', checked)}
              label="Warn on dangerous commands"
            />
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Highlight Rules"
        description="Highlight keywords, patterns and regular expressions in terminal output, globally or per session."
        help={{
          topic: 'highlight rules',
          prompt: `Help me with terminal highlight rules in NetStacks. I have ${rules.length} rule(s)`
            + (rules.length ? ` in ${new Set(rules.map(r => r.category)).size} categor${new Set(rules.map(r => r.category)).size === 1 ? 'y' : 'ies'}` : '')
            + '. Explain literal vs regex patterns, case-sensitive and whole-word matching, priority, global vs session-specific rules, and importing presets, a SecureCRT words.ini or JSON. Suggest useful rules for network output (interface down, CRC errors, BGP state changes).',
        }}
        actions={
          <button className="ns-btn ns-btn--small" onClick={handleCreateNew}>+ Add rule</button>
        }
      >
      {error && <p className="settings-error">{error}</p>}

      <div className="highlighting-toolbar">
        <SearchField className="highlighting-search" value={search} onChange={setSearch} placeholder="Search rules..." />
        <select aria-label="Filter by category"
          className="ns-select"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="all">All Categories</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        <span className="highlighting-toolbar-actions">
          <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={handleOpenImport}>Import Preset</button>
          <label className="ns-btn ns-btn--small ns-btn--ghost">
            INI File
            <input type="file" accept=".ini,.txt" onChange={handleFileSelect} className="highlighting-file-input" />
          </label>
          <label className="ns-btn ns-btn--small ns-btn--ghost">
            JSON File
            <input type="file" accept=".json" onChange={handleJsonFileSelect} className="highlighting-file-input" />
          </label>
          <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={handleExport}>Export</button>
        </span>
      </div>

      <div className="highlighting-content">
        {/* Rules list */}
        <div className="rules-list-container">
          <div className="rules-list">
            {Object.keys(groupedRules).length === 0 ? (
              <p className="form-hint rules-list-empty">No highlight rules yet. Create one to highlight keywords in terminal output.</p>
            ) : (
              Object.entries(groupedRules).map(([category, categoryRules]) => (
                <div key={category} className="rules-category-group">
                  <div
                    className="rules-category-header"
                    onClick={() => toggleCategory(category)}
                  >
                    <span className="rules-category-title">
                      <span
                        className={`rules-category-chevron ${
                          collapsedCategories.has(category) ? 'collapsed' : ''
                        }`}
                      >
                        {Icons.chevron}
                      </span>
                      {category}
                    </span>
                    <span className="rules-category-count">{categoryRules.length}</span>
                  </div>
                  <div
                    className={`rules-category-items ${
                      collapsedCategories.has(category) ? 'collapsed' : ''
                    }`}
                  >
                    {categoryRules.map((rule) => (
                      <div
                        key={rule.id}
                        className={`rule-item ${
                          selectedRule?.id === rule.id ? 'selected' : ''
                        } ${!rule.enabled ? 'disabled' : ''}`}
                        onClick={() => handleSelectRule(rule)}
                      >
                        <div
                          className="rule-color-swatch"
                          style={{
                            backgroundColor: rule.background || rule.foreground || '#666',
                          }}
                        />
                        <div className="rule-info">
                          <span className="rule-name">{rule.name}</span>
                          <span className="rule-pattern">{rule.pattern}</span>
                        </div>
                        <div className="rule-badges">
                          {rule.session_id ? (
                            <span className="settings-badge settings-badge--success">Session</span>
                          ) : (
                            <span className="settings-badge settings-badge--accent">Global</span>
                          )}
                          {rule.is_regex && (
                            <span className="settings-badge settings-badge--warning">Regex</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Rule editor */}
        <div className="rule-editor-container">
          {!isEditorActive ? (
            <div className="rule-editor-empty">
              <p>Select a rule to edit</p>
              <p>or create a new one</p>
            </div>
          ) : (
            <div className="rule-editor">
              <div className="rule-editor-header">
                <span className="rule-editor-title">
                  {isCreating ? 'New Rule' : `Edit: ${selectedRule?.name}`}
                </span>
                <div className="rule-editor-actions">
                  {!isCreating && selectedRule && (
                    <button
                      className="ns-btn ns-btn--danger"
                      onClick={() => setDeleteConfirm(selectedRule)}
                    >
                      Delete
                    </button>
                  )}
                  <button className="ns-btn" onClick={handleCancel}>
                    Cancel
                  </button>
                  <button
                    className="ns-btn ns-btn--primary"
                    onClick={handleSave}
                    disabled={saving || !hasChanges}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>

              <div className="rule-editor-content">
                {/* Name */}
                <div className="rule-form-group">
                  <label className="rule-form-label">Name</label>
                  <AITabInput
                    type="text"
                    className="rule-form-input"
                    value={editedRule.name || ''}
                    onChange={(e) => handleFieldChange('name', e.target.value)}
                    placeholder="Rule name"
                    aiField="highlight_rule_name"
                    aiPlaceholder="Name for this highlight rule"
                    aiContext={{ pattern: editedRule.pattern, category: editedRule.category }}
                    onAIValue={(v) => handleFieldChange('name', v)}
                  />
                </div>

                {/* Pattern */}
                <div className="rule-form-group">
                  <label className="rule-form-label">Pattern</label>
                  <AITabInput
                    aria-label="Pattern"
                    className="rule-form-input settings-code"
                    value={editedRule.pattern || ''}
                    onChange={(e) => handleFieldChange('pattern', e.target.value)}
                    placeholder={editedRule.is_regex ? 'e.g., error|warning|fail' : 'e.g., ERROR'}
                    aiField="highlight pattern"
                    aiPlaceholder={editedRule.is_regex ? 'Regex matching the terminal output this rule should highlight' : 'Literal text this rule should highlight in terminal output'}
                    aiContext={{ ruleName: editedRule.name, category: editedRule.category, regex: editedRule.is_regex }}
                    onAIValue={(v) => handleFieldChange('pattern', v)}
                  />
                  <div className="pattern-type-toggle ns-segmented">
                    <button
                      type="button"
                      className={`ns-segment ${!editedRule.is_regex ? 'active' : ''}`}
                      onClick={() => handleFieldChange('is_regex', false)}
                    >
                      Literal
                    </button>
                    <button
                      type="button"
                      className={`ns-segment ${editedRule.is_regex ? 'active' : ''}`}
                      onClick={() => handleFieldChange('is_regex', true)}
                    >
                      Regex
                    </button>
                  </div>
                </div>

                {/* Matching options */}
                <div className="rule-form-group">
                  <label className="rule-form-label">Matching Options</label>
                  <div className="rule-form-checkboxes">
                    <label className="rule-form-checkbox">
                      <input
                        type="checkbox"
                        checked={editedRule.case_sensitive || false}
                        onChange={(e) =>
                          handleFieldChange('case_sensitive', e.target.checked)
                        }
                      />
                      <span>Case Sensitive</span>
                    </label>
                    <label className="rule-form-checkbox">
                      <input
                        type="checkbox"
                        checked={editedRule.whole_word || false}
                        onChange={(e) =>
                          handleFieldChange('whole_word', e.target.checked)
                        }
                      />
                      <span>Whole Word</span>
                    </label>
                  </div>
                </div>

                {/* Colors */}
                <div className="rule-form-group">
                  <label className="rule-form-label">Colors</label>
                  <div className="rule-colors-section">
                    <div className="rule-colors-row">
                      <ColorPicker
                        label="FG"
                        value={editedRule.foreground || null}
                        onChange={(color) => handleFieldChange('foreground', color)}
                        allowNone
                      />
                      <ColorPicker
                        label="BG"
                        value={editedRule.background || null}
                        onChange={(color) => handleFieldChange('background', color)}
                        allowNone
                      />
                    </div>
                  </div>
                </div>

                {/* Text styles */}
                <div className="rule-form-group">
                  <label className="rule-form-label">Text Style</label>
                  <div className="rule-form-checkboxes">
                    <label className="rule-form-checkbox">
                      <input
                        type="checkbox"
                        checked={editedRule.bold || false}
                        onChange={(e) => handleFieldChange('bold', e.target.checked)}
                      />
                      <span style={{ fontWeight: 'bold' }}>Bold</span>
                    </label>
                    <label className="rule-form-checkbox">
                      <input
                        type="checkbox"
                        checked={editedRule.italic || false}
                        onChange={(e) => handleFieldChange('italic', e.target.checked)}
                      />
                      <span style={{ fontStyle: 'italic' }}>Italic</span>
                    </label>
                    <label className="rule-form-checkbox">
                      <input
                        type="checkbox"
                        checked={editedRule.underline || false}
                        onChange={(e) =>
                          handleFieldChange('underline', e.target.checked)
                        }
                      />
                      <span style={{ textDecoration: 'underline' }}>Underline</span>
                    </label>
                  </div>
                </div>

                {/* Category and priority */}
                <div className="rule-form-group">
                  <div className="rule-form-row">
                    <div>
                      <label className="rule-form-label">Category</label>
                      <select aria-label="Category"
                        className="ns-select"
                        value={editedRule.category || 'Custom'}
                        onChange={(e) => handleFieldChange('category', e.target.value)}
                      >
                        {CATEGORIES.map((cat) => (
                          <option key={cat} value={cat}>
                            {cat}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="rule-form-label">Priority</label>
                      <input aria-label="Priority"
                        type="number"
                        className="ns-input rule-form-input-number"
                        value={editedRule.priority ?? 100}
                        onChange={(e) =>
                          handleFieldChange('priority', parseInt(e.target.value) || 100)
                        }
                        min={1}
                        max={1000}
                      />
                    </div>
                  </div>
                </div>

                {/* Scope */}
                <div className="rule-form-group">
                  <label className="rule-form-label">Scope</label>
                  <div className="rule-form-checkboxes">
                    <label className="rule-form-checkbox">
                      <input
                        type="radio"
                        name="scope"
                        checked={!editedRule.session_id}
                        onChange={() => handleFieldChange('session_id', null)}
                      />
                      <span>Global (all sessions)</span>
                    </label>
                    {sessionId && (
                      <label className="rule-form-checkbox">
                        <input
                          type="radio"
                          name="scope"
                          checked={editedRule.session_id === sessionId}
                          onChange={() => handleFieldChange('session_id', sessionId)}
                        />
                        <span>This session only</span>
                      </label>
                    )}
                  </div>
                </div>

                {/* Enabled toggle */}
                <div className="rule-form-group">
                  <label className="rule-form-checkbox">
                    <input
                      type="checkbox"
                      checked={editedRule.enabled !== false}
                      onChange={(e) => handleFieldChange('enabled', e.target.checked)}
                    />
                    <span>Enabled</span>
                  </label>
                </div>

                {/* Test area */}
                <div className="rule-test-section">
                  <label className="rule-form-label">Test Pattern</label>
                  <AITabInput
                    aria-label="Test text"
                    className="rule-test-input"
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    placeholder="Enter text to test the pattern..."
                    aiField="sample terminal output"
                    aiPlaceholder="One realistic line of device output this highlight pattern should match"
                    aiContext={{ pattern: editedRule.pattern, regex: editedRule.is_regex, ruleName: editedRule.name }}
                    onAIValue={setTestText}
                  />
                  {testText && (
                    <>
                      <div
                        className="rule-test-result"
                        dangerouslySetInnerHTML={{ __html: testResult.html }}
                      />
                      {testResult.error && (
                        <div className="rule-test-error">{testResult.error}</div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </SettingsSection>

      {/* Delete confirmation */}
      {deleteConfirm && (
        <ModalFrame id="highlight-rule-delete" resizable={false} className="delete-confirm-dialog" label="Delete rule">
          <h3>Delete Rule</h3>
          <p>
            Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
          </p>
          <DialogFooter
            primary={{ label: 'Delete', onClick: handleDelete, danger: true }}
            onCancel={() => setDeleteConfirm(null)}
            inline
          />
        </ModalFrame>
      )}

      {/* Import preset dialog */}
      {showImportDialog && (
        <ModalFrame id="highlight-import" onDismiss={handleCloseImport} className="import-dialog" label="Import highlight rules">
          <div className="import-dialog-header">
            <h3>Import Preset Rules</h3>
            <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={handleCloseImport}>
              &times;
            </button>
          </div>

          <div className="import-dialog-content">
            {/* Preset list */}
            <div className="preset-list">
              <div className="preset-list-header">Available Presets</div>
              {presetLibraries.map((preset) => (
                <div
                  key={preset.id}
                  className={`preset-item ${selectedPreset?.id === preset.id ? 'selected' : ''}`}
                  onClick={() => handleSelectPreset(preset)}
                >
                  <div className="preset-item-name">{preset.name}</div>
                  <div className="preset-item-desc">{preset.description}</div>
                  <div className="preset-item-count">{preset.rules.length} rules</div>
                </div>
              ))}
            </div>

            {/* Selected preset rules */}
            <div className="preset-rules">
              {selectedPreset ? (
                <>
                  <div className="preset-rules-header">
                    <span>{selectedPreset.name} Rules</span>
                    <label className="preset-select-all">
                      <input
                        type="checkbox"
                        checked={selectedRuleIndices.size === selectedPreset.rules.length}
                        onChange={toggleSelectAll}
                      />
                      <span>Select All</span>
                    </label>
                  </div>
                  <div className="preset-rules-list">
                    {selectedPreset.rules.map((rule, index) => {
                      const isDuplicate = checkDuplicate(rule.pattern);
                      return (
                        <div
                          key={index}
                          className={`preset-rule-item ${isDuplicate ? 'duplicate' : ''}`}
                        >
                          <label className="preset-rule-checkbox">
                            <input
                              type="checkbox"
                              checked={selectedRuleIndices.has(index)}
                              onChange={() => toggleRuleSelection(index)}
                              disabled={isDuplicate}
                            />
                          </label>
                          <div
                            className="preset-rule-swatch"
                            style={{
                              backgroundColor: rule.background || rule.foreground || '#666',
                            }}
                          />
                          <div className="preset-rule-info">
                            <span className="preset-rule-name">{rule.name}</span>
                            <span className="preset-rule-pattern">{rule.pattern}</span>
                          </div>
                          {isDuplicate && (
                            <span className="preset-rule-duplicate">Already exists</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="preset-rules-empty">
                  <p>Select a preset to view its rules</p>
                </div>
              )}
            </div>
          </div>

          {importSuccess && (
            <div className="import-success">
              {Icons.check}
              <span>{importSuccess}</span>
            </div>
          )}

          <DialogFooter
            primary={{ label: importing ? 'Importing...' : `Import ${selectedRuleIndices.size} Rule${selectedRuleIndices.size !== 1 ? 's' : ''}`, onClick: handleImport, disabled: !selectedPreset || selectedRuleIndices.size === 0 || importing }}
            onCancel={handleCloseImport}
            cancelLabel="Close"
          />
        </ModalFrame>
      )}

      {/* File import dialog */}
      {showFileImportDialog && fileImportResult && (
        <ModalFrame id="highlight-import-securecrt" onDismiss={handleCloseFileImport} className="import-dialog" label="Import from SecureCRT">
          <div className="import-dialog-header">
            <h3>Import from SecureCRT words.ini</h3>
            <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={handleCloseFileImport}>
              &times;
            </button>
          </div>

          <div className="import-dialog-content">
            <div className="file-import-rules">
              <div className="preset-rules-header">
                <span>Parsed Rules ({fileImportResult.rules.length})</span>
                <label className="preset-select-all">
                  <input
                    type="checkbox"
                    checked={fileImportSelectedIndices.size === fileImportResult.rules.length}
                    onChange={toggleFileImportSelectAll}
                  />
                  <span>Select All</span>
                </label>
              </div>

              {fileImportResult.warnings.length > 0 && (
                <div className="file-import-warnings">
                  {Icons.warning}
                  <div>
                    {fileImportResult.warnings.map((warning, i) => (
                      <p key={i}>{warning}</p>
                    ))}
                  </div>
                </div>
              )}

              <div className="preset-rules-list">
                {fileImportResult.rules.map((rule, index) => {
                  const isDuplicate = checkDuplicate(rule.pattern);
                  return (
                    <div
                      key={index}
                      className={`preset-rule-item ${isDuplicate ? 'duplicate' : ''}`}
                    >
                      <label className="preset-rule-checkbox">
                        <input
                          type="checkbox"
                          checked={fileImportSelectedIndices.has(index)}
                          onChange={() => toggleFileImportRuleSelection(index)}
                          disabled={isDuplicate}
                        />
                      </label>
                      <div
                        className="preset-rule-swatch"
                        style={{
                          backgroundColor: rule.background || rule.foreground || '#666',
                        }}
                      />
                      <div className="preset-rule-info">
                        <span className="preset-rule-name">{rule.name}</span>
                        <span className="preset-rule-pattern">{rule.pattern}</span>
                      </div>
                      <span className="preset-rule-category">{rule.category}</span>
                      {isDuplicate && (
                        <span className="preset-rule-duplicate">Already exists</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {fileImportSuccess && (
            <div className="import-success">
              {Icons.check}
              <span>{fileImportSuccess}</span>
            </div>
          )}

          <DialogFooter
            primary={{ label: fileImporting ? 'Importing...' : `Import ${fileImportSelectedIndices.size} Rule${fileImportSelectedIndices.size !== 1 ? 's' : ''}`, onClick: handleFileImport, disabled: fileImportSelectedIndices.size === 0 || fileImporting }}
            onCancel={handleCloseFileImport}
            cancelLabel="Close"
          />
        </ModalFrame>
      )}

      {/* JSON import dialog */}
      {showJsonImportDialog && jsonImportResult && (
        <ModalFrame id="highlight-import-json" onDismiss={handleCloseJsonImport} className="import-dialog" label="Import from JSON">
          <div className="import-dialog-header">
            <h3>Import from JSON</h3>
            <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={handleCloseJsonImport}>
              &times;
            </button>
          </div>

          <div className="import-dialog-content">
            <div className="file-import-rules">
              <div className="preset-rules-header">
                <span>Parsed Rules ({jsonImportResult.rules.length})</span>
                <label className="preset-select-all">
                  <input
                    type="checkbox"
                    checked={jsonImportSelectedIndices.size === jsonImportResult.rules.length}
                    onChange={toggleJsonImportSelectAll}
                  />
                  <span>Select All</span>
                </label>
              </div>

              {jsonImportResult.warnings.length > 0 && (
                <div className="file-import-warnings">
                  {Icons.warning}
                  <div>
                    {jsonImportResult.warnings.map((warning, i) => (
                      <p key={i}>{warning}</p>
                    ))}
                  </div>
                </div>
              )}

              <div className="preset-rules-list">
                {jsonImportResult.rules.map((rule, index) => {
                  const isDuplicate = checkDuplicate(rule.pattern);
                  return (
                    <div
                      key={index}
                      className={`preset-rule-item ${isDuplicate ? 'duplicate' : ''}`}
                    >
                      <label className="preset-rule-checkbox">
                        <input
                          type="checkbox"
                          checked={jsonImportSelectedIndices.has(index)}
                          onChange={() => toggleJsonImportRuleSelection(index)}
                          disabled={isDuplicate}
                        />
                      </label>
                      <div
                        className="preset-rule-swatch"
                        style={{
                          backgroundColor: rule.background || rule.foreground || '#666',
                        }}
                      />
                      <div className="preset-rule-info">
                        <span className="preset-rule-name">{rule.name}</span>
                        <span className="preset-rule-pattern">{rule.pattern}</span>
                      </div>
                      <span className="preset-rule-category">{rule.category}</span>
                      {isDuplicate && (
                        <span className="preset-rule-duplicate">Already exists</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {jsonImportSuccess && (
            <div className="import-success">
              {Icons.check}
              <span>{jsonImportSuccess}</span>
            </div>
          )}

          <DialogFooter
            primary={{ label: jsonImporting ? 'Importing...' : `Import ${jsonImportSelectedIndices.size} Rule${jsonImportSelectedIndices.size !== 1 ? 's' : ''}`, onClick: handleJsonImport, disabled: jsonImportSelectedIndices.size === 0 || jsonImporting }}
            onCancel={handleCloseJsonImport}
            cancelLabel="Close"
          />
        </ModalFrame>
      )}
    </>
  );
}

// Helper to escape HTML for safe rendering
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
