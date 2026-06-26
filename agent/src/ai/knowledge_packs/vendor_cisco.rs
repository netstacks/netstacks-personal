//! Cisco platform expertise — IOS, IOS-XE, NX-OS.

pub const VENDOR_CISCO_PACK: &str = "\
## Cisco Platform Expertise
### IOS / IOS-XE
- Config mode: `configure terminal`. Changes apply immediately (no commit model).
- Save config: `write memory` or `copy running-config startup-config`.
- Show commands: `show ip route`, `show ip bgp summary`, `show interfaces status`.
- Rollback: `configure replace` with archive. Always archive before changes.

### NX-OS
- Config mode: `configure terminal`. Has checkpoint/rollback (`checkpoint`, `rollback`).
- VDC-aware: `switchto vdc <name>`. Check VDC context before making changes.
- Feature-gated: `feature <name>` required before using protocols (e.g., `feature ospf`).
- Show commands: `show ip route vrf all`, `show bgp l2vpn evpn`.

### Common Gotchas
- `no shutdown` needed on most interfaces (admin-down by default on NX-OS).
- Route-map without `permit` statement = implicit deny all.
- ACL applied but not created = deny all traffic.
- VTP: if mode is server/client, VLAN changes propagate. Use transparent or off.
";
