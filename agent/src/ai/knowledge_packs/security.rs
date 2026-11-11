//! Network security expertise — loaded when domain_focus includes security.

pub const SECURITY_PACK: &str = "\
## Network Security Expertise
### ACL Best Practices
- Standard ACLs: source-only filtering. Place close to destination.
- Extended ACLs: source + destination + protocol + port. Place close to source.
- Named ACLs preferred over numbered. Always end with explicit deny + log.
- Sequence numbers allow insertion without rewriting entire ACL.

### Zone-Based Firewall
- Zones group interfaces. Traffic between zones requires explicit policy (zone-pair).
- Self-zone: traffic to/from the device itself. Implicit permit for self-zone by default on some platforms.
- Inspect actions: inspect (stateful), pass (stateless), drop, log.

### AAA
- Authentication order: local fallback after TACACS+/RADIUS. Never remove local fallback entirely.
- Authorization: exec (shell access), commands (per-command authorization), network (802.1X).
- Accounting: start-stop records for session tracking and compliance.
";
