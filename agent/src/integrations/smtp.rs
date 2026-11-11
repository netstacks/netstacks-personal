//! SMTP email integration for NetStacks
//!
//! Provides SMTP configuration and email sending capabilities using the lettre crate.
//! SMTP credentials are stored encrypted in the vault.

use lettre::{
    message::header::ContentType,
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// SMTP configuration stored in the database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpConfig {
    /// SMTP server hostname
    pub host: String,
    /// SMTP server port (typically 587 for STARTTLS, 465 for SSL, 25 for unencrypted)
    pub port: u16,
    /// Username for SMTP authentication
    pub username: String,
    /// Whether to use TLS (STARTTLS on port 587, implicit TLS on port 465)
    pub use_tls: bool,
    /// Sender email address (From field)
    pub from_email: String,
    /// Sender display name (optional)
    pub from_name: Option<String>,
}

impl Default for SmtpConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 587,
            username: String::new(),
            use_tls: true,
            from_email: String::new(),
            from_name: None,
        }
    }
}

/// SMTP-related errors
#[derive(Error, Debug)]
pub enum SmtpError {
    #[error("SMTP transport error: {0}")]
    Transport(String),
    #[error("Email building error: {0}")]
    Build(String),
    #[error("Configuration error: {0}")]
    _Config(String),
    #[error("Authentication error: {0}")]
    _Auth(String),
}

/// Email service for sending emails via SMTP
pub struct EmailService {
    config: SmtpConfig,
    password: String,
}

impl EmailService {
    /// Create a new email service with the given configuration and password
    pub fn new(config: SmtpConfig, password: String) -> Self {
        Self { config, password }
    }

    /// Build the SMTP transport based on configuration
    fn build_transport(&self) -> Result<AsyncSmtpTransport<Tokio1Executor>, SmtpError> {
        let creds = Credentials::new(self.config.username.clone(), self.password.clone());

        let transport = if self.config.use_tls {
            if self.config.port == 465 {
                // Implicit TLS (SSL) on port 465
                AsyncSmtpTransport::<Tokio1Executor>::relay(&self.config.host)
                    .map_err(|e| SmtpError::Transport(e.to_string()))?
                    .port(self.config.port)
                    .credentials(creds)
                    .build()
            } else {
                // STARTTLS on other ports (typically 587)
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.config.host)
                    .map_err(|e| SmtpError::Transport(e.to_string()))?
                    .port(self.config.port)
                    .credentials(creds)
                    .build()
            }
        } else {
            // No TLS (not recommended, but supported)
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.config.host)
                .port(self.config.port)
                .credentials(creds)
                .build()
        };

        Ok(transport)
    }

    /// Test the SMTP connection by sending a test email
    pub async fn test_connection(&self) -> Result<(), SmtpError> {
        let transport = self.build_transport()?;

        // Test the connection
        transport
            .test_connection()
            .await
            .map_err(|e| SmtpError::Transport(e.to_string()))?;

        Ok(())
    }

    /// Send an email
    pub async fn send_email(
        &self,
        to: &str,
        subject: &str,
        body: &str,
    ) -> Result<(), SmtpError> {
        let transport = self.build_transport()?;

        // Build the from address
        let from = if let Some(ref name) = self.config.from_name {
            format!("{} <{}>", name, self.config.from_email)
        } else {
            self.config.from_email.clone()
        };

        // Build the email
        let email = Message::builder()
            .from(from.parse().map_err(|e| SmtpError::Build(format!("Invalid from address: {}", e)))?)
            .to(to.parse().map_err(|e| SmtpError::Build(format!("Invalid to address: {}", e)))?)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN)
            .body(body.to_string())
            .map_err(|e| SmtpError::Build(e.to_string()))?;

        // Send the email
        transport
            .send(email)
            .await
            .map_err(|e| SmtpError::Transport(e.to_string()))?;

        Ok(())
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_smtp_config_default() {
        let config = SmtpConfig::default();
        assert_eq!(config.port, 587);
        assert!(config.use_tls);
        assert!(config.host.is_empty());
    }

    #[test]
    fn test_smtp_config_serialization() {
        let config = SmtpConfig {
            host: "smtp.example.com".to_string(),
            port: 587,
            username: "user@example.com".to_string(),
            use_tls: true,
            from_email: "noreply@example.com".to_string(),
            from_name: Some("NetStacks".to_string()),
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: SmtpConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.host, config.host);
        assert_eq!(parsed.port, config.port);
        assert_eq!(parsed.from_name, config.from_name);
    }
}
