//! AI Engineer Profile — stores user preferences and compiles prompt segments.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::knowledge_packs;
use super::safety::SAFETY_RULES;

/// Feature types that determine which segments get loaded.
///
/// Each variant controls how much of the AI Engineer Profile gets injected
/// into the system prompt — Chat gets everything, Agents skip identity,
/// ScriptGeneration gets lean packs, etc.
#[derive(Debug, Clone, Copy, Default)]
pub enum AiFeature {
    #[default]
    Chat,
    Agents,
    ScriptGeneration,
}

/// AI Engineer Profile stored in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiEngineerProfile {
    pub id: i64,
    pub name: Option<String>,
    pub behavior_mode: Option<String>,
    pub autonomy_level: Option<String>,
    pub vendor_weights: HashMap<String, f64>,
    pub domain_focus: HashMap<String, f64>,
    pub cert_perspective: Option<String>,
    pub verbosity: Option<String>,
    pub risk_tolerance: Option<String>,
    pub troubleshooting_method: Option<String>,
    pub syntax_style: Option<String>,
    pub user_experience_level: Option<String>,
    pub environment_type: Option<String>,
    pub safety_rules: Vec<String>,
    pub communication_style: Option<String>,
    pub onboarding_completed: bool,
}

impl Default for AiEngineerProfile {
    fn default() -> Self {
        Self {
            id: 0,
            name: None,
            behavior_mode: Some("assistant".to_string()),
            autonomy_level: Some("suggest".to_string()),
            vendor_weights: HashMap::new(),
            domain_focus: HashMap::new(),
            cert_perspective: Some("vendor-neutral".to_string()),
            verbosity: Some("balanced".to_string()),
            risk_tolerance: Some("conservative".to_string()),
            troubleshooting_method: Some("top-down".to_string()),
            syntax_style: Some("full".to_string()),
            user_experience_level: Some("mid".to_string()),
            environment_type: Some("production".to_string()),
            safety_rules: Vec::new(),
            communication_style: None,
            onboarding_completed: false,
        }
    }
}

impl AiEngineerProfile {
    /// Get domain weights sorted by weight descending.
    pub fn domain_focus_sorted(&self) -> Vec<(String, f64)> {
        let mut sorted: Vec<_> = self.domain_focus.iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        sorted
    }

    /// Get vendor weights sorted by weight descending.
    pub fn vendor_weights_sorted(&self) -> Vec<(String, f64)> {
        let mut sorted: Vec<_> = self.vendor_weights.iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        sorted
    }

    /// Compile the identity segment.
    fn compile_identity(&self) -> Option<String> {
        let name = self.name.as_deref()?;
        let mode_desc = match self.behavior_mode.as_deref() {
            Some("assistant") => "a helpful assistant — answers questions, waits to be asked, explains clearly",
            Some("coworker") => "a coworker — proactive, takes ownership, reports back when done",
            Some("mentor") => "a mentor — teaches as you work, explains the why behind everything",
            Some("silent") => "a silent partner — minimal chatter, just does the job",
            _ => "a network engineer",
        };
        let verbosity_desc = match self.verbosity.as_deref() {
            Some("terse") => "Communication: terse and direct, minimal explanation unless asked.",
            Some("detailed") => "Communication: detailed and thorough, walk through reasoning.",
            _ => "Communication: balanced — concise but clear.",
        };
        Some(format!(
            "You are {}, a CCIE-level network engineer. You are {}.\n{}",
            name, mode_desc, verbosity_desc
        ))
    }

