import { useState } from 'react';
import { createUserPlugin, updatePlugin, testPluginCommand, type LspPluginListItem } from '../../lsp/installationApi';

interface Props {
  /** If provided, this is an EDIT operation; otherwise CREATE. */
  existing?: LspPluginListItem;
  onClose: () => void;
  onSaved: () => void;
}

export function AddCustomPluginDialog({ existing, onClose, onSaved }: Props) {
  const isEdit = !!existing;
  const isBuiltIn = existing?.source === 'built-in';

  const [id, setId] = useState(existing?.id ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [language, setLanguage] = useState(existing?.language ?? '');
  const [fileExtensions, setFileExtensions] = useState((existing?.fileExtensions ?? []).join(', '));
  const [command, setCommand] = useState(existing?.runtime.command ?? '');
  const [argsStr, setArgsStr] = useState((existing?.runtime.args ?? []).join(' '));

  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const [testMessage, setTestMessage] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    const argsArr = argsStr.trim().split(/\s+/).filter(Boolean);
    try {
      const result = await testPluginCommand(command.trim(), argsArr);
      if (result.success) {
        setTestStatus('pass');
        setTestMessage('LSP responded to initialize ✓');
      } else {
        setTestStatus('fail');
        setTestMessage(result.errorMessage ?? result.stderr ?? 'unknown error');
      }
    } catch (e) {
      setTestStatus('fail');
      setTestMessage((e as Error).message);
    }
  };

  const canSave =
    testStatus === 'pass' &&
    id.trim() &&
    displayName.trim() &&
    language.trim() &&
    fileExtensions.trim() &&
    command.trim();

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const argsArr = argsStr.trim().split(/\s+/).filter(Boolean);
    const fileExtArr = fileExtensions.split(',').map((s: string) => s.trim()).filter(Boolean);
    try {
      if (isEdit && isBuiltIn) {
        // Built-in: only override command and args
        await updatePlugin(existing!.id, { command: command.trim(), args: argsArr });
      } else if (isEdit) {
        await updatePlugin(existing!.id, {
          displayName: displayName.trim(),
          language: language.trim(),
          fileExtensions: fileExtArr,
          command: command.trim(),
          args: argsArr,
        });
      } else {
        await createUserPlugin({
          id: id.trim(),
          displayName: displayName.trim(),
          language: language.trim(),
          fileExtensions: fileExtArr,
          command: command.trim(),
          args: argsArr,
          envVars: {},
        });
      }
      onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lsp-dialog-overlay" onClick={onClose}>
      <div className="lsp-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? `Edit ${existing!.displayName}` : 'Add Language Server'}</h3>
        <div className="lsp-dialog__field">
          <label>Plugin ID</label>
          <input value={id} onChange={(e) => setId(e.target.value)} disabled={isEdit} placeholder="e.g. gopls" />
        </div>
        <div className="lsp-dialog__field">
          <label>Display Name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={isBuiltIn} placeholder="e.g. gopls" />
        </div>
        <div className="lsp-dialog__field">
          <label>Monaco Language ID</label>
          <input value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isBuiltIn} placeholder="e.g. go" />
        </div>
        <div className="lsp-dialog__field">
          <label>File Extensions (comma-separated)</label>
          <input value={fileExtensions} onChange={(e) => setFileExtensions(e.target.value)} disabled={isBuiltIn} placeholder=".go, .mod" />
        </div>
        <div className="lsp-dialog__field">
          <label>Command</label>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="gopls" />
        </div>
        <div className="lsp-dialog__field">
          <label>Args (space-separated)</label>
          <input value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder="serve" />
        </div>

        <div className="lsp-dialog__test">
          <button onClick={handleTest} disabled={!command.trim() || testStatus === 'testing'}>
            {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {testStatus === 'pass' && <span className="test-result test-result--pass">{testMessage}</span>}
          {testStatus === 'fail' && <span className="test-result test-result--fail">{testMessage}</span>}
        </div>

        {saveError && <div className="lsp-dialog__error">{saveError}</div>}

        <div className="lsp-dialog__actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {!isEdit && (
          <p className="lsp-dialog__hint">
            Test must pass before saving. The command will be invoked exactly as entered.
          </p>
        )}
      </div>
    </div>
  );
}
