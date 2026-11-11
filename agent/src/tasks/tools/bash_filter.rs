//! Bash command filter for AI safety enforcement
//!
//! Deny-list approach: everything is allowed EXCEPT explicitly dangerous
//! commands. Pipes and redirects are permitted. The deny list is
//! configurable via `ai.bash.deniedCommands` settings.
//!
//! This filter runs at the execution level (backend), not in the prompt.
//! The AI cannot override it.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, thiserror::Error)]
pub enum BashFilterError {
    #[error("Blocked command '{command}': {reason}")]
    Blocked { command: String, reason: String },
}

pub struct BashCommandFilter {
    extra_denied: Vec<String>,
}

struct DeniedPattern {
    regex: Regex,
    reason: &'static str,
}

fn get_denied_patterns() -> &'static Vec<DeniedPattern> {
    static PATTERNS: OnceLock<Vec<DeniedPattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            // --- Injection prevention (blocked ANYWHERE) ---
            DeniedPattern {
                regex: Regex::new(r"[\r\n]").unwrap(),
                reason: "Multi-line commands are not allowed (newline injection)",
            },

            // --- Destructive file operations ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*rm\b").unwrap(),
                reason: "rm can delete files and directories",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*rmdir\b").unwrap(),
                reason: "rmdir removes directories",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*shred\b").unwrap(),
                reason: "shred securely destroys files",
            },

            // --- Disk/filesystem destruction ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*mkfs\b").unwrap(),
                reason: "mkfs formats filesystems",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*fdisk\b").unwrap(),
                reason: "fdisk modifies disk partitions",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*parted\b").unwrap(),
                reason: "parted modifies disk partitions",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*dd\b").unwrap(),
                reason: "dd can overwrite disks and devices",
            },

            // --- System power/init ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*shutdown\b").unwrap(),
                reason: "shutdown powers off or reboots the system",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*reboot\b").unwrap(),
                reason: "reboot restarts the system",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*poweroff\b").unwrap(),
                reason: "poweroff shuts down the system",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*halt\b").unwrap(),
                reason: "halt stops the system",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*init\s+[0-6]\b").unwrap(),
                reason: "init changes system runlevel",
            },

            // --- Process killing ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*kill\b").unwrap(),
                reason: "kill terminates processes",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*killall\b").unwrap(),
                reason: "killall terminates processes by name",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*pkill\b").unwrap(),
                reason: "pkill terminates processes by pattern",
            },

            // --- Privilege escalation ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*sudo\b").unwrap(),
                reason: "sudo runs commands with elevated privileges",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*su\b").unwrap(),
                reason: "su switches to another user",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*doas\b").unwrap(),
                reason: "doas runs commands with elevated privileges",
            },

            // --- User/group management ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*passwd\b").unwrap(),
                reason: "passwd changes user passwords",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*useradd\b").unwrap(),
                reason: "useradd creates system users",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*userdel\b").unwrap(),
                reason: "userdel removes system users",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*usermod\b").unwrap(),
                reason: "usermod modifies system users",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*groupadd\b").unwrap(),
                reason: "groupadd creates system groups",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*groupdel\b").unwrap(),
                reason: "groupdel removes system groups",
            },

            // --- Permission changes ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*chmod\b").unwrap(),
                reason: "chmod changes file permissions",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*chown\b").unwrap(),
                reason: "chown changes file ownership",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*chgrp\b").unwrap(),
                reason: "chgrp changes file group ownership",
            },

            // --- Mount/unmount ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*mount\b").unwrap(),
                reason: "mount attaches filesystems",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*umount\b").unwrap(),
                reason: "umount detaches filesystems",
            },

            // --- Firewall ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*iptables\b").unwrap(),
                reason: "iptables modifies firewall rules",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*ip6tables\b").unwrap(),
                reason: "ip6tables modifies IPv6 firewall rules",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*nft\b").unwrap(),
                reason: "nft modifies nftables firewall rules",
            },
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*firewall-cmd\b").unwrap(),
                reason: "firewall-cmd modifies firewalld rules",
            },

            // --- systemctl destructive subcommands ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*systemctl\s+(stop|disable|mask|unmask|enable|start|restart|reload|kill|reset-failed|set-default)\b").unwrap(),
                reason: "systemctl service modification commands are not allowed (use 'systemctl status' or 'systemctl list-units' instead)",
            },

            // --- crontab modification ---
            DeniedPattern {
                regex: Regex::new(r"(?i)^\s*crontab\s+-(r|e)\b").unwrap(),
                reason: "crontab -r/-e modifies scheduled tasks",
            },
        ]
    })
}

impl BashCommandFilter {
    pub fn new() -> Self {
        Self {
            extra_denied: Vec::new(),
        }
    }

    pub fn with_extra_denied(mut self, patterns: Vec<String>) -> Self {
        self.extra_denied = patterns;
        self
    }

