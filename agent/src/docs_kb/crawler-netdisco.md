# Crawler = Netdisco

> Bundled help for the AI assistant. Website: devices/network-discovery.

The **NetStacks-Crawler** integration is simply NetStacks' UI over **Netdisco's REST
API** (`/api/v1/...`). There is no separate crawler to install — if you already run
Netdisco, point Crawler at it.

Setup:
1. **Create an API Resource** for your Netdisco instance:
   - Base URL = your Netdisco host, e.g. `https://netdisco.example.com`
   - Auth type = `basic` (username/password) or `api_key_header`
   - Test path = `api/v1/device`
2. **Add a Crawler source** (Settings → Integrations → Crawler Sources) referencing it.

What it provides:
- Device inventory, LLDP/CDP neighbors, and Layer-2 device links.
- Feeds topology maps and enriches traceroute hops.

If a user says "I use Netdisco," tell them to use the Crawler integration and point
its API Resource at their Netdisco host with test path `api/v1/device`.
