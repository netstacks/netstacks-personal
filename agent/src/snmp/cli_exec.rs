//! Run net-snmp CLI tools (`snmpget`, `snmpwalk`) on a remote SSH host
//! and parse their output back into the same `SnmpValueEntry` shape the
//! in-process UDP path produces.
//!
//! Used by the SNMP-via-jump path: when a device is reachable only via a
//! jump host (because SSH only forwards TCP and SNMP is UDP), the
//! `SnmpDest::ViaJump` variant routes here. The SSH connection authenticates
//! as the jump host's user (via the SshConfig the caller resolved), opens
//! an exec channel, runs the CLI tool, and we parse stdout.
//!
//! **Security tradeoff (accepted):** the community string is included in
//! `argv` and is therefore visible to anyone with `ps` access on the jump
//! host. This is acceptable for a typical bastion (which has tighter
//! access control than the broader network) and matches the project plan.

use super::cli_parse::parse_snmp_output;
use super::{SnmpError, SnmpValue, SnmpValueEntry, SnmpTryCommunityResponse};
use crate::ssh::exec_pool::exec_on_remote_pooled;
use crate::ssh::SshConfig;
use std::time::Duration;

/// Total timeout for a single via-jump SNMP call. Covers SSH handshake +
/// remote tool execution + stdout drain. Generous because SSH handshake
/// alone can be ~1s.
const VIA_JUMP_TIMEOUT: Duration = Duration::from_secs(20);

/// Per-tool wall-clock timeout passed to net-snmp via `-t`.
const SNMP_CLI_TIMEOUT_SECS: u32 = 5;

/// Per-tool retry count passed to net-snmp via `-r`.
const SNMP_CLI_RETRIES: u32 = 1;

/// Run `snmpget` on the jump and parse the result.
pub async fn snmp_get_via_jump(
    jump: &SshConfig,
    target_host: &str,
    target_port: u16,
    community: &str,
    oids: &[&str],
) -> Result<Vec<SnmpValueEntry>, SnmpError> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }

    let cmd = build_command("snmpget", community, target_host, target_port, oids);
    let result = exec_on_remote_pooled(jump, &cmd, VIA_JUMP_TIMEOUT)
        .await
        .map_err(map_ssh_error)?;
    interpret_exit(&result, jump, "snmpget")?;

    Ok(parse_snmp_output(&String::from_utf8_lossy(&result.stdout)))
}

/// Run `snmpwalk` on the jump and parse the result. Returns `(oid, value)`
/// tuples to match the in-process `snmp_walk` signature.
pub async fn snmp_walk_via_jump(
    jump: &SshConfig,
    target_host: &str,
    target_port: u16,
    community: &str,
    root_oid: &str,
) -> Result<Vec<(String, SnmpValue)>, SnmpError> {
    let cmd = build_command("snmpwalk", community, target_host, target_port, &[root_oid]);
    let result = exec_on_remote_pooled(jump, &cmd, VIA_JUMP_TIMEOUT)
        .await
        .map_err(map_ssh_error)?;
    interpret_exit(&result, jump, "snmpwalk")?;

    let entries = parse_snmp_output(&String::from_utf8_lossy(&result.stdout));
    Ok(entries.into_iter().map(|e| (e.oid, e.value)).collect())
}

/// Try each community string by issuing `snmpget` on sysName.0 via the jump.
/// Returns the first community whose query yields a string value.
pub async fn try_communities_via_jump(
    jump: &SshConfig,
    target_host: &str,
    target_port: u16,
    communities: &[String],
) -> Result<SnmpTryCommunityResponse, SnmpError> {
    const SYS_NAME_OID: &str = "1.3.6.1.2.1.1.5.0";

    let mut last_err: Option<SnmpError> = None;
    for community in communities {
        match snmp_get_via_jump(jump, target_host, target_port, community, &[SYS_NAME_OID]).await {
            Ok(entries) => {
                if let Some(entry) = entries.into_iter().next() {
                    if let SnmpValue::String(s) = entry.value {
                        return Ok(SnmpTryCommunityResponse {
                            community: community.clone(),
                            sys_name: s,
                        });
                    }
                }
                // Got something but it wasn't a usable string — keep trying.
            }
            Err(e) => last_err = Some(e),
        }
    }

    Err(last_err.unwrap_or_else(|| SnmpError::Other(
        "no communities to try".into()
    )))
}

