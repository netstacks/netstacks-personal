# NetStacks Concepts: API Resources vs Integrations

> Bundled help for the AI assistant. The website docs (getting-started/integrations) are the fuller source.

**API Resource** — the ONE reusable building block for talking to any external
system. It is a saved HTTP endpoint: base URL + auth type + TLS/timeout, with
credentials stored encrypted in the vault. Configured under Settings → API Resources.

Auth types: `none`, `bearer_token`, `basic`, `api_key_header` (custom header name,
default `X-API-Key`), `custom_header`, and `multi_step` (a login flow that extracts
a token). Each resource has a *test path* so it can be verified.

**Integration** — a named "source" that wraps an API Resource and adds
system-specific behavior (typed endpoints, import into app objects). NetStacks ships:
- **NetBox** — imports device inventory as ready-to-connect sessions (most full-featured).
- **LibreNMS** — devices + link/topology import.
- **Crawler** — Layer-2 topology/neighbors; this is NetStacks' UI over **Netdisco**.

Configured under Settings → Integrations. The URL + token live on the wrapped API
Resource; the integration layers behavior on top.

**Why they differ:** an API Resource is a generic endpoint; an Integration adds
typed proxies + import. An app that is NOT a first-class integration (SolarWinds,
PRTG, a CMDB, any REST API) still integrates — create an API Resource and use it via:
- **Quick Calls** — one-click saved HTTP calls,
- **Enrichment sources** — hover lookups on terminal tokens,
- **MOP steps** — calls inside a Method of Procedure.

**Answer pattern for "How do I integrate <app>?":** create an API Resource for it
(base URL + auth), test it, then use it via a Quick Call, an Enrichment source, or
(if it's NetBox/Netdisco/LibreNMS) the matching Integration. Offer to open the
relevant Settings tab.