    /// Compile the expertise segment.
    fn compile_expertise(&self) -> Option<String> {
        let mut parts = Vec::new();

        if !self.vendor_weights.is_empty() {
            let vendors: Vec<String> = self.vendor_weights_sorted().iter()
                .map(|(k, v)| format!("{} ({:.0}%)", capitalize(k), v * 100.0))
                .collect();
            parts.push(format!("Primary expertise: {}.", vendors.join(", ")));
        }

        if !self.domain_focus.is_empty() {
            let domains: Vec<String> = self.domain_focus_sorted().iter()
                .filter(|(_, v)| *v > 0.3)
                .map(|(k, _)| k.replace('_', " "))
                .collect();
            if !domains.is_empty() {
                parts.push(format!("Focus: {}.", domains.join(", ")));
            }
        }

        if let Some(cert) = &self.cert_perspective {
            if cert != "vendor-neutral" {
                parts.push(format!("Think like a {}.", cert.to_uppercase()));
            }
        }

        if let Some(env) = &self.environment_type {
            parts.push(format!("Environment: {}.", env));
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" "))
        }
    }

    /// Compile the behavior segment.
    fn compile_behavior(&self) -> Option<String> {
        let mut parts = Vec::new();

        let autonomy = match self.autonomy_level.as_deref() {
            Some("inform") => "Autonomy: inform only — describe findings, do not suggest fixes unless asked.",
            Some("act") => "Autonomy: act — fix issues proactively, report what was done.",
            _ => "Autonomy: suggest fixes and wait for approval before acting.",
        };
        parts.push(autonomy.to_string());

        if let Some(method) = &self.troubleshooting_method {
            parts.push(format!("Troubleshooting: {} methodology.", method));
        }

        let risk = match self.risk_tolerance.as_deref() {
            Some("aggressive") => "Risk: willing to try faster approaches when downtime impact is low.",
            Some("moderate") => "Risk: balanced — weigh speed vs safety per situation.",
            _ => "Risk: conservative — always verify before changing.",
        };
        parts.push(risk.to_string());

        if !self.safety_rules.is_empty() {
            for rule in &self.safety_rules {
                parts.push(format!("Safety: {}", rule));
            }
        }

        Some(parts.join("\n"))
    }

    /// Compile prompt segments for a specific AI feature.
    ///
    /// Returns the full system prompt prefix including safety rules,
    /// identity, expertise, behavior, and knowledge packs — assembled
    /// based on what the feature needs and the available token budget.
    pub fn compile_for_feature(&self, feature: AiFeature, max_context_chars: usize) -> String {
        let mut segments = Vec::new();

        // Layer 0: Safety rules — always first, always present
        segments.push(SAFETY_RULES.to_string());

        // Determine budget for knowledge packs
        // Reserve chars for safety rules + profile segments (~3000 chars buffer)
        let pack_budget = max_context_chars.saturating_sub(3000);

        match feature {
            AiFeature::Chat => {
                // Chat gets everything: identity + expertise + behavior + knowledge packs
                if let Some(identity) = self.compile_identity() {
                    segments.push(identity);
                }
                if let Some(expertise) = self.compile_expertise() {
                    segments.push(expertise);
                }
                if let Some(behavior) = self.compile_behavior() {
                    segments.push(behavior);
                }
                let packs = knowledge_packs::load_knowledge_packs(
                    &self.domain_focus_sorted(),
                    &self.vendor_weights_sorted(),
                    pack_budget,
                );
                segments.push(packs);
            }
            AiFeature::Agents => {
                // Agents: identity + expertise + behavior + knowledge packs
                if let Some(identity) = self.compile_identity() {
                    segments.push(identity);
                }
                if let Some(expertise) = self.compile_expertise() {
                    segments.push(expertise);
                }
                if let Some(behavior) = self.compile_behavior() {
                    segments.push(behavior);
                }
                let packs = knowledge_packs::load_knowledge_packs(
                    &self.domain_focus_sorted(),
                    &self.vendor_weights_sorted(),
                    pack_budget,
                );
                segments.push(packs);
            }
            AiFeature::ScriptGeneration => {
                // Scripts: expertise + lean packs
                if let Some(expertise) = self.compile_expertise() {
                    segments.push(expertise);
                }
                let packs = knowledge_packs::load_knowledge_packs(
                    &self.domain_focus_sorted(),
                    &self.vendor_weights_sorted(),
                    pack_budget.min(2000),
                );
                segments.push(packs);
            }
        }

        segments.join("\n\n")
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_compile_for_chat_includes_all_segments() {
        let profile = AiEngineerProfile {
            name: Some("Atlas".to_string()),
            behavior_mode: Some("coworker".to_string()),
            vendor_weights: HashMap::from([
                ("cisco".to_string(), 0.7),
                ("juniper".to_string(), 0.3),
            ]),
            domain_focus: HashMap::from([
                ("routing".to_string(), 0.8),
                ("datacenter".to_string(), 0.5),
            ]),
            ..Default::default()
        };

        let result = profile.compile_for_feature(AiFeature::Chat, 20000);

        // Safety rules always present
        assert!(result.contains("Safety Rules (Non-Negotiable)"));
        // Identity present for Chat
        assert!(result.contains("Atlas"));
        assert!(result.contains("coworker"));
        // Expertise present
        assert!(result.contains("Cisco"));
        assert!(result.contains("Juniper"));
        // Knowledge packs loaded
        assert!(result.contains("Core Networking Expertise"));
        assert!(result.contains("Routing Protocol Expertise"));
    }


    #[test]
    fn test_default_profile_compiles() {
        let profile = AiEngineerProfile::default();
        let result = profile.compile_for_feature(AiFeature::Chat, 20000);

        // Should at least have safety rules and core pack
        assert!(result.contains("Safety Rules"));
        assert!(result.contains("Core Networking Expertise"));
    }

    #[test]
    fn test_knowledge_packs_respect_budget() {
        let profile = AiEngineerProfile {
            domain_focus: HashMap::from([
                ("routing".to_string(), 0.9),
                ("datacenter".to_string(), 0.8),
                ("security".to_string(), 0.7),
            ]),
            ..Default::default()
        };

        // Very small budget — should only load core pack
        let result = profile.compile_for_feature(AiFeature::Chat, 500);
        assert!(result.contains("Core Networking Expertise"));
        // With tiny budget, domain packs may not fit
    }
}
