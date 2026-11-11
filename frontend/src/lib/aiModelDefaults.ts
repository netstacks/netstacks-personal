/**
 * Single source of truth for the model IDs shown as hints/defaults in the UI
 * (NS-AI-40). Providers are bring-your-own-model, so these are suggestions —
 * never silently used as the active model. Keep in sync with
 * `agent/src/ai/providers.rs` `default_*_model()`.
 */
import type { AiProviderType } from '../hooks/useSettings'

/** Current Anthropic model IDs (no date suffixes). */
export const ANTHROPIC_MODELS = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const

/** Placeholder text for a free-form model input, per provider. */
export const MODEL_PLACEHOLDER: Record<AiProviderType, string> = {
  anthropic: `e.g. ${ANTHROPIC_MODELS.opus}, ${ANTHROPIC_MODELS.sonnet}, ${ANTHROPIC_MODELS.haiku}`,
  openai: 'e.g. gpt-4o, gpt-4o-mini',
  openrouter: `e.g. anthropic/${ANTHROPIC_MODELS.sonnet}, openai/gpt-4o`,
  ollama: 'e.g. llama3.2, qwen2.5-coder',
  litellm: 'e.g. gpt-4o (as named in your LiteLLM config)',
  custom: 'Model name as your endpoint expects it',
}

/** Suggested default model when a provider has none configured yet. */
export const SUGGESTED_MODEL: Record<AiProviderType, string> = {
  anthropic: ANTHROPIC_MODELS.opus,
  openai: 'gpt-4o',
  openrouter: `anthropic/${ANTHROPIC_MODELS.sonnet}`,
  ollama: 'llama3.2',
  litellm: 'gpt-4o',
  custom: '',
}
