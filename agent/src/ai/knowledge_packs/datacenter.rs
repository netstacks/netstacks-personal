//! Data center networking expertise — loaded when domain_focus includes datacenter.

pub const DATACENTER_PACK: &str = "\
## Data Center Networking Expertise
### VXLAN/EVPN
- VXLAN encapsulates L2 frames in UDP (port 4789). VNI = 24-bit segment ID.
- EVPN provides control-plane learning. Route types: 2 (MAC/IP), 3 (Inclusive Multicast), 5 (IP Prefix).
- Underlay: typically OSPF or eBGP. Overlay: iBGP with route reflectors or eBGP (CLOS).
- Troubleshoot: check NVE peers, VNI mapping, ARP suppression, IMET routes.

### Fabric Architecture
- Spine-leaf (CLOS): every leaf connects to every spine. No leaf-to-leaf or spine-to-spine links.
- Oversubscription: calculate based on uplink vs downlink bandwidth ratio.
- Multi-site: DCI with EVPN multi-homing (ESI-based) or VXLAN stitching.

### VLAN & STP
- VLAN trunking: 802.1Q tagging. Native VLAN mismatch = silent failure. Always verify.
- STP variants: RSTP (802.1w), MSTP (802.1s), PVST+. Know convergence differences.
- Root bridge: lowest priority + lowest MAC. Set explicitly, never leave to chance.
- Port roles: Root, Designated, Alternate, Backup. Edge/portfast for access ports only.
";
