//! Arista platform expertise — EOS.

pub const VENDOR_ARISTA_PACK: &str = "\
## Arista Platform Expertise
### EOS (Extensible Operating System)
- Linux-based: full bash shell access via `bash` command. Useful for scripting and debugging.
- Config mode: `configure` or `configure session <name>` (transactional, like Junos commit).
- Config sessions: stage changes, review diff, commit or abort. `configure session` is safest.
- Show commands: `show ip route`, `show bgp evpn`, `show interfaces status`, `show mlag`.

### MLAG (Multi-Chassis Link Aggregation)
- Two switches act as one for downstream LAGs. Requires peer-link and MLAG domain config.
- Peer-link: carries control traffic + BUM traffic. Must be high bandwidth (typically 2x100G).
- MLAG ID: must match on both peers for same downstream device.
- Troubleshoot: `show mlag`, `show mlag detail`, check peer-link status, config-sanity warnings.

### EVPN/VXLAN on EOS
- VXLAN data plane: `interface Vxlan1`, map VNIs to VLANs.
- EVPN control plane: BGP with `address-family evpn`, `neighbor X activate`.
- Type-5 routes: IP prefix advertisement for L3 VNI (inter-VLAN routing).
- Troubleshoot: `show vxlan vtep`, `show bgp evpn route-type mac-ip`, `show vxlan address-table`.

### CloudVision (CVP)
- Centralized management: config management, telemetry, compliance, image management.
- Configlets: reusable config snippets applied to devices. Changes staged as change controls.
- Streaming telemetry: gNMI/OpenConfig paths. Real-time state vs traditional SNMP polling.

### Common Gotchas
- `service routing protocols model multi-agent`: required for modern BGP/EVPN features. Not default.
- TCAM profiles: some features (ACLs, routing) share limited TCAM. Check `show hardware tcam profile`.
- EOS versions: 4.2x.xF = feature release, 4.2x.xM = maintenance. Match to your stability needs.
- `ip routing`: must be explicitly enabled for L3 forwarding (not on by default in all contexts).
";
