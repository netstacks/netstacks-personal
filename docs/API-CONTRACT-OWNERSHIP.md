# API Contract Ownership (Frontend ↔ Agent)

This document defines where API contract logic belongs so request/response
shapes do not drift across duplicate clients.

## Canonical Frontend API Modules

- `frontend/src/api/vault.ts`
  - Owns all `/vault/*` routes and vault key operations
  - Exposes generic helpers (`*VaultApiKey`) used by other domains
- `frontend/src/api/ai.ts`
  - Owns `/ai/*` routes and AI settings
  - Must call vault helpers from `vault.ts` instead of re-implementing
    `/vault/api-keys/*` requests
- `frontend/src/api/mcp.ts`
  - Owns `/mcp/*` routes
  - Uses shared API error parsing from `frontend/src/api/errors.ts`
- `frontend/src/api/quickActions.ts`
  - Owns `/api-resources/*` and `/quick-actions/*`
  - Uses shared API error parsing from `frontend/src/api/errors.ts`

## Naming and Payload Rules

- Use backend field names exactly in transport payloads (`snake_case` from API).
- If UI needs a different shape, adapt at module boundary (never in component code).
- `PUT /vault/api-keys/:key_type` payload is `{ api_key: string }`.
- `GET /vault/api-keys/:key_type` response is `{ api_key: string | null }`.

## Error Handling Rules

- Parse axios errors via `frontend/src/api/errors.ts`.
- Prefer backend-provided `{ error, code }` over generic fallback strings.
- Handle `VAULT_LOCKED` and `NOT_CONFIGURED` consistently in each caller.

## Anti-Patterns to Avoid

- Duplicating the same endpoint logic across multiple API files.
- Building endpoint payloads directly in UI components.
- Handling `err.response.data` ad hoc in each module.
