use std::path::PathBuf;
use super::types::*;

pub struct GitOps {
    cwd: PathBuf,
}

impl GitOps {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }

    /// Clone a git repository to a destination path.
    /// This is an associated function (no &self) since the repo doesn't exist yet.
    pub async fn clone_repo(url: &str, destination: &str) -> Result<(), GitError> {
        let output = tokio::process::Command::new("git")
            .args(["clone", url, destination])
            .output()
            .await
            .map_err(GitError::Io)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }
}

impl GitOps {
    async fn run(&self, args: &[&str]) -> Result<String, GitError> {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(&self.cwd)
            .output()
            .await
            .map_err(GitError::Io)?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    pub async fn is_repo(&self) -> bool {
        self.run(&["rev-parse", "--is-inside-work-tree"]).await.is_ok()
    }

    pub async fn status(&self) -> Result<Vec<GitFileStatus>, GitError> {
        let output = self.run(&["status", "--porcelain"]).await?;
        Ok(parse_status_output(&output))
    }

    pub async fn branch_info(&self) -> Result<Option<GitBranchInfo>, GitError> {
        let output = self.run(&["status", "--branch", "--porcelain"]).await?;
        Ok(parse_branch_output(&output))
    }

    pub async fn diff(&self, file_path: Option<&str>) -> Result<String, GitError> {
        self.diff_with_options(file_path, false).await
    }

    /// `staged=true` adds `--cached` so the diff reflects what will be committed
    /// (vs. the working-tree changes that haven't been `git add`-ed yet).
    pub async fn diff_with_options(
        &self,
        file_path: Option<&str>,
        staged: bool,
    ) -> Result<String, GitError> {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        if let Some(p) = file_path {
            args.push("--");
            args.push(p);
        }
        self.run(&args).await
    }

    pub async fn log(&self, limit: usize, file_path: Option<&str>) -> Result<Vec<CommitInfo>, GitError> {
        let limit_str = limit.to_string();
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(&self.cwd);
        cmd.args([
            "log",
            "--format=%H\x1f%h\x1f%s\x1f%an\x1f%aI\x1f%D",
            "-n",
            &limit_str,
        ]);
        if let Some(p) = file_path {
            cmd.args(["--", p]);
        }
        let output = cmd.output().await.map_err(GitError::Io)?;
        if !output.status.success() {
            return Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_log_output(&stdout))
    }

    pub async fn blame(&self, file_path: &str) -> Result<Vec<BlameLine>, GitError> {
        let output = self.run(&["blame", "--porcelain", file_path]).await?;
        Ok(parse_blame_output(&output))
    }

    // Task 5: Stage, Unstage, Revert, Commit
    pub async fn stage(&self, paths: &[&str]) -> Result<(), GitError> {
        if paths.is_empty() {
            self.run(&["add", "-A"]).await?;
        } else {
            let mut args = vec!["add", "--"];
            args.extend_from_slice(paths);
            self.run(&args).await?;
        }
        Ok(())
    }

    pub async fn unstage(&self, paths: &[&str]) -> Result<(), GitError> {
        if paths.is_empty() {
            self.run(&["reset", "HEAD"]).await?;
        } else {
            let mut args = vec!["reset", "HEAD", "--"];
            args.extend_from_slice(paths);
            self.run(&args).await?;
        }
        Ok(())
    }

    pub async fn revert(&self, paths: &[&str]) -> Result<(), GitError> {
        let mut args = vec!["checkout", "HEAD", "--"];
        args.extend_from_slice(paths);
        self.run(&args).await?;
        Ok(())
    }

    pub async fn commit(&self, message: &str, paths: &[&str]) -> Result<CommitInfo, GitError> {
        if !paths.is_empty() {
            self.stage(paths).await?;
        }
        self.run(&["commit", "-m", message]).await?;
        let commits = self.log(1, None).await?;
        commits.into_iter().next().ok_or_else(|| GitError::CommandFailed("no commit after git commit".into()))
    }

    // Task 6: Push, Pull, Fetch
    pub async fn push(&self, force: bool) -> Result<(), GitError> {
        let branch_info = self.branch_info().await?;
        let branch_name = branch_info.map(|b| b.name).unwrap_or_else(|| "HEAD".into());

        let mut args = vec!["push".to_string()];
        if force {
            args.push("--force-with-lease".to_string());
        }
        args.extend_from_slice(&["--set-upstream".to_string(), "origin".to_string(), branch_name]);

        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(&self.cwd);
        for arg in &args {
            cmd.arg(arg);
        }
        let output = cmd.output().await.map_err(GitError::Io)?;
        if !output.status.success() {
            return Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        Ok(())
    }

    pub async fn pull(&self, rebase: bool) -> Result<(), GitError> {
        if rebase {
            self.run(&["pull", "--rebase"]).await?;
        } else {
            self.run(&["pull"]).await?;
        }
        Ok(())
    }

    pub async fn fetch(&self) -> Result<(), GitError> {
        self.run(&["fetch", "origin", "--prune"]).await?;
        Ok(())
    }

    // Task 7: Branch Management
    pub async fn list_branches(&self) -> Result<Vec<BranchEntry>, GitError> {
        let local = self
            .run(&[
                "branch",
                "--format=%(refname:short)|||%(upstream:short)|||%(HEAD)",
                "--no-color",
            ])
            .await?;

        let remote = self
            .run(&["branch", "-r", "--format=%(refname:short)", "--no-color"])
            .await
            .unwrap_or_default();

        let mut entries: Vec<BranchEntry> = local
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.splitn(3, "|||").collect();
                let name = parts.first().unwrap_or(&"").to_string();
                let upstream = parts
                    .get(1)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let is_current = parts.get(2).map(|s| s.trim() == "*").unwrap_or(false);
                BranchEntry { name, is_current, is_remote: false, upstream }
            })
            .collect();

        let remotes: Vec<BranchEntry> = remote
            .lines()
            .filter(|l| !l.is_empty() && !l.contains("HEAD ->"))
            .map(|name| BranchEntry {
                name: name.trim().to_string(),
                is_current: false,
                is_remote: true,
                upstream: None,
            })
            .collect();

        entries.extend(remotes);
        Ok(entries)
    }

