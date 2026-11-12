; Kill running NetStacks processes so the installer can overwrite locked files.
; Without this, NSIS shows "Error opening file for writing: netstacks-agent.exe"
; when an existing install (or sidecar) is still running during upgrade.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM netstacks.exe /T'
  nsExec::Exec 'taskkill /F /IM netstacks-agent.exe /T'
  ; A killed process keeps its .exe locked until Windows finishes tearing it
  ; down (and Defender may scan it briefly), so a fixed sleep raced the copy
  ; and the updater wizard stopped on "Error opening file for writing" until
  ; Retry. Wait until the agent binary is actually writable, up to 15 s,
  ; after which NSIS's own Retry prompt still applies.
  Push $R8
  Push $R9
  StrCpy $R9 0
  ns_agent_unlock_loop:
    IfFileExists "$INSTDIR\netstacks-agent.exe" 0 ns_agent_unlock_done
    ClearErrors
    FileOpen $R8 "$INSTDIR\netstacks-agent.exe" a
    IfErrors ns_agent_unlock_locked
    FileClose $R8
    Goto ns_agent_unlock_done
  ns_agent_unlock_locked:
    IntOp $R9 $R9 + 1
    IntCmp $R9 60 ns_agent_unlock_done 0 ns_agent_unlock_done
    Sleep 250
    Goto ns_agent_unlock_loop
  ns_agent_unlock_done:
  Pop $R9
  Pop $R8
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
  nsExec::Exec 'certutil -user -addstore Root "$APPDATA\net.netstacks.Terminal\localhost.crt"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM netstacks.exe /T'
  nsExec::Exec 'taskkill /F /IM netstacks-agent.exe /T'
  Sleep 500
!macroend
