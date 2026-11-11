//! Juniper platform expertise — Junos OS.

pub const VENDOR_JUNIPER_PACK: &str = "\
## Juniper Platform Expertise
### Junos OS
- Config mode: `configure` or `configure exclusive` (locks config).
- Commit model: changes staged in candidate config, applied with `commit`. Always `commit check` first.
- Rollback: `rollback 0-49`. `rollback 0` = current active, `rollback 1` = previous.
- Show commands: `show route`, `show bgp summary`, `show interfaces terse`.

### Hierarchy
- Config organized as hierarchy: `[edit protocols ospf]`, `[edit interfaces]`.
- Set commands: `set protocols ospf area 0 interface ge-0/0/0`.
- Delete: `delete protocols ospf area 0 interface ge-0/0/0`.
- Wildcard: `wildcard delete interfaces ge-0/0/[0-3]` for bulk operations.

### Routing Policy
- Policy chains: first match wins (within a term). Multiple terms evaluated in order.
- Default actions: OSPF/IS-IS accept all, BGP rejects all (explicit policy required for eBGP).
- Prefix lists + policy-statements replace Cisco ACL + route-map pattern.
- Community handling: `set`, `add`, `delete` (not replace by default).

### Common Gotchas
- `commit confirmed <minutes>`: auto-rollback if not confirmed. Use for risky changes.
- `deactivate` vs `delete`: deactivate keeps config but doesn't apply. Useful for testing.
- Junos uses `inet.0` (IPv4), `inet6.0` (IPv6), `inet.2` (multicast RPF).
- Interface naming: `ge-` (1G), `xe-` (10G), `et-` (25/40/100G), `irb.X` (L3 VLAN).
";
