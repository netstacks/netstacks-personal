; Kill running NetStacks processes so the installer can overwrite locked files.
; Without this, NSIS shows "Error opening file for writing: netstacks-agent.exe"
; when an existing install (or sidecar) is still running during upgrade.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM netstacks.exe /T'
  nsExec::Exec 'taskkill /F /IM netstacks-agent.exe /T'
  Sleep 500
!macroend

; Pre-trust the agent's localhost TLS cert during the install wizard so the
; first app launch is clean. Without this the Windows "install certificate?"
; dialog fires after the app is already loading, the TLS handshake races the
; user's click, and the login screen renders a backend error.
!macro NSIS_HOOK_POSTINSTALL
  ; 1. Generate (or load) the cert and write the fingerprint flag.
  nsExec::Exec '"$INSTDIR\netstacks-agent.exe" --init-tls'
  ; 2. Add it to the per-user Root store. certutil is idempotent on hash match,
  ;    so upgrade installs won't reprompt.
  nsExec::Exec 'certutil -user -addstore Root "$APPDATA\com.netstacks.terminal\localhost.crt"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM netstacks.exe /T'
  nsExec::Exec 'taskkill /F /IM netstacks-agent.exe /T'
  Sleep 500
!macroend
