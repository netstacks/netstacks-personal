//! Session Guard probe connection (spec §3.1, Part C §14.3).
//!
//! Opens a *second* SSH login to the device with the session's own
//! credentials, runs the read-only probe commands over one PTY shell, and
//! hands the text to the pure engine (`netstacks_agent::guard::probe`).
//! One login, one shell, six to ten `show` commands, then disconnect.
//! Nothing here parses device output.

use std::time::Duration;

use netstacks_agent::guard::path::{
    command_denied, extract_route_interface, extract_route_next_hop, extract_source_ip,
    ProbeOutputs,
};
use netstacks_agent::guard::probe::{
    assemble_facts, path_commands, route_command, stp_command, FactsSummary, MAX_ROUTE_HOPS,
    SETUP_COMMANDS, SOURCE_IP_COMMAND,
};
use netstacks_agent::guard::{Known, SessionFacts};
use russh::{client, Disconnect};

use crate::ssh::{connect_and_authenticate, strip_ansi, wait_for_exec_prompt, SshConfig};

/// Everything needed to open the probe login.
#[derive(Clone)]
pub struct ProbeSpec {
    pub config: SshConfig,
    pub device: String,
}

pub struct ProbeOutcome {
    pub facts: SessionFacts,
    pub summary: FactsSummary,
}

const PROMPT_TIMEOUT: Duration = Duration::from_secs(15);

/// Open the probe connection, collect the session facts, disconnect.
pub async fn probe_session_facts(spec: &ProbeSpec) -> Result<ProbeOutcome, String> {
    let handle = connect_and_authenticate(&spec.config, false)
        .await
        .map_err(|e| format!("probe login failed: {e}"))?;
    let result = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("probe channel: {e}"))?;
        channel
            .request_pty(false, "xterm", 200, 100, 0, 0, &[])
            .await
            .map_err(|e| format!("probe pty: {e}"))?;
        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("probe shell: {e}"))?;
        wait_for_exec_prompt(&mut channel, PROMPT_TIMEOUT)
            .await
            .map_err(|e| format!("probe: no prompt: {e}"))?;
        run_probes(&mut channel, &spec.device).await
    }
    .await;
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    result
}

/// Send one command and return its cleaned output (echo line removed,
/// trailing prompt kept — the extractors ignore it). Only an exec prompt
/// (`host#` / `host>`) ends the wait: a `Password:`-style line never does,
/// so a credential challenge times out instead of being read as output.
async fn send(channel: &mut russh::Channel<client::Msg>, cmd: &str) -> Result<String, String> {
    let mut cursor = std::io::Cursor::new(format!("{cmd}\n").into_bytes());
    channel
        .data(&mut cursor)
        .await
        .map_err(|e| format!("probe send `{cmd}`: {e}"))?;
    let raw = wait_for_exec_prompt(channel, PROMPT_TIMEOUT)
        .await
        .map_err(|e| format!("probe `{cmd}`: {e}"))?;
    let clean = strip_ansi(&raw);
    let body = match clean.split_once('\n') {
        Some((first, rest)) if first.trim_end().ends_with(cmd) => rest.to_string(),
        _ => clean,
    };
    Ok(body)
}

async fn run_probes(
    channel: &mut russh::Channel<client::Msg>,
    device: &str,
) -> Result<ProbeOutcome, String> {
    for cmd in SETUP_COMMANDS {
        let reply = send(channel, cmd).await?;
        if command_denied(&reply) {
            return Err(format!(
                "`{cmd}` was refused on the probe login ({}); paged output would stall the probe",
                first_line(&reply)
            ));
        }
    }
    let users = send(channel, SOURCE_IP_COMMAND).await?;
    if command_denied(&users) {
        return Err(format!(
            "`{SOURCE_IP_COMMAND}` was refused on the probe login ({})",
            first_line(&users)
        ));
    }
    let source_ip = match extract_source_ip(&users) {
        Known::Known(ip) => ip,
        Known::Unknown => {
            return Err(
                "could not determine this session's source address from `show users`".to_string(),
            )
        }
    };

    let cmds = path_commands(&source_ip);
    let ip_route = resolve_route(channel, &source_ip, &cmds[0]).await?;
    let trunks = send(channel, &cmds[2]).await?;
    let vty = send(channel, &cmds[3]).await?;
    let aaa = send(channel, &cmds[4]).await?;
    let probes = ProbeOutputs {
        ip_route: &ip_route,
        interfaces_trunk: &trunks,
        run_line_vty: &vty,
        run_aaa: &aaa,
    };

    let (facts, summary) = assemble_facts(device, &source_ip, &probes, None);
    let Some(vlan) = summary.ingress_vlan else {
        return Ok(ProbeOutcome { facts, summary });
    };
    let stp = send(channel, &stp_command(vlan)).await?;
    let (facts, summary) = assemble_facts(device, &source_ip, &probes, Some(&stp));
    Ok(ProbeOutcome { facts, summary })
}

