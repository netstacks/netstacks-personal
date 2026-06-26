//! Canonical tool-name catalog (Feature A safety unification).
//!
//! Two match sites previously hard-coded tool-name strings that did NOT
//! match the actual `Tool::name()` returns — most importantly the SSH tool
//! is registered as `execute_ssh_command` but the output validator only
//! matched `run_command`/`ssh_command`/etc., so every LLM-emitted SSH call
//! fell through the validator's `_ => Allow` arm. This module is the single
//! source of truth both sites consume.

/// Returns true when the named tool MUTATES state and therefore requires a
/// per-invocation user approval. Read-only / filtered tools return false.
/// Any `mcp_`-prefixed tool is treated as mutating (matches existing policy).
pub fn is_mutating(name: &str) -> bool {
    matches!(
        name,
        "write_file" | "edit_file" | "patch_file" | "send_email"
    ) || name.starts_with("mcp_")
}

/// True for the SSH/command execution surface (filtered, read-only-ish).
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
