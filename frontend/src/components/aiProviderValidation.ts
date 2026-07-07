/**
 * Pure requirement check for an AI provider's config completeness.
 * Save requires the provider's required inputs (key and/or base URL).
 * Set-as-Default additionally requires at least one configured model.
 */
export function providerRequirements(input: {
  requiresKey: boolean;
  hasKey: boolean;
  modelCount: number;
  needsBaseUrl: boolean;
  hasBaseUrl: boolean;
}): { canSave: boolean; canSetDefault: boolean; missing: string[] } {
  const missing: string[] = [];
  if (input.requiresKey && !input.hasKey) missing.push('an API key');
  if (input.needsBaseUrl && !input.hasBaseUrl) missing.push('a base URL');
  const inputsOk = missing.length === 0;
  if (input.modelCount < 1) missing.push('at least one model');
  return {
    canSave: inputsOk,
    canSetDefault: inputsOk && input.modelCount >= 1,
    missing,
  };
}
