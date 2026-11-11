// main.tsx imports Monaco via its slim ESM submodules (editor.api + only the
// languages we use) to avoid bundling the full editor. Those deep paths exist
// on disk but are blocked by monaco-editor's `exports` map under
// moduleResolution:bundler, so declare them here.
//
// editor.api re-exports the same value namespaces (editor, languages, Uri, …)
// as the package root, so the types line up with `import * as monaco`.
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}
// Side-effect-only language contributions — no runtime API surface.
declare module 'monaco-editor/esm/vs/basic-languages/*'
declare module 'monaco-editor/esm/vs/language/*'
