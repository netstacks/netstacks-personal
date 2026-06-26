//! AI Engineer onboarding — conversational profile builder.
//!
//! Uses the existing chat interface with a specialized system prompt to
//! interview the user and build their AI engineer profile.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::profile::AiEngineerProfile;
use super::providers::{AiProvider, ChatMessage, AiError};

/// System prompt for the onboarding conversation.
/// This replaces the normal system prompt when onboarding is active.
pub const ONBOARDING_SYSTEM_PROMPT: &str = "\
You are setting up a personalized AI network engineer for the user. Your job is to interview them \
conversationally to build their profile. Be warm, concise, and professional — like a coworker \
introducing themselves on the first day.

## Rules
- Ask ONE question at a time. Wait for their answer before moving on.
- Be conversational, not robotic. React to their answers briefly before asking the next question.
- If they give a vague answer, gently clarify. But don't push — defaults are fine.
- After the core questions, offer to go deeper or start working immediately.
- When they're done, say exactly: [ONBOARDING_COMPLETE]

## Core Questions (ask in this order, skip any already answered)
1. **Name** — \"Hey! I'm your network engineer in NetStacks. Before we get started — what should I go by?\"
2. **Working Style** — \"How do you want us to work? I can be someone you ask questions to (assistant), \
a coworker you hand tasks off to (coworker), a mentor who explains the why (mentor), or mostly silent \
unless you need me (silent).\"
3. **Vendors** — \"What gear do you work with day to day? Mostly Cisco, Juniper, Arista, or a mix?\"
4. **Domain** — \"What's your world — routing and switching, data center, security, wireless, \
cloud, or a bit of everything?\"
5. **Autonomy** — \"When I find a problem, do you want me to just report it (inform), suggest a fix \
and wait (suggest), or go ahead and fix it (act)?\"
6. **Go Deeper** — \"That's enough to get rolling. Want to fine-tune how I work \
(communication style, risk tolerance, troubleshooting approach), or start working and adjust later?\"

## Advanced Questions (only if user opts in)
- Communication: terse and direct, balanced, or detailed explanations?
- Risk tolerance: conservative (always verify), moderate, or aggressive (faster when safe)?
- Certification perspective: CCIE, JNCIE, or vendor-neutral?
- Troubleshooting: top-down, bottom-up, or divide-and-conquer?
- Experience level: helps calibrate how much I explain.
- Environment: lab, production, MSP, or mixed?
- Syntax: full commands or shorthand?
- Any commands or devices that are always off-limits?

## Important
- Start with question 1 immediately — don't ask if they want to set up a profile.
- The user already chose to set up their profile by reaching this point.
";

/// Prompt template for extracting structured profile fields from conversation.
pub const FIELD_EXTRACTION_PROMPT: &str = "\
Extract any AI engineer profile fields from this conversation. Return a JSON object with ONLY \
the fields that can be confidently determined from the user's responses. Omit fields that weren't discussed.

