# Setting up NetBox

> Bundled help for the AI assistant. Website: devices/netbox.

NetBox is a first-class integration backed by an API Resource. Two steps:

1. **Create the API Resource** (Settings → API Resources, or inline from the NetBox
   dialog):
   - Base URL = your NetBox URL, e.g. `https://netbox.example.com`
   - Auth type = `bearer_token`; token = your NetBox API token (stored in the vault)
   - Test path = `/api/status/` — click Test to confirm URL + token + TLS.

2. **Add a NetBox source** (Settings → Integrations → NetBox Sources) that references
   that API Resource. Then configure:
   - **Device filters** — sites / roles / manufacturers / platforms / statuses / tags
     to import only the devices you want.
   - **Profile mappings** — map site/role → a credential profile.
   - **CLI-flavor mappings** — map manufacturer/platform → CLI flavor.
   - Sync to import devices as ready-to-connect sessions.

Notes:
- Sync is one-way: NetBox → NetStacks. NetBox stays the source of truth.
- The vault must be unlocked to store/read the token.
- Test failures with 401/403 mean a bad token or wrong auth type.
