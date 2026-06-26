//! Wireless networking expertise — loaded when domain_focus includes wireless.

pub const WIRELESS_PACK: &str = "\
## Wireless Networking Expertise
### 802.11 Standards
- 802.11n (Wi-Fi 4): 2.4/5 GHz, up to 600 Mbps, MIMO
- 802.11ac (Wi-Fi 5): 5 GHz only, up to 6.9 Gbps, MU-MIMO downlink
- 802.11ax (Wi-Fi 6/6E): 2.4/5/6 GHz, OFDMA, BSS coloring, TWT
- Channel width: 20/40/80/160 MHz. Wider = more throughput, fewer non-overlapping channels.

### RF Troubleshooting
- 2.4 GHz non-overlapping: channels 1, 6, 11 (North America). Never use others.
- 5 GHz: DFS channels may require radar detection. Clients may not support all channels.
- Co-channel interference (CCI): too many APs on same channel. Reduce power or reassign.
- Adjacent-channel interference (ACI): overlapping channels in 2.4 GHz. Use only 1/6/11.
- Signal strength: -67 dBm minimum for voice, -70 dBm for data. Below -80 dBm = unusable.
- SNR: 25+ dB for reliable data, 30+ dB for voice. Noise floor typically -90 to -95 dBm.

### WLC / Controller-Based
- Lightweight APs (LAP): controlled by WLC via CAPWAP (UDP 5246/5247).
- AP modes: local (normal), monitor (IDS), flexconnect (local switching), sniffer.
- Client roaming: L2 roam (same VLAN) vs L3 roam (different subnet, mobility tunnel).
- Troubleshoot: check AP join status, client auth state, RADIUS reachability, DHCP.

### Common Gotchas
- Hidden SSID: does not improve security, causes probe overhead.
- Sticky clients: low-RSSI devices that won't roam. Use minimum RSSI threshold on APs.
- 802.1X auth failure: check RADIUS shared secret, cert validity, EAP type mismatch.
";
