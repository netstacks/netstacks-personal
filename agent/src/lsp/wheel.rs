//! Python wheel (ZIP) extraction helper.
//!
//! Pyrefly ships as a Python wheel (.whl), which is just a ZIP archive with
//! a predictable structure. This module extracts the binary executable from
//! the wheel without needing a full Python installation.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use thiserror::Error;
use zip::ZipArchive;

#[derive(Debug, Error)]
pub enum WheelError {
    #[error("wheel file not found: {0}")]
    NotFound(PathBuf),
    #[error("failed to open wheel: {0}")]
    IoError(#[from] std::io::Error),
    #[error("invalid ZIP archive: {0}")]
    ZipError(#[from] zip::result::ZipError),
    #[error("binary {0} not found in wheel")]
    BinaryNotFound(String),
}

/// Extract a binary executable from a Python wheel.
///
/// # Arguments
///
/// * `zip_path` - Path to the .whl file
/// * `binary_name` - Name of the executable (e.g. "pyrefly" or "pyrefly.exe")
/// * `dest` - Destination path for the extracted binary
///
/// # Returns
///
/// The absolute path to the extracted binary on success.
///
/// # Errors
///
/// Returns `WheelError::BinaryNotFound` if the wheel doesn't contain a file
/// whose name ends with `/{binary_name}` (Unix) or `\{binary_name}` (Windows).
/// Case-insensitive on Windows.
pub fn extract_binary_from_wheel(
    zip_path: &Path,
    binary_name: &str,
    dest: &Path,
) -> Result<PathBuf, WheelError> {
    if !zip_path.exists() {
        return Err(WheelError::NotFound(zip_path.to_path_buf()));
    }

    let file = File::open(zip_path)?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader)?;

    // Search for the binary by suffix. Python wheels can have varying
    // directory structures (e.g. pyrefly-1.0.0.data/bin/pyrefly or
    // pyrefly/bin/pyrefly), so we look for any entry ending with the
    // binary name rather than hardcoding a path.
    let mut found_index = None;
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name();

        // Check if the name ends with /{binary_name} or \{binary_name}
        #[cfg(target_os = "windows")]
        let matches = {
            let lower_name = name.to_lowercase();
            let lower_binary = binary_name.to_lowercase();
            lower_name.ends_with(&format!("/{}", lower_binary))
                || lower_name.ends_with(&format!("\\{}", lower_binary))
        };

        #[cfg(not(target_os = "windows"))]
        let matches = name.ends_with(&format!("/{}", binary_name));

        if matches {
            found_index = Some(i);
            break;
        }
    }

    let index = found_index.ok_or_else(|| WheelError::BinaryNotFound(binary_name.to_string()))?;

    // Extract the binary
    let mut zip_file = archive.by_index(index)?;
    let mut output = File::create(dest)?;
    std::io::copy(&mut zip_file, &mut output)?;
    drop(output); // Ensure file is flushed before chmod

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dest)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dest, perms)?;
    }

    Ok(dest.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Create a minimal wheel ZIP with a fake binary inside a nested directory.
    fn create_test_wheel(binary_name: &str, binary_content: &[u8]) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let wheel_path = dir.path().join("test.whl");

        let file = File::create(&wheel_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);

        // Add the binary inside a nested directory structure
        let options = zip::write::SimpleFileOptions::default()
            .unix_permissions(0o755);
        zip.start_file(format!("pyrefly-1.0.0.data/bin/{}", binary_name), options)
            .unwrap();
        zip.write_all(binary_content).unwrap();

        zip.finish().unwrap();

        (dir, wheel_path)
    }

    #[test]
    fn extracts_unix_binary() {
        let (_temp, wheel_path) = create_test_wheel("pyrefly", b"#!/bin/sh\necho hello");
        let dest = wheel_path.parent().unwrap().join("pyrefly");

        let result = extract_binary_from_wheel(&wheel_path, "pyrefly", &dest);
        assert!(result.is_ok());
        assert!(dest.exists());

        let content = std::fs::read(&dest).unwrap();
        assert_eq!(content, b"#!/bin/sh\necho hello");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::metadata(&dest).unwrap().permissions();
            assert_eq!(perms.mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn returns_error_for_missing_binary() {
        let (_temp, wheel_path) = create_test_wheel("pyrefly", b"content");
        let dest = wheel_path.parent().unwrap().join("wrong");

        let result = extract_binary_from_wheel(&wheel_path, "notfound", &dest);
        assert!(matches!(result, Err(WheelError::BinaryNotFound(_))));
    }

    #[test]
    fn returns_error_for_missing_wheel() {
        let dest = PathBuf::from("/tmp/pyrefly");
        let result = extract_binary_from_wheel(Path::new("/nonexistent.whl"), "pyrefly", &dest);
        assert!(matches!(result, Err(WheelError::NotFound(_))));
    }
}
