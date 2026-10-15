//! Canonical tool-name catalog (Feature A safety unification).
//!
//! Match sites previously hard-coded tool-name strings that did NOT match the
//! actual `Tool::name()` returns — most importantly the SSH tool is registered
//! as `execute_ssh_command` but the output validator only matched
//! `run_command`/`ssh_command`/etc., so every LLM-emitted SSH call fell
//! through the validator's `_ => Allow` arm. This module is the single source
//! of truth the output validator and the task permission resolver consume.

/// True for the SSH/command execution surface.
pub fn is_ssh_command(name: &str) -> bool {
    name == "execute_ssh_command"
}

/// True for file-write surfaces (write/edit).
pub fn is_file_write(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file")
}

/// True for the sed-patch surface.
pub fn is_patch(name: &str) -> bool {
    name == "patch_file"
}
