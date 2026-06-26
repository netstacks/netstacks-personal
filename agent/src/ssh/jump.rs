//! ProxyJump implementation using native russh.
//!
//! Connects to a target host through a jump host by:
//! 1. Authenticating to the jump host
//! 2. Opening a direct-tcpip channel from jump to target
//! 3. Running a second russh client over that channel
//! 4. Authenticating to the target
//!
//! This replaces the broken PTY-based `ssh -J` path that incorrectly
//! shared the target's credentials across both hops.

use crate::ssh::{SshConfig, SshError, approvals::HostKeyApprovalService};
use russh::client::Handle;
use std::sync::Arc;

use super::ClientHandler;

/// Connect to a target host through a jump host.
///
/// Authenticates each hop with its own credentials and returns a russh
/// `Handle` to the target. The caller can open channels (PTY, SFTP, etc.)
/// on the returned handle exactly as if they had connected directly.
///
/// The jump session is kept alive by the channel reference; when the
/// caller drops the target handle, the channel closes and the jump exits.
pub async fn connect_via_jump(
    target: &SshConfig,
    jump: &SshConfig,
    approvals: Option<Arc<HostKeyApprovalService>>,
) -> Result<Handle<ClientHandler>, SshError> {
    // Step 1: Connect and authenticate to jump host.
    let jump_handle = super::connect_and_authenticate_with_approvals(
        jump,
        false,
        approvals.clone(),
    )
    .await?;

    // Step 2: Open direct-tcpip channel from jump to target.
    let channel = jump_handle
        .channel_open_direct_tcpip(
            target.host.clone(),
            target.port as u32,
            "127.0.0.1".to_string(),
            0u32,
        )
        .await
        .map_err(|e| {
            SshError::ChannelError(format!(
                "Jump host refused to open a tunnel to {}:{} ({}). \
                 Check that the jump host permits TCP forwarding (AllowTcpForwarding yes).",
                target.host, target.port, e
            ))
        })?;

    // Step 3: Wrap the channel as AsyncRead + AsyncWrite.
    let stream = channel.into_stream();

    // Step 4: Build russh client over the stream and authenticate to target.
    let target_handle =
        super::connect_and_authenticate_over_stream(target, stream, approvals).await?;

    // Step 5: The channel keeps a reference to the jump session, so we can
    // drop the jump_handle here. When the caller drops target_handle, the
    // channel closes and the jump session exits cleanly.
    drop(jump_handle);

    Ok(target_handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_utils::*;

    #[tokio::test]
    async fn connects_through_jump_with_key_then_password() {
        let jump_host_key = ephemeral_ed25519();
        let target_host_key = ephemeral_ed25519();

        // Jump host: accepts publickey auth as "jumpuser".
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: None,
            accept_key_user: Some("jumpuser".into()),
            allow_direct_tcpip: true,
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: jump_host_key,
        })
        .await;

        // Target host: accepts password auth as devuser/devpw.
        let target_addr = start_test_server(TestServerConfig {
            accept_password: Some(("devuser".into(), "devpw".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: target_host_key,
        })
        .await;

        let jump_key = ephemeral_ed25519();
        let key_path = write_temp_key(&jump_key);

        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "jumpuser".into(),
            auth: crate::ssh::SshAuth::KeyFile {
                path: key_path.to_string_lossy().into(),
                passphrase: None,
            },
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };
        let target_cfg = SshConfig {
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: "devuser".into(),
            auth: crate::ssh::SshAuth::Password("devpw".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };

        let handle = connect_via_jump(&target_cfg, &jump_cfg, None)
            .await
            .expect("should connect through jump");

        // Open a session and request shell to confirm we're talking to TARGET.
        let mut ch = handle.channel_open_session().await.unwrap();
        ch.request_shell(false).await.unwrap();

        // Wait for the READY banner the target's shell_request emits.
        let mut got_ready = false;
        for _ in 0..20 {
            match tokio::time::timeout(std::time::Duration::from_secs(2), ch.wait()).await {
                Ok(Some(russh::ChannelMsg::Data { data })) => {
                    let s = String::from_utf8_lossy(&data);
                    if s.contains("READY") {
                        got_ready = true;
                        break;
                    }
                }
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(_) => break,
            }
        }
        assert!(got_ready, "expected READY banner from target shell");
    }

    #[tokio::test]
    async fn jump_auth_failure_returns_descriptive_error() {
        let jump_host_key = ephemeral_ed25519();
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("right-user".into(), "right-pw".into())),
            accept_key_user: None,
            allow_direct_tcpip: true,
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: jump_host_key,
        })
        .await;

        // Wrong creds for the jump host. Target server isn't even reachable —
        // the function should bail out at the jump-auth step.
        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "wrong-user".into(),
            auth: crate::ssh::SshAuth::Password("wrong-pw".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };
        let target_cfg = SshConfig {
            host: "127.0.0.1".into(),
            port: 1, // dummy — never reached
            username: "x".into(),
            auth: crate::ssh::SshAuth::Password("y".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };

        let err = match connect_via_jump(&target_cfg, &jump_cfg, None).await {
            Ok(_) => panic!("jump auth should fail"),
            Err(e) => e,
        };
        let msg = format!("{}", err);
        assert!(
            msg.to_lowercase().contains("auth") || msg.to_lowercase().contains("denied"),
            "expected auth-related error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn target_auth_failure_returns_error_after_jump_succeeds() {
        let jump_host_key = ephemeral_ed25519();
        let target_host_key = ephemeral_ed25519();

        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("jumpuser".into(), "jumppw".into())),
            accept_key_user: None,
            allow_direct_tcpip: true,
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: jump_host_key,
        })
        .await;
        let target_addr = start_test_server(TestServerConfig {
            accept_password: Some(("right".into(), "right".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: target_host_key,
        })
        .await;

        // Correct jump creds, wrong target creds.
        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "jumpuser".into(),
            auth: crate::ssh::SshAuth::Password("jumppw".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };
        let target_cfg = SshConfig {
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: "wrong".into(),
            auth: crate::ssh::SshAuth::Password("wrong".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };

        let err = match connect_via_jump(&target_cfg, &jump_cfg, None).await {
            Ok(_) => panic!("target auth should fail"),
            Err(e) => e,
        };
        let msg = format!("{}", err);
        assert!(
            msg.to_lowercase().contains("auth") || msg.to_lowercase().contains("denied"),
            "expected auth-related error from target hop, got: {msg}"
        );
    }

    #[tokio::test]
    async fn jump_refuses_direct_tcpip_returns_descriptive_error() {
        let jump_host_key = ephemeral_ed25519();
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("u".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false, // KEY: refuse forwarding
            exec_responder: None,
            eof_before_exit_status: false,
            host_key: jump_host_key,
        })
        .await;

        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "u".into(),
            auth: crate::ssh::SshAuth::Password("p".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };
        let target_cfg = SshConfig {
            host: "127.0.0.1".into(),
            port: 22,
            username: "x".into(),
            auth: crate::ssh::SshAuth::Password("y".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };

        let err = match connect_via_jump(&target_cfg, &jump_cfg, None).await {
            Ok(_) => panic!("jump should refuse direct-tcpip"),
            Err(e) => e,
        };
        let msg = format!("{}", err);
        assert!(
            msg.contains("AllowTcpForwarding") || msg.contains("refused"),
            "expected forwarding-refused message, got: {msg}"
        );
    }

    #[tokio::test]
    async fn ssh_session_connect_via_jump_opens_shell_through_jump() {
        let (jump_addr, target_addr) = start_jump_and_target("u", "p", "dev", "devpw").await;

        let jump = crate::ssh::SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "u".into(),
            auth: crate::ssh::SshAuth::Password("p".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };
        let target = crate::ssh::SshConfig {
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: "dev".into(),
            auth: crate::ssh::SshAuth::Password("devpw".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };

        let session = crate::ssh::SshSession::connect_via_jump(target, jump, 80, 24)
            .await
            .expect("should connect via jump");

        // Read banner from target shell (test server emits "READY\n").
        let data = session.recv().await.unwrap().expect("should receive data");
        let s = String::from_utf8_lossy(&data);
        assert!(
            s.contains("READY"),
            "expected READY banner, got: {s}"
        );
    }
}