Valid fields and their types:
- name: string (the AI's name, not the user's name)
- behavior_mode: \"assistant\" | \"coworker\" | \"mentor\" | \"silent\"
- autonomy_level: \"inform\" | \"suggest\" | \"act\"
- vendor_weights: object mapping vendor names to weights 0.0-1.0 (e.g. {\"cisco\": 0.7, \"juniper\": 0.3})
- domain_focus: object mapping domains to weights 0.0-1.0 (e.g. {\"routing\": 0.8, \"datacenter\": 0.5})
- cert_perspective: \"ccie\" | \"jncie\" | \"vendor-neutral\"
- verbosity: \"terse\" | \"balanced\" | \"detailed\"
- risk_tolerance: \"conservative\" | \"moderate\" | \"aggressive\"
- troubleshooting_method: \"top-down\" | \"bottom-up\" | \"divide-and-conquer\"
- syntax_style: \"full\" | \"shorthand\"
- user_experience_level: \"junior\" | \"mid\" | \"senior\" | \"expert\"
- environment_type: \"lab\" | \"production\" | \"msp\" | \"mixed\"
- safety_rules: array of strings (commands/devices that are off-limits)
- onboarding_complete: boolean (true ONLY if the conversation includes [ONBOARDING_COMPLETE])

Respond with ONLY valid JSON, no markdown formatting.";

/// Partial profile update extracted from conversation.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProfileUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autonomy_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_weights: Option<HashMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_focus: Option<HashMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert_perspective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_tolerance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub troubleshooting_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syntax_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_experience_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_rules: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onboarding_complete: Option<bool>,
}

impl ProfileUpdate {
    /// Apply this update to an existing profile, merging non-None fields.
    pub fn apply_to(&self, profile: &mut AiEngineerProfile) {
        if let Some(name) = &self.name {
            profile.name = Some(name.clone());
        }
        if let Some(mode) = &self.behavior_mode {
            profile.behavior_mode = Some(mode.clone());
        }
        if let Some(level) = &self.autonomy_level {
            profile.autonomy_level = Some(level.clone());
        }
        if let Some(weights) = &self.vendor_weights {
            profile.vendor_weights = weights.clone();
        }
        if let Some(focus) = &self.domain_focus {
            profile.domain_focus = focus.clone();
        }
        if let Some(cert) = &self.cert_perspective {
            profile.cert_perspective = Some(cert.clone());
        }
        if let Some(v) = &self.verbosity {
            profile.verbosity = Some(v.clone());
        }
        if let Some(r) = &self.risk_tolerance {
            profile.risk_tolerance = Some(r.clone());
        }
        if let Some(m) = &self.troubleshooting_method {
            profile.troubleshooting_method = Some(m.clone());
        }
        if let Some(s) = &self.syntax_style {
            profile.syntax_style = Some(s.clone());
        }
        if let Some(e) = &self.user_experience_level {
            profile.user_experience_level = Some(e.clone());
        }
        if let Some(e) = &self.environment_type {
            profile.environment_type = Some(e.clone());
        }
        if let Some(rules) = &self.safety_rules {
            profile.safety_rules = rules.clone();
        }
        if let Some(true) = &self.onboarding_complete {
            profile.onboarding_completed = true;
        }
    }
}

/// Extract profile fields from conversation using a JSON-mode LLM call.
///
/// Takes the full conversation history and uses a secondary LLM call
/// to parse natural language responses into structured profile fields.
pub async fn extract_profile_fields(
    provider: &dyn AiProvider,
    conversation: &[ChatMessage],
) -> Result<ProfileUpdate, AiError> {
    // Build extraction request: prompt + conversation summary
    let messages = vec![
        ChatMessage {
            role: "user".to_string(),
            content: format!(
                "{}\n\nConversation:\n{}",
                FIELD_EXTRACTION_PROMPT,
                conversation.iter()
                    .map(|m| format!("{}: {}", m.role, m.content))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        },
    ];

    let response = provider.chat_completion(messages, None).await?;

    // Parse JSON response, stripping any markdown formatting
    let json_str = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    serde_json::from_str(json_str).map_err(|e| {
        AiError::InvalidResponse(format!("Failed to parse profile extraction: {}", e))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_update_apply_name() {
        let mut profile = AiEngineerProfile::default();
        let update = ProfileUpdate {
            name: Some("Atlas".to_string()),
            ..Default::default()
        };
        update.apply_to(&mut profile);
        assert_eq!(profile.name, Some("Atlas".to_string()));
    }

    #[test]
    fn test_profile_update_apply_vendors() {
        let mut profile = AiEngineerProfile::default();
        let update = ProfileUpdate {
            vendor_weights: Some(HashMap::from([
                ("cisco".to_string(), 0.7),
                ("juniper".to_string(), 0.3),
            ])),
            ..Default::default()
        };
        update.apply_to(&mut profile);
        assert_eq!(profile.vendor_weights.get("cisco"), Some(&0.7));
        assert_eq!(profile.vendor_weights.get("juniper"), Some(&0.3));
    }

    #[test]
    fn test_profile_update_apply_onboarding_complete() {
        let mut profile = AiEngineerProfile::default();
        assert!(!profile.onboarding_completed);

        let update = ProfileUpdate {
            onboarding_complete: Some(true),
            ..Default::default()
        };
        update.apply_to(&mut profile);
        assert!(profile.onboarding_completed);
    }

    #[test]
    fn test_profile_update_partial_merge() {
        let mut profile = AiEngineerProfile::default();
        profile.name = Some("Atlas".to_string());
        profile.behavior_mode = Some("assistant".to_string());

        let update = ProfileUpdate {
            behavior_mode: Some("coworker".to_string()),
            ..Default::default()
        };
        update.apply_to(&mut profile);
        assert_eq!(profile.name, Some("Atlas".to_string()));
        assert_eq!(profile.behavior_mode, Some("coworker".to_string()));
    }

    #[test]
    fn test_field_extraction_json_parsing() {
        let json = r#"{"name": "Atlas", "behavior_mode": "coworker", "vendor_weights": {"cisco": 0.8}}"#;
        let update: ProfileUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(update.name, Some("Atlas".to_string()));
        assert_eq!(update.behavior_mode, Some("coworker".to_string()));
        assert_eq!(update.vendor_weights.unwrap().get("cisco"), Some(&0.8));
    }

    #[test]
    fn test_field_extraction_partial_json() {
        let json = r#"{"autonomy_level": "suggest"}"#;
        let update: ProfileUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(update.autonomy_level, Some("suggest".to_string()));
        assert!(update.name.is_none());
        assert!(update.vendor_weights.is_none());
    }
}