    pub async fn create_branch(&self, name: &str, from: Option<&str>) -> Result<(), GitError> {
        if let Some(base) = from {
            self.run(&["checkout", "-b", name, base]).await?;
        } else {
            self.run(&["checkout", "-b", name]).await?;
        }
        Ok(())
    }

    pub async fn switch_branch(&self, name: &str) -> Result<(), GitError> {
        self.run(&["checkout", name]).await?;
        Ok(())
    }

    pub async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        if force {
            self.run(&["branch", "-D", name]).await?;
        } else {
            self.run(&["branch", "-d", name]).await?;
        }
        Ok(())
    }

    pub async fn merge(&self, branch: &str) -> Result<(), GitError> {
        self.run(&["merge", "--no-ff", branch]).await?;
        Ok(())
    }

    // Task 8: Stash, ListStashes, Init
    pub async fn stash(&self, action: &str, index: Option<usize>) -> Result<(), GitError> {
        match action {
            "push" => {
                self.run(&["stash", "push"]).await?;
            }
            "pop" => {
                if let Some(i) = index {
                    let ref_str = format!("stash@{{{}}}", i);
                    self.run(&["stash", "pop", &ref_str]).await?;
                } else {
                    self.run(&["stash", "pop"]).await?;
                }
            }
            "drop" => {
                if let Some(i) = index {
                    let ref_str = format!("stash@{{{}}}", i);
                    self.run(&["stash", "drop", &ref_str]).await?;
                } else {
                    self.run(&["stash", "drop"]).await?;
                }
            }
            _ => {
                return Err(GitError::CommandFailed(format!(
                    "Unknown stash action: {}",
                    action
                )))
            }
        }
        Ok(())
    }

    pub async fn list_stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        let output = self
            .run(&["stash", "list", "--format=%gd|||%gs"])
            .await
            .unwrap_or_default();
        Ok(output
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.is_empty())
            .map(|(i, line)| {
                let parts: Vec<&str> = line.splitn(2, "|||").collect();
                let branch = parts.first()
                    .unwrap_or(&"")
                    .trim_start_matches("stash@{")
                    .trim_end_matches('}')
                    .to_string();
                let message = parts.get(1).unwrap_or(&line).to_string();
                StashEntry { index: i, message, branch }
            })
            .collect())
    }

    pub async fn init(&self) -> Result<(), GitError> {
        self.run(&["init"]).await?;
        Ok(())
    }

    // Task 9: Commit Amend and Rebase
    pub async fn commit_amend(&self, message: &str) -> Result<CommitInfo, GitError> {
        self.run(&["commit", "--amend", "-m", message]).await?;
        let output = self.run(&[
            "log", "-1", "--format=%H\x1f%h\x1f%s\x1f%an\x1f%aI\x1f%D"
        ]).await?;
        parse_log_output(&output)
            .into_iter()
            .next()
            .ok_or_else(|| GitError::CommandFailed("No commit after amend".into()))
    }

    pub async fn rebase_plan(&self, n: usize) -> Result<Vec<CommitInfo>, GitError> {
        let output = self.run(&[
            "log", &format!("-{}", n),
            "--format=%H\x1f%h\x1f%s\x1f%an\x1f%aI\x1f%D",
            "--reverse"
        ]).await?;
        Ok(parse_log_output(&output))
    }

    pub async fn rebase_apply(&self, base_hash: &str, plan: &[RebasePlanItem]) -> Result<(), GitError> {
        // base_hash is passed to `git rebase -i` and the plan hashes are written
        // into the rebase todo — where a forged `exec <cmd>` line would run as a
        // shell command. Restricting both to hex (commit ids always are) defeats
        // git-option injection and rebase-todo injection alike.
        let is_hex = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit());
        if !is_hex(base_hash) {
            return Err(GitError::CommandFailed("Invalid base commit hash".into()));
        }

        // Build the todo list for interactive rebase
        let mut todo = String::new();
        for item in plan {
            if !is_hex(&item.hash) {
                return Err(GitError::CommandFailed("Invalid commit hash in rebase plan".into()));
            }
            match item.action.as_str() {
                "pick" => todo.push_str(&format!("pick {}\n", item.hash)),
                "squash" => todo.push_str(&format!("squash {}\n", item.hash)),
                "drop" => todo.push_str(&format!("drop {}\n", item.hash)),
                _ => return Err(GitError::CommandFailed(format!("Unknown action: {}", item.action))),
            }
        }

        // Write todo to a temp file
        let todo_path = self.cwd.join(".git").join("netstacks-rebase-todo");
        tokio::fs::write(&todo_path, &todo).await.map_err(GitError::Io)?;

        // Run rebase with a GIT_SEQUENCE_EDITOR that overwrites git's todo with
        // ours. The editor command is a FIXED string; the todo path is passed as
        // an environment-variable VALUE (the shell reads it as data via
        // "$NS_REBASE_TODO", never parses it as command text), so a hostile
        // workspace path cannot inject. git invokes `<editor> <todo>`, so the
        // todo file git generated lands in $0.
        let output = tokio::process::Command::new("git")
            .args(["rebase", "-i", base_hash])
            .current_dir(&self.cwd)
            .env("GIT_SEQUENCE_EDITOR", r#"sh -c 'cat "$NS_REBASE_TODO" > "$0"'"#)
            .env("NS_REBASE_TODO", &todo_path)
            .output()
            .await
            .map_err(GitError::Io)?;

        // Clean up
        let _ = tokio::fs::remove_file(&todo_path).await;

        if output.status.success() {
            Ok(())
        } else {
            Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    pub async fn rebase_abort(&self) -> Result<(), GitError> {
        self.run(&["rebase", "--abort"]).await?;
        Ok(())
    }

    pub async fn generate_commit_message(&self) -> Result<String, GitError> {
        let diff = self.diff(None).await?;
        if diff.trim().is_empty() {
            return Ok("No changes to describe".to_string());
        }
        // Simple heuristic: extract file names and change types from diff
        let mut files_changed = Vec::new();
        for line in diff.lines() {
            if line.starts_with("diff --git") {
                if let Some(path) = line.split(" b/").last() {
                    files_changed.push(path.to_string());
                }
            }
        }
        let additions = diff.lines().filter(|l| l.starts_with('+')).count();
        let deletions = diff.lines().filter(|l| l.starts_with('-')).count();

        let file_list = if files_changed.len() <= 3 {
            files_changed.join(", ")
        } else {
            format!("{} and {} other files", files_changed[..2].join(", "), files_changed.len() - 2)
        };

        let message = format!("Update {}\n\n{} additions, {} deletions", file_list, additions, deletions);
        Ok(message)
    }
}

fn parse_status_output(output: &str) -> Vec<GitFileStatus> {
    output
        .lines()
        .filter(|l| l.len() >= 4)
        .map(|line| {
            let x = &line[0..1];
            let y = &line[1..2];
            let rest = &line[3..];
            let parts: Vec<&str> = rest.splitn(2, " -> ").collect();
            let path = parts.last().unwrap_or(&rest).trim().to_string();
            let old_path = if parts.len() > 1 {
                Some(parts[0].trim().to_string())
            } else {
                None
            };
            let (status, staged) = parse_status_code(x, y);
            GitFileStatus { path, status, staged, old_path }
        })
        .collect()
}

fn parse_status_code(x: &str, y: &str) -> (String, bool) {
    match (x, y) {
        ("?", "?") => ("untracked".into(), false),
        ("A", _) => ("added".into(), true),
        ("D", _) => ("deleted".into(), true),
        ("R", _) => ("renamed".into(), true),
        ("C", _) => ("copied".into(), true),
        ("M", _) => ("modified".into(), true),
        (_, "M") => ("modified".into(), false),
        (_, "D") => ("deleted".into(), false),
        _ => ("modified".into(), x != " "),
    }
}

fn parse_log_output(output: &str) -> Vec<CommitInfo> {
    output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(6, '\x1f').collect();
            let branches = parts
                .get(5)
                .map(|r| {
                    r.split(", ")
                        .filter(|s| !s.is_empty())
                        .map(|s| s.trim_start_matches("HEAD -> ").to_string())
                        .collect()
                })
                .unwrap_or_default();
            CommitInfo {
                hash: parts.first().unwrap_or(&"").to_string(),
                short_hash: parts.get(1).unwrap_or(&"").to_string(),
                message: parts.get(2).unwrap_or(&"").to_string(),
                author: parts.get(3).unwrap_or(&"").to_string(),
                date: parts.get(4).unwrap_or(&"").to_string(),
                branches,
            }
        })
        .collect()
}

