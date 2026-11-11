/**
 * AI Provider Resolver — single, consistent way every AI feature picks its
 * provider/model, identical in standalone and enterprise mode.
 *
 * Contract: **route through the default AI unless a per-toolset override is set.**
 *
 *   - Default AI: return EMPTY provider/model. Callers omit them, and the
 *     backend uses the user's saved `ai.provider_config` — the single source of
 *     truth, resolved by whichever backend is active (local agent in standalone,
 *     controller in enterprise). This is why the side panel and every popup/hover
 *     now agree: none of them guess a provider client-side anymore.
 *   - Per-toolset override: only the 'agent' toolset has one today
 *     (`ai.agent.provider` / `ai.agent.model`). If the user set it, it wins and
 *     is sent explicitly.
 *
 * The model is never a hardcoded literal — an override with no model falls back
 * to the user's configured model list for that provider, else empty (backend
 * uses the saved model).
 */

import { getSettings } from '../hooks/useSettings';

export type AiFeature = 'suggestions' | 'nextStep' | 'highlighting' | 'agent' | 'default';

export interface ResolvedProvider {
  provider: string;
  model: string;
}

/**
 * Resolve the provider/model to send for a feature.
 *
 * Returns empty strings for the default path so callers omit the override and
 * the backend uses the authoritative saved config (same in both modes).
 */
export function resolveProvider(feature?: AiFeature): ResolvedProvider {
  const settings = getSettings();

  // There is ONE provider — the default (backend ai.provider_config). The only
  // per-toolset override is an optional MODEL for the 'agent' toolset, applied
  // to that same default provider. Provider is never overridden client-side, so
  // a toolset can never diverge to a keyless provider.
  if (feature === 'agent') {
    const model = settings['ai.agent.model'];
    if (model) return { provider: '', model };
  }

  // Default AI: empty → backend uses the saved ai.provider_config.
  return { provider: '', model: '' };
}
