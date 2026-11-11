//! Trace persistence (spec §5): local disk only, append-only, owned by the
//! customer. Two files side by side — `trace.log` in the human-readable
//! §5 shape and `trace.jsonl` for tooling — under the app's local data
//! directory (`…/netstacks/guard/`).

use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

use super::trace::TraceRecord;

/// Where trace records live on this machine.
pub fn trace_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("netstacks").join("guard"))
}

/// Append a record to the default trace directory. Returns the text log path.
pub async fn append_trace(record: &TraceRecord) -> std::io::Result<PathBuf> {
    let dir = trace_dir().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no local data directory"))?;
    append_trace_to(&dir, record).await
}

/// Append a record to `dir` (created if missing).
pub async fn append_trace_to(dir: &Path, record: &TraceRecord) -> std::io::Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;

    let text_path = dir.join("trace.log");
    let mut text = tokio::fs::OpenOptions::new().create(true).append(true).open(&text_path).await?;
    text.write_all(format!("{}\n", record.render()).as_bytes()).await?;
    // tokio::fs::File defers the actual write to the blocking pool; without
    // an explicit flush the data may not be on disk when the handle drops.
    text.flush().await?;

    let json = serde_json::to_string(record).map_err(std::io::Error::other)?;
    let mut jsonl = tokio::fs::OpenOptions::new().create(true).append(true).open(dir.join("trace.jsonl")).await?;
    jsonl.write_all(format!("{json}\n").as_bytes()).await?;
    jsonl.flush().await?;

    Ok(text_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::{evaluate, parse, ContextStack, FactValue, Known, Platform, SessionFacts, SessionKind};

    #[tokio::test]
    async fn appends_both_files() {
        let dir = std::env::temp_dir().join(format!("netstacks-guard-test-{}", uuid::Uuid::new_v4()));
        let stack = ContextStack::new();
        let intent = parse("reload", &stack, "sw", Platform::IosXe);
        let facts = SessionFacts {
            path_objects: FactValue { value: Known::Unknown, source: "none".into(), age_secs: 0 },
            stp_has_alternate: FactValue { value: Known::Unknown, source: "none".into(), age_secs: 0 },
        };
        let ev = evaluate(&intent, &facts, SessionKind::Human);
        let rec = TraceRecord::new(intent, ev, SessionKind::Human);

        let p = append_trace_to(&dir, &rec).await.unwrap();
        append_trace_to(&dir, &rec).await.unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text.matches("evaluation ").count(), 2);
        let jsonl = std::fs::read_to_string(dir.join("trace.jsonl")).unwrap();
        assert_eq!(jsonl.lines().count(), 2);
        assert!(jsonl.contains("system.reload") || jsonl.contains("SystemReload"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
