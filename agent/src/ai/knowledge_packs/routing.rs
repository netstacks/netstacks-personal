//! Routing protocol expertise — loaded when user's domain_focus includes routing.

pub const ROUTING_PACK: &str = "\
## Routing Protocol Expertise
### OSPF
- LSA types: 1 (Router), 2 (Network), 3 (Summary), 4 (ASBR Summary), 5 (External), 7 (NSSA)
- Adjacency states: Down → Init → 2-Way → ExStart → Exchange → Loading → Full
- Stuck-in-ExStart: check MTU mismatch first, then area type mismatch, then authentication
- DR/BDR election: highest priority wins, then highest RID. Non-preemptive.
- Area design: backbone area 0 required, stub/NSSA for route reduction at edges

### BGP
- Path selection (in order): highest weight, highest local-pref, locally originated, shortest AS-path, \
lowest origin (IGP < EGP < incomplete), lowest MED (when from same AS), eBGP over iBGP, \
lowest IGP metric to next-hop, oldest route, lowest RID, lowest neighbor IP
- FSM states: Idle → Connect → Active → OpenSent → OpenConfirm → Established
- NOTIFICATION codes: 1 (Header), 2 (OPEN), 3 (UPDATE), 4 (Hold Timer), 5 (FSM), 6 (Cease)
- Always check: next-hop reachability, AS-path filtering, route-maps, prefix-lists

### EIGRP
- DUAL states: Passive (stable), Active (reconverging). Stuck-in-Active = neighbor not responding
- Metric: bandwidth + delay by default. K-values must match between neighbors.
- Feasibility condition: reported distance < feasible distance for successor

### IS-IS
- NET format: area.system-id.selector (e.g., 49.0001.1921.6800.1001.00)
- Level 1 (intra-area) vs Level 2 (inter-area). L1/L2 routers leak between levels.
- Metric style: narrow (6-bit, max 63) vs wide (24-bit). Must match on adjacency.
";
