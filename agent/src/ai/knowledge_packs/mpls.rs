//! MPLS expertise — loaded when domain_focus includes mpls.

pub const MPLS_PACK: &str = "\
## MPLS Expertise
### Label Switching Fundamentals
- Labels: 20-bit, local significance. Swap/push/pop operations at each hop.
- Reserved labels: 0 (IPv4 explicit null), 1 (router alert), 2 (IPv6 explicit null), 3 (implicit null/PHP).
- PHP (Penultimate Hop Popping): second-to-last router pops label, egress does IP lookup.
- TTL propagation: can be disabled to hide MPLS core from traceroute.

### LDP (Label Distribution Protocol)
- Discovers neighbors via UDP 646 multicast, sessions via TCP 646.
- Liberal label retention: keeps all labels even if not best path (faster convergence).
- Session protection: maintains LDP session during IGP reconvergence via targeted hello.
- Troubleshoot: check LDP neighbor state, label bindings, targeted-hello if indirect.

### RSVP-TE (Traffic Engineering)
- Explicit paths (ERO): strict or loose hops through the network.
- Bandwidth reservation: RSVP signals bandwidth along the path.
- FRR (Fast Reroute): facility backup (many-to-one) or one-to-one (per-LSP detour).
- Make-before-break: new LSP established before old torn down (hitless reoptimization).

### L3VPN (RFC 4364)
- VRF: per-customer routing table on PE router. RD (Route Distinguisher) makes routes unique in BGP.
- RT (Route Target): controls import/export between VRFs. Can create complex topologies (hub-spoke, full-mesh).
- MP-BGP: carries VPNv4/VPNv6 routes between PEs. Next-hop = PE loopback (must be reachable via LDP/RSVP).
- Troubleshoot: check VRF routes, RT import/export, MP-BGP peering, label allocation, CEF entries.

### Common Gotchas
- LDP-IGP sync: without it, traffic can blackhole during convergence. Enable on all core interfaces.
- MTU: MPLS adds 4 bytes per label. Ensure core MTU accommodates label stack (typically 9100+).
- TTL expiry: `no mpls ip propagate-ttl` hides core but breaks traceroute-based monitoring.
";
