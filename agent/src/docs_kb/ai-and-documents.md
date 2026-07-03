# AI setup and Documents

> Bundled help for the AI assistant. Website: ai/llm-config, ai/chat.

## AI provider setup
Configure AI under Settings → AI. Pick a **default provider** (Anthropic, OpenAI,
OpenRouter, Ollama, LiteLLM, or Custom), paste an API key (stored in the vault), and
pick a model. Test the connection.

The default provider powers **every** AI surface — chat side panel, floating
"Ask AI" pop-overs and hovers, Tab-to-fill suggestions, and background agents. You do
not configure providers per feature. The only optional override is a specific *model*
for the agent toolset (it still uses the default provider).

If a pop-over reports "not configured" while the side panel works, the default
provider simply has no key — set the default to the provider that actually has one.

A first-run **Setup Wizard** walks through this; reopen it from the command palette
("Setup Wizard"). Confusing settings have an "✨ Ask AI" button for guided help.

## Documents (the workspace document store)
A DB-backed, versioned store, separate from the RAG Knowledge Base. Categories:
`outputs`, `templates`, `notes` (encrypted Secure Notes), `backups`, `history`,
`troubleshooting`, `mops`.

Auto-generated documents — topology/device/link enrichment, troubleshooting
summaries, MOPs, task results, snapshots, and AI-saved docs — go to per-source
**categories + folders** the user controls under **Settings → Documents**. Defaults
match historical behavior; each source's target is configurable there.

The AI can read/write docs with the document tools (list/read/search/save_document);
`read_document` accepts a name or id.