fn parse_blame_output(output: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    let mut current_hash = String::new();
    let mut current_author = String::new();
    let mut current_date = String::new();
    let mut current_line_no: usize = 0;

    for line in output.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            lines.push(BlameLine {
                line_number: current_line_no,
                hash: current_hash[..7.min(current_hash.len())].to_string(),
                author: current_author.clone(),
                date: current_date.clone(),
                content: content.to_string(),
            });
        } else if line.starts_with("author ") && !line.starts_with("author-") {
            current_author = line[7..].to_string();
        } else if let Some(time) = line.strip_prefix("author-time ") {
            current_date = time.to_string();
        } else {
            let parts: Vec<&str> = line.splitn(4, ' ').collect();
            if parts.len() >= 3 && parts[0].len() == 40 {
                current_hash = parts[0].to_string();
                current_line_no = parts[2].parse().unwrap_or(0);
            }
        }
    }
    lines
}

fn parse_branch_output(output: &str) -> Option<GitBranchInfo> {
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // ## main...origin/main [ahead 2, behind 1]
            let (name_part, tracking) = rest.split_once("...").unwrap_or((rest, ""));
            let name = name_part.trim().to_string();
            let ahead = tracking
                .find("ahead ")
                .and_then(|i| tracking[i + 6..].split_once(|c: char| !c.is_ascii_digit()))
                .and_then(|(n, _)| n.parse().ok())
                .unwrap_or(0);
            let behind = tracking
                .find("behind ")
                .and_then(|i| tracking[i + 7..].split_once(|c: char| !c.is_ascii_digit()))
                .and_then(|(n, _)| n.parse().ok())
                .unwrap_or(0);
            let upstream = if tracking.is_empty() {
                None
            } else {
                Some(tracking.split_whitespace().next().unwrap_or("").to_string())
            };
            return Some(GitBranchInfo { name, ahead, behind, upstream });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn make_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        Command::new("git").args(["init"]).current_dir(p).status().unwrap();
        Command::new("git").args(["config", "user.email", "t@t.com"]).current_dir(p).status().unwrap();
        Command::new("git").args(["config", "user.name", "Test"]).current_dir(p).status().unwrap();
        std::fs::write(p.join("a.txt"), "hello").unwrap();
        Command::new("git").args(["add", "."]).current_dir(p).status().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(p).status().unwrap();
        dir
    }

    #[tokio::test]
    async fn test_is_repo_true() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        assert!(ops.is_repo().await);
    }

    #[tokio::test]
    async fn test_is_repo_false() {
        let dir = TempDir::new().unwrap();
        let ops = GitOps::new(dir.path());
        assert!(!ops.is_repo().await);
    }

    #[tokio::test]
    async fn test_status_clean() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let files = ops.status().await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_status_modified() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "changed").unwrap();
        let ops = GitOps::new(dir.path());
        let files = ops.status().await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, "modified");
        assert!(!files[0].staged);
    }

    #[tokio::test]
    async fn test_branch_info() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let branch = ops.branch_info().await.unwrap();
        assert!(branch.is_some());
        let b = branch.unwrap();
        assert!(!b.name.is_empty());
        assert_eq!(b.ahead, 0);
        assert_eq!(b.behind, 0);
    }

    #[tokio::test]
    async fn test_diff_empty_when_clean() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let d = ops.diff(None).await.unwrap();
        assert!(d.is_empty());
    }

    #[tokio::test]
    async fn test_diff_shows_change() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "changed").unwrap();
        let ops = GitOps::new(dir.path());
        let d = ops.diff(None).await.unwrap();
        assert!(d.contains("changed"));
    }

    #[tokio::test]
    async fn test_log_returns_commits() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let commits = ops.log(10, None).await.unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].message, "init");
        assert!(!commits[0].hash.is_empty());
        assert_eq!(commits[0].short_hash.len(), 7);
    }

    #[tokio::test]
    async fn test_blame_returns_lines() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let lines = ops.blame("a.txt").await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].content, "hello");
        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[0].author, "Test");
    }

    // Task 5 tests
    #[tokio::test]
    async fn test_stage_and_commit() {
        let dir = make_repo();
        std::fs::write(dir.path().join("b.txt"), "new file").unwrap();
        let ops = GitOps::new(dir.path());

        let files = ops.status().await.unwrap();
        assert_eq!(files[0].status, "untracked");

        ops.stage(&["b.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files[0].staged);

        let commit = ops.commit("add b.txt", &[]).await.unwrap();
        assert_eq!(commit.message, "add b.txt");

        let files = ops.status().await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_unstage() {
        let dir = make_repo();
        std::fs::write(dir.path().join("c.txt"), "c").unwrap();
        let ops = GitOps::new(dir.path());
        ops.stage(&["c.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files[0].staged);

        ops.unstage(&["c.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(!files[0].staged);
    }

    #[tokio::test]
    async fn test_revert() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "modified").unwrap();
        let ops = GitOps::new(dir.path());
        let files = ops.status().await.unwrap();
        assert_eq!(files[0].status, "modified");

        ops.revert(&["a.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_revert_staged_file() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "staged change").unwrap();
        let ops = GitOps::new(dir.path());
        ops.stage(&["a.txt"]).await.unwrap();

        // Verify file is staged
        let files = ops.status().await.unwrap();
        assert!(files[0].staged);

        // Revert should discard staged and working changes
        ops.revert(&["a.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files.is_empty(), "revert should discard staged changes");
    }

    // Task 6 tests
    #[tokio::test]
    async fn test_push_fails_without_remote() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let result = ops.push(false).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string().to_lowercase();
        assert!(msg.contains("remote") || msg.contains("origin") || msg.contains("git error"));
    }

    #[tokio::test]
    async fn test_fetch_fails_without_remote() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let result = ops.fetch().await;
        assert!(result.is_err());
    }

    // Task 7 tests
    #[tokio::test]
    async fn test_list_branches() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let branches = ops.list_branches().await.unwrap();
        assert_eq!(branches.len(), 1);
        assert!(branches[0].is_current);
        assert!(!branches[0].is_remote);
    }

    #[tokio::test]
    async fn test_create_and_switch_branch() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        ops.create_branch("feature/test", None).await.unwrap();

        let branches = ops.list_branches().await.unwrap();
        assert!(branches.iter().any(|b| b.name == "feature/test"));

        ops.switch_branch("feature/test").await.unwrap();
        let info = ops.branch_info().await.unwrap().unwrap();
        assert_eq!(info.name, "feature/test");
    }

    #[tokio::test]
    async fn test_delete_branch() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        ops.create_branch("to-delete", None).await.unwrap();
        ops.switch_branch("to-delete").await.unwrap();
        // Switch back to main/master first
        let main_branch = {
            std::process::Command::new("git")
                .args(["config", "init.defaultBranch"])
                .current_dir(dir.path())
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_else(|_| "main".into())
        };
        let default = if main_branch.is_empty() { "master".to_string() } else { main_branch };
        ops.switch_branch(&default).await.unwrap();
        ops.delete_branch("to-delete", false).await.unwrap();
        let branches = ops.list_branches().await.unwrap();
        assert!(!branches.iter().any(|b| b.name == "to-delete"));
    }

    #[tokio::test]
    async fn test_merge_branch() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        ops.create_branch("feature/merge-test", None).await.unwrap();
        ops.switch_branch("feature/merge-test").await.unwrap();
        std::fs::write(dir.path().join("merged.txt"), "merged content").unwrap();
        ops.stage(&["merged.txt"]).await.unwrap();
        ops.commit("add merged.txt", &[]).await.unwrap();

        let main_branch = {
            std::process::Command::new("git")
                .args(["config", "init.defaultBranch"])
                .current_dir(dir.path())
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_else(|_| "main".into())
        };
        let default = if main_branch.is_empty() { "master".to_string() } else { main_branch };
        ops.switch_branch(&default).await.unwrap();
        ops.merge("feature/merge-test").await.unwrap();

        let log = ops.log(10, None).await.unwrap();
        assert!(log.iter().any(|c| c.message == "add merged.txt"));
    }

    // Task 8 tests
    #[tokio::test]
    async fn test_stash_push_and_pop() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "stashed change").unwrap();
        let ops = GitOps::new(dir.path());

        let files = ops.status().await.unwrap();
        assert!(!files.is_empty());

        ops.stash("push", None).await.unwrap();

        let files = ops.status().await.unwrap();
        assert!(files.is_empty());

        let stashes = ops.list_stashes().await.unwrap();
        assert_eq!(stashes.len(), 1);

        ops.stash("pop", Some(0)).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(!files.is_empty());
    }

    #[tokio::test]
    async fn test_init_non_repo() {
        let dir = tempfile::TempDir::new().unwrap();
        let ops = GitOps::new(dir.path());
        assert!(!ops.is_repo().await);
        ops.init().await.unwrap();
        assert!(ops.is_repo().await);
    }
}