/// Find the lookup output that names the outgoing interface for
/// `source_ip`: CEF if the platform answers it, else `show ip route`,
/// following bare next hops for at most [`MAX_ROUTE_HOPS`] lookups. The
/// returned text is whatever the last lookup printed; the extractors
/// decide whether it is `Known`.
async fn resolve_route(
    channel: &mut russh::Channel<client::Msg>,
    source_ip: &str,
    cef_cmd: &str,
) -> Result<String, String> {
    let cef = send(channel, cef_cmd).await?;
    if !extract_route_interface(&cef).is_unknown() {
        return Ok(cef);
    }
    let mut seen = vec![source_ip.to_string()];
    let mut target = source_ip.to_string();
    let mut out = String::new();
    for _ in 0..MAX_ROUTE_HOPS {
        out = send(channel, &route_command(&target)).await?;
        if !extract_route_interface(&out).is_unknown() {
            break;
        }
        match extract_route_next_hop(&out) {
            Some(hop) if !seen.contains(&hop) => {
                seen.push(hop.clone());
                target = hop;
            }
            _ => break,
        }
    }
    Ok(out)
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_utils::{
        ephemeral_ed25519, start_test_server, ShellScript, TestServerConfig,
    };
    use crate::ssh::SshAuth;
    use std::sync::Arc;

    fn fixture(name: &str) -> String {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/guard/fixtures/ios_xe");
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    async fn device(responder: impl Fn(&str) -> String + Send + Sync + 'static) -> ProbeSpec {
        let addr = start_test_server(TestServerConfig {
            accept_password: Some(("admin".into(), "pw".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
            shell: Some(ShellScript {
                prompt: "mgmt-sw-01#".into(),
                responder: Arc::new(responder),
                raw_responder: None,
            }),
        })
        .await;
        ProbeSpec {
            config: SshConfig {
                host: addr.ip().to_string(),
                port: addr.port(),
                username: "admin".into(),
                auth: SshAuth::Password("pw".into()),
                legacy_ssh: false,
                skip_keyboard_interactive: true,
            },
            device: "mgmt-sw-01".into(),
        }
    }

    #[tokio::test]
    async fn collects_full_path_set_over_one_login() {
        let spec = device(|cmd| match cmd {
            "terminal length 0" => String::new(),
            "show users" => fixture("show_users.txt"),
            "show ip cef 10.20.4.55" => fixture("ip_cef_attached.txt"),
            "show interfaces trunk" => fixture("interfaces_trunk.txt"),
            "show running-config | section line vty" => fixture("run_line_vty.txt"),
            "show running-config | include aaa" => fixture("run_aaa.txt"),
            "show spanning-tree vlan 10" => fixture("spanning_tree_vlan10_no_alt.txt"),
            other => panic!("unexpected probe command: {other}"),
        })
        .await;

        let out = probe_session_facts(&spec).await.unwrap();
        assert_eq!(out.summary.source_ip, "10.20.4.55");
        assert_eq!(out.summary.ingress_vlan, Some(10));
        assert_eq!(out.summary.object_count, 6);
        assert_eq!(out.facts.stp_has_alternate.value, Known::Known(false));
        let Known::Known(set) = &out.facts.path_objects.value else {
            panic!()
        };
        assert!(set
            .iter()
            .any(|o| o.to_string() == "iface:mgmt-sw-01:GigabitEthernet1/0/24"));
    }

    #[tokio::test]
    async fn routed_ingress_skips_stp_probe() {
        let spec = device(|cmd| match cmd {
            "show users" => fixture("show_users.txt"),
            "show ip cef 10.20.4.55" => "% Invalid input detected at '^' marker.\n".to_string(),
            "show ip route 10.20.4.55" => fixture("ip_route_routed_port.txt"),
            c if c.starts_with("show spanning-tree") => {
                panic!("STP must not be probed for routed ingress")
            }
            _ => String::new(),
        })
        .await;
        let out = probe_session_facts(&spec).await.unwrap();
        assert_eq!(out.summary.ingress_vlan, None);
        assert_eq!(out.facts.stp_has_alternate.value, Known::Known(false));
        assert_eq!(out.summary.object_count, 1);
    }

    #[tokio::test]
    async fn cef_resolves_next_hop_route_without_rib_walk() {
        let spec = device(|cmd| match cmd {
            "show users" => fixture("show_users.txt"),
            "show ip cef 10.20.4.55" => fixture("ip_cef_nexthop.txt"),
            "show interfaces trunk" => fixture("interfaces_trunk.txt"),
            c if c.starts_with("show ip route") => {
                panic!("RIB walk must not run when CEF names the interface: {c}")
            }
            "show spanning-tree vlan 100" => fixture("spanning_tree_vlan10_no_alt.txt"),
            _ => String::new(),
        })
        .await;
        let out = probe_session_facts(&spec).await.unwrap();
        assert_eq!(out.summary.ingress_vlan, Some(100));
        assert_eq!(
            out.summary.ingress.as_deref(),
            Some("svi:mgmt-sw-01:Vlan100")
        );
    }

    #[tokio::test]
    async fn rib_walk_follows_bare_next_hop_to_its_interface() {
        let spec = device(|cmd| match cmd {
            "show users" => fixture("show_users.txt"),
            "show ip cef 10.20.4.55" => "% Invalid input detected at '^' marker.\n".to_string(),
            "show ip route 10.20.4.55" => fixture("ip_route_nexthop.txt"),
            "show ip route 10.20.10.1" => fixture("ip_route_nexthop_resolved.txt"),
            "show interfaces trunk" => fixture("interfaces_trunk.txt"),
            "show spanning-tree vlan 100" => fixture("spanning_tree_vlan10_alt.txt"),
            _ => String::new(),
        })
        .await;
        let out = probe_session_facts(&spec).await.unwrap();
        assert_eq!(out.summary.ingress_vlan, Some(100));
        assert_eq!(out.facts.stp_has_alternate.value, Known::Known(true));
        assert!(out
            .facts
            .path_objects
            .source
            .starts_with("show ip cef 10.20.4.55"));
    }

    #[tokio::test]
    async fn rib_walk_is_bounded_and_ends_unknown() {
        let lookups = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = lookups.clone();
        let spec = device(move |cmd| match cmd {
            "show users" => fixture("show_users.txt"),
            "show ip cef 10.20.4.55" => "0.0.0.0/0\n  no route\n".to_string(),
            c if c.starts_with("show ip route ") => {
                // Every hop answers with yet another bare next hop.
                let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                format!("Routing entry for 0.0.0.0/0, supernet\n  Routing Descriptor Blocks:\n  * 10.99.{n}.1\n")
            }
            _ => String::new(),
        })
        .await;
        let out = probe_session_facts(&spec).await.unwrap();
        assert_eq!(
            lookups.load(std::sync::atomic::Ordering::SeqCst),
            MAX_ROUTE_HOPS
        );
        assert!(out.facts.path_objects.value.is_unknown());
        assert_eq!(out.summary.ingress, None);
    }

    #[tokio::test]
    async fn denied_terminal_length_fails_the_probe_with_a_reason() {
        let spec = device(|cmd| match cmd {
            "terminal length 0" => "Command authorization failed.\n".to_string(),
            "show users" => panic!("probe must stop after the paging setup is refused"),
            _ => String::new(),
        })
        .await;
        let err = probe_session_facts(&spec).await.err().unwrap();
        assert!(err.contains("`terminal length 0` was refused"), "{err}");
        assert!(err.contains("Command authorization failed"), "{err}");
    }

    #[tokio::test]
    async fn denied_show_run_leaves_path_unknown() {
        let spec = device(|cmd| match cmd {
            "show users" => fixture("show_users.txt"),
            "show ip cef 10.20.4.55" => fixture("ip_cef_attached.txt"),
            "show interfaces trunk" => fixture("interfaces_trunk.txt"),
            "show running-config | section line vty" => {
                "Command authorization failed.\n".to_string()
            }
            "show running-config | include aaa" => fixture("run_aaa.txt"),
            _ => String::new(),
        })
        .await;
        let out = probe_session_facts(&spec).await.unwrap();
        assert!(out.facts.path_objects.value.is_unknown());
        assert_eq!(
            out.summary.to_string(),
            "session path unknown (source 10.20.4.55)"
        );
    }

    #[test]
    fn exec_prompt_never_matches_a_credential_challenge() {
        use crate::ssh::is_exec_prompt;
        for ok in [
            "mgmt-sw-01#",
            "banner text\r\nmgmt-sw-01>",
            "sw(config-if)#",
            "RP/0/RSP0/CPU0:xr#  ",
        ] {
            assert!(is_exec_prompt(ok), "{ok:?}");
        }
        for bad in [
            "Password:",
            "mgmt-sw-01#\r\nPassword:",
            "Username: ",
            "Serial number:",
            "",
            "#",
            "some words #",
        ] {
            assert!(!is_exec_prompt(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn missing_source_address_is_an_error_not_a_guess() {
        let spec = device(|cmd| match cmd {
            "show users" => "    Line       User       Host(s)   Idle       Location\n".to_string(),
            _ => String::new(),
        })
        .await;
        let err = probe_session_facts(&spec).await.err().unwrap();
        assert!(err.contains("source address"), "{err}");
    }

    #[tokio::test]
    async fn bad_credentials_surface_as_login_failure() {
        let mut spec = device(|_| String::new()).await;
        spec.config.auth = SshAuth::Password("wrong".into());
        let err = probe_session_facts(&spec).await.err().unwrap();
        assert!(err.contains("login failed"), "{err}");
    }
}
