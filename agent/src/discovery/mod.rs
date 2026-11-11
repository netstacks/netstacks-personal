//! Discovery module for NetStacks agent
//!
//! Provides server-side network device neighbor discovery using:
//! - SNMP LLDP-MIB and CDP-MIB table walks (primary method)
//! - CLI parsing of show commands via SSH (fallback)
//! - Integration IP lookup via NetBox, Netdisco, LibreNMS
//! - Nmap fingerprinting for unknown devices

pub mod snmp_neighbors;
pub mod cli_neighbors;
pub mod integration_lookup;
pub mod nmap;
pub mod orchestrator;

pub use snmp_neighbors::DiscoveredNeighbor;
pub use nmap::NmapResult;
pub use orchestrator::{
    BatchDiscoveryRequest, TargetDiscoveryResult,
    TracerouteResolveRequest, HopResolutionResult,
    DiscoveryCapabilities,
};