/// Build a single shell-quoted net-snmp command line. Net-snmp tools
/// understand the same base argv (`-v2c -c <community> -On -t <secs> -r
/// <retries> <host>:<port> <oid>...`); only the tool name varies.
///
/// All user-supplied values (community, host, oids) are single-quoted
/// with embedded single-quote escaping (`'\''`) so they can't break out
/// of the argv into shell metacharacters. The remote shell is whatever
/// the jump's login shell is — we assume Bourne-compatible quoting,
/// which covers bash/zsh/dash/sh.
fn build_command(
    tool: &str,
    community: &str,
    host: &str,
    port: u16,
    oids: &[&str],
) -> String {
    let mut parts: Vec<String> = vec![
        tool.to_string(),
        "-v2c".to_string(),
        "-c".to_string(),
        sh_quote(community),
        "-On".to_string(),
        "-t".to_string(),
        SNMP_CLI_TIMEOUT_SECS.to_string(),
        "-r".to_string(),
        SNMP_CLI_RETRIES.to_string(),
        sh_quote(&format!("{}:{}", host, port)),
    ];
    for oid in oids {
        parts.push(sh_quote(oid));
    }
    parts.join(" ")
}

/// Single-quote a string for a Bourne-compatible shell. `'foo bar'` is
/// safe; embedded single quotes become `'\''` (close, escape, reopen).
fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

fn map_ssh_error(e: crate::ssh::SshError) -> SnmpError {
    SnmpError::Other(format!("SSH to jump host failed: {}", e))
}

