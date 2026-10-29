import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Options as RehypeHighlightOptions } from 'rehype-highlight';
import { common } from 'lowlight';
import './MarkdownViewer.css';

// Register only the grammars NetStacks actually renders (docs, AI replies,
// workspace previews) instead of lowlight's full 37-grammar common set, so
// each render's highlighter setup stays small. Picked from `common` so no
// grammar outside the set rehype-highlight already bundles is pulled in.
// Grammar aliases still apply (sh/zsh, console, py, yml, html/svg, js/jsx,
// ts/tsx, toml, text/txt, md). Fences in any other language (e.g. `cisco`)
// are left unhighlighted — rehype-highlight records a vfile message for an
// unregistered language rather than throwing. Auto-detect stays off.
const highlightLanguages: NonNullable<RehypeHighlightOptions['languages']> = {
  bash: common.bash,
  shell: common.shell,
  python: common.python,
  json: common.json,
  yaml: common.yaml,
  xml: common.xml,
  javascript: common.javascript,
  typescript: common.typescript,
  ini: common.ini,
  diff: common.diff,
  markdown: common.markdown,
  plaintext: common.plaintext,
};

const remarkPlugins = [remarkGfm];
const rehypePlugins: [[typeof rehypeHighlight, RehypeHighlightOptions]] = [
  [rehypeHighlight, { languages: highlightLanguages, detect: false }],
];

interface MarkdownViewerProps {
  content: string;
  isEditing?: boolean;
  onChange?: (content: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
}

export default function MarkdownViewer({
  content,
  isEditing = false,
  onChange,
  onSave,
  onCancel,
}: MarkdownViewerProps) {
  if (isEditing && onChange) {
    return (
      <div className="markdown-editor">
        <div className="markdown-editor-toolbar">
          {onSave && (
            <button className="ns-btn ns-btn--primary" onClick={onSave}>
              Save
            </button>
          )}
          {onCancel && (
            <button className="ns-btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        <textarea data-ai-fill="off" aria-label="Markdown"
          className="markdown-editor-textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="markdown-viewer">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          // Custom table styling
          table: ({ children }) => (
            <div className="markdown-table-wrapper">
              <table>{children}</table>
            </div>
          ),
          // Custom code block
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="markdown-inline-code" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // Audit P1-19: target="_blank" is unreliable in Tauri v2 —
          // it sometimes opens inside the WebView (broken back/forward)
          // or no-ops depending on platform. Explicit shell-plugin
          // dispatch matches the Terminal.tsx pattern and works
          // everywhere.
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              onClick={async (e) => {
                if (!href || href.startsWith('#')) return // anchor links → default
                e.preventDefault()
                try {
                  const { open } = await import('@tauri-apps/plugin-shell')
                  await open(href)
                } catch {
                  window.open(href, '_blank', 'noopener,noreferrer')
                }
              }}
              {...props}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