    pub fn is_allowed(&self, command: &str) -> Result<(), BashFilterError> {
        let trimmed = command.trim();

        if trimmed.is_empty() {
            return Err(BashFilterError::Blocked {
                command: trimmed.to_string(),
                reason: "Empty command".to_string(),
            });
        }

        // Check built-in deny patterns
        for pattern in get_denied_patterns() {
            if pattern.regex.is_match(trimmed) {
                return Err(BashFilterError::Blocked {
                    command: trimmed.to_string(),
                    reason: pattern.reason.to_string(),
                });
            }
        }

        // Check user-configured extra deny patterns
        let lower = trimmed.to_lowercase();
        for denied in &self.extra_denied {
            let denied_lower = denied.to_lowercase().trim().to_string();
            if !denied_lower.is_empty() && lower.starts_with(&denied_lower) {
                return Err(BashFilterError::Blocked {
                    command: trimmed.to_string(),
                    reason: format!("Blocked by user-configured deny rule: {}", denied),
                });
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_safe_commands() {
        let filter = BashCommandFilter::new();
        let safe = vec![
            "ls -la",
            "cat /etc/hosts",
            "grep -r 'pattern' .",
            "find . -name '*.txt'",
            "ping -c 4 8.8.8.8",
            "dig google.com",
            "curl -s https://example.com",
            "python3 script.py",
            "git status",
            "docker ps",
            "echo hello",
            "df -h",
            "du -sh /tmp",
            "uname -a",
            "whoami",
            "date",
            "uptime",
            "jq '.key' file.json",
            "head -n 10 file.txt",
            "tail -f /var/log/syslog",
            "wc -l file.txt",
            "sort file.txt | uniq -c",
            "ip addr show",
            "ss -tlnp",
            "traceroute 8.8.8.8",
            "nslookup google.com",
            "systemctl status nginx",
            "systemctl list-units",
            "crontab -l",
        ];
        for cmd in safe {
            assert!(filter.is_allowed(cmd).is_ok(), "Should allow: {}", cmd);
        }
    }

    #[test]
    fn blocks_destructive_commands() {
        let filter = BashCommandFilter::new();
        let dangerous = vec![
            "rm -rf /",
            "rm file.txt",
            "rmdir /tmp/dir",
            "shred /dev/sda",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            "shutdown -h now",
            "reboot",
            "poweroff",
            "halt",
            "init 0",
            "kill -9 1234",
            "killall nginx",
            "pkill -f python",
            "sudo ls",
            "su - root",
            "doas ls",
            "passwd root",
            "useradd hacker",
            "userdel admin",
            "chmod 777 /etc/shadow",
            "chown root:root /tmp",
            "mount /dev/sda1 /mnt",
            "umount /mnt",
            "iptables -F",
            "firewall-cmd --add-port=22/tcp",
            "systemctl stop nginx",
            "systemctl disable sshd",
            "systemctl restart docker",
            "crontab -r",
            "crontab -e",
            "fdisk /dev/sda",
        ];
        for cmd in dangerous {
            assert!(filter.is_allowed(cmd).is_err(), "Should block: {}", cmd);
        }
    }

    #[test]
    fn blocks_newline_injection() {
        let filter = BashCommandFilter::new();
        assert!(filter.is_allowed("ls\nrm -rf /").is_err());
        assert!(filter.is_allowed("echo hello\r\nshutdown").is_err());
    }

    #[test]
    fn allows_pipes_and_redirects() {
        let filter = BashCommandFilter::new();
        assert!(filter.is_allowed("ls -la | grep txt").is_ok());
        assert!(filter.is_allowed("cat file.txt | sort | uniq > output.txt").is_ok());
        assert!(filter.is_allowed("echo hello >> log.txt").is_ok());
        assert!(filter.is_allowed("grep pattern file.txt | wc -l").is_ok());
    }

    #[test]
    fn extra_denied_patterns_work() {
        let filter = BashCommandFilter::new()
            .with_extra_denied(vec!["wget".to_string(), "nc ".to_string()]);
        assert!(filter.is_allowed("wget https://evil.com").is_err());
        assert!(filter.is_allowed("nc -l 4444").is_err());
        assert!(filter.is_allowed("curl https://safe.com").is_ok());
    }

    #[test]
    fn case_insensitive() {
        let filter = BashCommandFilter::new();
        assert!(filter.is_allowed("RM -rf /").is_err());
        assert!(filter.is_allowed("Sudo ls").is_err());
        assert!(filter.is_allowed("SHUTDOWN -h now").is_err());
    }

    #[test]
    fn empty_command_blocked() {
        let filter = BashCommandFilter::new();
        assert!(filter.is_allowed("").is_err());
        assert!(filter.is_allowed("   ").is_err());
    }
}