/// Translate the remote shell's exit status into an actionable SnmpError.
/// 0 means the tool succeeded (parse stdout). 127 means the tool wasn't
/// found on the jump host. Anything else is a net-snmp-side failure;
/// surface stderr so the user sees the underlying message.
fn interpret_exit(
    result: &crate::ssh::ExecResult,
    jump: &SshConfig,
    tool: &str,
) -> Result<(), SnmpError> {
    use crate::ssh::ExecTermination;

    match result.exit_status {
        Some(0) => Ok(()),
        Some(127) => Err(SnmpError::Other(format!(
            "{tool} not found on jump host '{}' — install net-snmp on the jump (e.g. \
             `apt install snmp` / `yum install net-snmp-utils`).",
            jump.host
        ))),
        Some(code) => {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let stderr = stderr.trim();
            if stderr.is_empty() {
                Err(SnmpError::Other(format!(
                    "{tool} on jump '{}' exited with status {} (no stderr)",
                    jump.host, code
                )))
            } else {
                Err(SnmpError::Other(format!(
                    "{tool} on jump '{}' exited with status {}: {}",
                    jump.host, code, stderr
                )))
            }
        }
        None => {
            // Augment with whatever stderr made it through and the actual
            // termination reason — the bare "closed without exit status"
            // tells you nothing about what to fix.
            let stderr = String::from_utf8_lossy(&result.stderr);
            let stderr = stderr.trim();
            let stderr_suffix = if stderr.is_empty() {
                String::new()
            } else {
                format!(" (stderr: {})", stderr)
            };
            let msg = match &result.termination {
                ExecTermination::ExecRequestRejected => format!(
                    "{tool} exec rejected by sshd on jump '{}' — likely ForceCommand, \
                     restricted shell, or no-shell user. Verify the jump user can run \
                     `ssh {} {tool} -V` from a workstation.{}",
                    jump.host, jump.host, stderr_suffix
                ),
                ExecTermination::KilledBySignal(detail) => format!(
                    "{tool} on jump '{}' killed by signal {}{}",
                    jump.host, detail, stderr_suffix
                ),
                ExecTermination::ClosedSilently | ExecTermination::Normal => format!(
                    "{tool} on jump '{}' closed without an exit status{}",
                    jump.host, stderr_suffix
                ),
            };
            Err(SnmpError::Other(msg))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_quote_simple_value() {
        assert_eq!(sh_quote("public"), "'public'");
        assert_eq!(sh_quote("10.0.0.1:161"), "'10.0.0.1:161'");
    }

    #[test]
    fn sh_quote_escapes_embedded_single_quote() {
        // A community like  o'reilly  must close, escape, reopen.
        assert_eq!(sh_quote("o'reilly"), r"'o'\''reilly'");
    }

    #[test]
    fn sh_quote_passes_through_shell_metacharacters_safely() {
        // ; & | $() backticks etc. all stay inside the single quotes,
        // so the remote shell never interprets them.
        let nasty = "$(rm -rf /);#`";
        let quoted = sh_quote(nasty);
        assert_eq!(quoted, "'$(rm -rf /);#`'");
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
    }

    #[test]
    fn build_command_includes_all_required_flags() {
        let cmd = build_command("snmpget", "public", "10.0.0.1", 161, &["1.3.6.1.2.1.1.5.0"]);
        assert!(cmd.starts_with("snmpget"), "cmd: {cmd}");
        assert!(cmd.contains("-v2c"), "must request v2c");
        assert!(cmd.contains("-c 'public'"), "community quoted");
        assert!(cmd.contains("-On"), "numeric OIDs requested");
        assert!(cmd.contains("'10.0.0.1:161'"), "host:port quoted");
        assert!(cmd.contains("'1.3.6.1.2.1.1.5.0'"), "oid quoted");
    }

    #[test]
    fn build_command_quotes_each_oid_separately() {
        let cmd = build_command("snmpget", "x", "h", 161, &["1.2.3", "4.5.6"]);
        assert!(cmd.ends_with("'1.2.3' '4.5.6'"), "cmd: {cmd}");
    }

    // === Integration tests: snmpget shimmed by the test SSH server ===
    //
    // These exercise the full pipeline (build argv → exec on remote → parse
    // stdout) with the test SSH server impersonating a jump host that has
    // `snmpget` installed. The "shim" is the server's exec_responder — when
    // it sees an snmpget command, it returns a canned net-snmp-style stdout.

    use crate::ssh::test_utils::{ephemeral_ed25519, start_test_server, ExecResponse, TestServerConfig};
    use crate::ssh::{SshAuth, SshConfig};
    use std::sync::Arc;

    fn jump_cfg(addr: std::net::SocketAddr) -> SshConfig {
        SshConfig {
            host: addr.ip().to_string(),
            port: addr.port(),
            username: "u".into(),
            auth: SshAuth::Password("p".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        }
    }

    #[tokio::test]
    async fn via_jump_get_round_trips_through_shimmed_snmpget() {
        let saw_cmd = Arc::new(std::sync::Mutex::new(String::new()));
        let saw_cmd_w = saw_cmd.clone();

        let addr = start_test_server(TestServerConfig {
            accept_password: Some(("u".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: Some(Arc::new(move |cmd: &str| {
                *saw_cmd_w.lock().unwrap() = cmd.to_string();
                Some(ExecResponse {
                    stdout: b".1.3.6.1.2.1.1.5.0 = STRING: \"router-1\"\n".to_vec(),
                    stderr: vec![],
                    exit_status: 0,
                })
            })),
            eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
        })
        .await;

        let entries = snmp_get_via_jump(
            &jump_cfg(addr),
            "10.99.0.5",
            161,
            "public",
            &["1.3.6.1.2.1.1.5.0"],
        )
        .await
        .expect("via-jump get should succeed");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].oid, "1.3.6.1.2.1.1.5.0");
        match &entries[0].value {
            crate::snmp::SnmpValue::String(s) => assert_eq!(s, "router-1"),
            other => panic!("expected String, got {other:?}"),
        }

        // Shim should have seen a properly-formed snmpget invocation:
        // community + host:port + oid all single-quoted, -v2c -On flags set.
        let cmd = saw_cmd.lock().unwrap().clone();
        assert!(cmd.starts_with("snmpget"), "cmd: {cmd}");
        assert!(cmd.contains("-v2c") && cmd.contains("-On"), "cmd: {cmd}");
        assert!(cmd.contains("-c 'public'"), "community quoted: {cmd}");
        assert!(cmd.contains("'10.99.0.5:161'"), "host:port quoted: {cmd}");
        assert!(cmd.contains("'1.3.6.1.2.1.1.5.0'"), "oid quoted: {cmd}");
    }

    #[tokio::test]
    async fn via_jump_get_surfaces_command_not_found_with_actionable_message() {
        // Jump host doesn't have net-snmp installed → exit 127.
        let addr = start_test_server(TestServerConfig {
            accept_password: Some(("u".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: Some(Arc::new(|_| Some(ExecResponse {
                stdout: vec![],
                stderr: b"bash: snmpget: command not found\n".to_vec(),
                exit_status: 127,
            }))),
            eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
        })
        .await;

        let err = snmp_get_via_jump(
            &jump_cfg(addr),
            "10.99.0.5",
            161,
            "public",
            &["1.3.6.1.2.1.1.5.0"],
        )
        .await
        .unwrap_err();

        let msg = format!("{}", err);
        assert!(msg.contains("not found on jump host"),
            "msg should call out missing tool: {msg}");
        assert!(msg.contains("install net-snmp"),
            "msg should suggest the install: {msg}");
    }
}
