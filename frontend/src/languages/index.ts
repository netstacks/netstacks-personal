import type * as Monaco from 'monaco-editor';
import { yangLanguage, yangLanguageConfig } from './yang';
import { yangFormatProvider } from './yangFormat';
import { xmlFormatProvider } from './xmlFormat';
import { netcliLanguage, netcliLanguageConfig } from './netcli';

/**
 * Register all NetStacks-specific language features on the given Monaco
 * instance. Call this once at app bootstrap, after MonacoEnvironment is
 * configured but before any editor is created.
 *
 * Adds:
 *   - YANG language id ('yang') with Monarch tokenizer + language config
 *   - YANG document format provider (indent-based pretty-printer)
 *   - XML document format provider (xml-formatter)
 *   - Network CLI language id ('netcli') for Cisco/Junos config backups
 *
 * JSON is intentionally not registered — Monaco's bundled json.worker
 * already provides syntax, schema validation, and format-document.
 */
export function registerNetstacksLanguages(monaco: typeof Monaco): void {
  monaco.languages.register({
    id: 'yang',
    extensions: ['.yang'],
    aliases: ['YANG', 'yang'],
  });
  monaco.languages.setMonarchTokensProvider('yang', yangLanguage);
  monaco.languages.setLanguageConfiguration('yang', yangLanguageConfig);
  monaco.languages.registerDocumentFormattingEditProvider('yang', yangFormatProvider);

  // XML — already registered by Monaco; just add the format provider.
  monaco.languages.registerDocumentFormattingEditProvider('xml', xmlFormatProvider);

  // Network CLI — Cisco/Junos config backups (no built-in Monaco language).
  monaco.languages.register({
    id: 'netcli',
    aliases: ['Network CLI', 'netcli'],
  });
  monaco.languages.setMonarchTokensProvider('netcli', netcliLanguage);
  monaco.languages.setLanguageConfiguration('netcli', netcliLanguageConfig);
}
