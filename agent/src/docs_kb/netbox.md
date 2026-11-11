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
   - **Console access** — a terminal-server credential profile and the SSH/Telnet
     rule per console-server manufacturer (defaults: Opengear → SSH, Cisco → Telnet).
   - Sync to import devices as ready-to-connect sessions.

## Console access (out-of-band) from NetBox

The importer fills each session's Console settings when NetBox describes the path:

1. In NetBox, create a custom field named `device_console` (type **Integer**, content
   type **DCIM > console port**). It holds the TCP port on the console server that
   exposes that line — e.g. `3007` for Opengear serial 7, `2007` for a Cisco async line.
2. Cable the device's console port to a port on its console server (a NetBox
   `console server port`). The console server device needs a primary IPv4 (or OOB IP).
3. Set `device_console` on the device's console port.

On import, NetStacks reads the cabled console server's IP and the port number, picks
SSH or Telnet from the source's console rules, and assigns the source's terminal-server
profile. Existing imported sessions get their console access refreshed on each sync
(checkbox in the import dialog). Devices without a cable, without the custom field, or
whose console server has no IP are listed in the import report — nothing is guessed.
Right-click a session → **Open Console** to use it.

Notes:
- Sync is one-way: NetBox → NetStacks. NetBox stays the source of truth.
- The vault must be unlocked to store/read the token.
- Test failures with 401/403 mean a bad token or wrong auth type.
