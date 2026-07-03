# Enrichment: sources and token matchers

> Bundled help for the AI assistant. Website: terminal/enrichment.

Enrichment shows contextual info when you hover a highlighted token in the terminal
(an IP, MAC, hostname, etc.). Configured under Settings → Enrichment.

**Token matchers** decide *which token types trigger which lookups*. A matcher pairs
a token pattern (IP, MAC, hostname, interface, …) with the sources that should run on
it, optionally gated by CLI flavor. If a token isn't lighting up on hover, there is
no matcher for that token type (or the source it needs is disabled).

**Sources** are what a matcher runs:
- **builtin** sources — `dns_ptr`, `oui_vendor`, `mac_address_type`. No HTTP, always available.
- **api_resource** sources — call ANY API Resource. You set:
  - the API Resource to use,
  - a `path_template`, e.g. `/api/search?q={token}` (substitutes the hovered token;
    also `{token_url}`, `{session_host}`),
  - `response_unwrap` (dig into nested JSON) and `picked_fields` (which fields to show).

This is how a generic third-party API (a CMDB, IPAM, monitoring tool) becomes a hover
lookup without any first-class integration: create an API Resource, then an
api_resource enrichment source that points at it, and a matcher for the token type.

To set one up: Settings → Enrichment → add a Source (kind = api_resource), pick the
API Resource, set the path_template + picked fields, then ensure a Matcher routes the
right token type to it. Test the source before relying on it.
