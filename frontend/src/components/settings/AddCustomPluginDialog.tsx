import AITabInput from '../AITabInput';
import { useState } from 'react';
import { createUserPlugin, updatePlugin, testPluginCommand, type LspPluginListItem } from '../../lsp/installationApi';
import DialogFooter from '../DialogFooter';
import ModalFrame from '../ModalFrame';
import './AddCustomPluginDialog.css';

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


  const field = (id: string, label: string, input: React.ReactNode) => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      {input}
    </div>
  );

  return (
    <ModalFrame id="lsp-plugin" onDismiss={onClose} dismissEnabled={!saving} className="dialog lsp-dialog" labelledBy="lsp-dialog-title">
      <div className="dialog-header">
        <h2 id="lsp-dialog-title">{isEdit ? `Edit ${existing!.displayName}` : 'Add Language Server'}</h2>
        <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
          ×
        </button>
      </div>
      <div className="dialog-content">
        {field('lsp-plugin-id', 'Plugin ID',
          <AITabInput id="lsp-plugin-id" className="lsp-dialog-mono" value={id} onChange={(e) => setId(e.target.value)} disabled={isEdit} placeholder="e.g. gopls" aiField="language server plugin id" aiPlaceholder="Short lowercase id for this language server (usually the server's binary name)" aiContext={{ language, command }} onAIValue={setId} />)}
        {field('lsp-display-name', 'Display Name',
          <AITabInput id="lsp-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={isBuiltIn} placeholder="e.g. gopls" aiField="language server display name" aiPlaceholder="Human-readable name of this language server" aiContext={{ id, language, command }} onAIValue={setDisplayName} />)}
        {field('lsp-language', 'Monaco Language ID',
          <AITabInput id="lsp-language" className="lsp-dialog-mono" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isBuiltIn} placeholder="e.g. go" aiField="Monaco language id" aiPlaceholder="The Monaco editor language id this server handles (e.g. python, go, yaml)" aiContext={{ id, command }} onAIValue={setLanguage} />)}
        {field('lsp-extensions', 'File Extensions (comma-separated)',
          <AITabInput id="lsp-extensions" className="lsp-dialog-mono" value={fileExtensions} onChange={(e) => setFileExtensions(e.target.value)} disabled={isBuiltIn} placeholder=".go, .mod" aiField="file extensions" aiPlaceholder="Comma-separated file extensions this language server should handle" aiContext={{ language, id }} onAIValue={setFileExtensions} />)}
        {field('lsp-command', 'Command',
          <AITabInput id="lsp-command" className="lsp-dialog-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="gopls" aiField="language server command" aiPlaceholder="Executable that starts this language server over stdio" aiContext={{ id, language }} onAIValue={setCommand} />)}
        {field('lsp-args', 'Args (space-separated)',
          <AITabInput id="lsp-args" className="lsp-dialog-mono" value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder="serve" aiField="language server arguments" aiPlaceholder="Space-separated arguments that make the server speak LSP over stdio" aiContext={{ command, language }} onAIValue={setArgsStr} />)}

        <div className="lsp-dialog-test">
          <button className="ns-btn" onClick={handleTest} disabled={!command.trim() || testStatus === 'testing'}>
            {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {testStatus === 'pass' && <span className="lsp-dialog-test-result pass">{testMessage}</span>}
          {testStatus === 'fail' && <span className="lsp-dialog-test-result fail">{testMessage}</span>}
        </div>

        {saveError && <div className="dialog-error">{saveError}</div>}
        {!isEdit && (
          <p className="form-hint">Test must pass before saving. The command will be invoked exactly as entered.</p>
        )}
      </div>
      <DialogFooter
        primary={{ label: saving ? 'Saving…' : 'Save', onClick: handleSave, disabled: !canSave || saving }}
        onCancel={onClose}
      />
    </ModalFrame>
  );
}
