import xmlFormatter from 'xml-formatter';
import type { languages, editor } from 'monaco-editor';

export function formatXml(input: string): string {
  try {
    return xmlFormatter(input, {
      indentation: '  ',
      collapseContent: true,
      lineSeparator: '\n',
    });
  } catch {
    return input;
  }
}

/**
 * Monaco format provider adapter.
 */
export const xmlFormatProvider: languages.DocumentFormattingEditProvider = {
  provideDocumentFormattingEdits(model: editor.ITextModel): languages.TextEdit[] {
    const formatted = formatXml(model.getValue());
    return [{
      range: model.getFullModelRange(),
      text: formatted,
    }];
  },
};
