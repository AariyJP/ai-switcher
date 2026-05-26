use anyhow::{Context, Result};
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::process::Command;

use crate::types::{AuthData, ClaudeCredential, StoredAccount};

const CLAUDE_KEYCHAIN_SERVICE_PREFIX: &str = "Claude Code-credentials";

pub fn import_current_claude_account(account_name: String) -> Result<StoredAccount> {
    let credentials = read_current_claude_credentials()?;
    if credentials.is_empty() {
        anyhow::bail!("Claude Code credentials were not found");
    }

    let metadata = read_claude_metadata().unwrap_or_default();
    let credential_plan = credentials
        .iter()
        .filter_map(|credential| parse_claude_plan_type(&credential.value))
        .next();

    Ok(StoredAccount::new_claude_code(
        account_name,
        metadata.email,
        credential_plan.or(metadata.plan_type),
        credentials,
        read_claude_oauth_account().unwrap_or(None),
    ))
}

pub fn switch_to_claude_account(account: &StoredAccount) -> Result<()> {
    let AuthData::ClaudeCode {
        credentials,
        oauth_account,
    } = &account.auth_data
    else {
        anyhow::bail!("Account is not a Claude Code account");
    };

    if credentials.is_empty() {
        anyhow::bail!("Claude Code account has no stored credentials");
    }

    write_claude_credentials(credentials)?;

    if let Some(oauth_account) = oauth_account {
        if let Err(err) = write_claude_oauth_account(oauth_account) {
            println!("[Claude] Failed to update ~/.claude.json oauthAccount: {err}");
        }
    } else if let Err(err) = ensure_claude_onboarding_flags() {
        println!("[Claude] Failed to update ~/.claude.json onboarding flags: {err}");
    }

    Ok(())
}

pub fn read_claude_oauth_account() -> Result<Option<Value>> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    let path = home.join(".claude.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Claude config: {}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse Claude config: {}", path.display()))?;
    Ok(value.get("oauthAccount").cloned())
}

pub fn write_claude_oauth_account(oauth_account: &Value) -> Result<()> {
    update_claude_config(|map| {
        map.insert("oauthAccount".to_string(), oauth_account.clone());
    })
}

pub fn ensure_claude_onboarding_flags() -> Result<()> {
    update_claude_config(|_| {})
}

fn update_claude_config<F>(mutator: F) -> Result<()>
where
    F: FnOnce(&mut serde_json::Map<String, Value>),
{
    let home = dirs::home_dir().context("Could not find home directory")?;
    let path = home.join(".claude.json");

    let mut value: Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read Claude config: {}", path.display()))?;
        serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse Claude config: {}", path.display()))?
    } else {
        Value::Object(serde_json::Map::new())
    };

    let Some(map) = value.as_object_mut() else {
        anyhow::bail!("~/.claude.json root is not a JSON object");
    };

    mutator(map);

    if !matches!(map.get("hasCompletedOnboarding"), Some(Value::Bool(true))) {
        map.insert("hasCompletedOnboarding".to_string(), Value::Bool(true));
    }
    if !matches!(map.get("hasTrustDialogAccepted"), Some(Value::Bool(true))) {
        map.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));
    }
    if !matches!(map.get("theme"), Some(Value::String(_))) {
        map.insert("theme".to_string(), Value::String("dark".to_string()));
    }

    let serialized =
        serde_json::to_string_pretty(&value).context("Failed to serialize Claude config")?;
    std::fs::write(&path, serialized)
        .with_context(|| format!("Failed to write Claude config: {}", path.display()))?;

    Ok(())
}

pub fn read_current_claude_credentials_snapshot() -> Result<Vec<ClaudeCredential>> {
    read_current_claude_credentials()
}

#[derive(Default)]
struct ClaudeMetadata {
    email: Option<String>,
    plan_type: Option<String>,
}

fn read_claude_metadata() -> Result<ClaudeMetadata> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    let path = home.join(".claude.json");
    if !path.exists() {
        return Ok(ClaudeMetadata::default());
    }

    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Claude config: {}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse Claude config: {}", path.display()))?;
    let oauth = value
        .get("oauthAccount")
        .and_then(|value| value.as_object());

    Ok(ClaudeMetadata {
        email: oauth
            .and_then(|value| value.get("emailAddress"))
            .and_then(|value| value.as_str())
            .map(String::from),
        plan_type: oauth
            .and_then(|value| value.get("billingType"))
            .or_else(|| oauth.and_then(|value| value.get("organizationRateLimitTier")))
            .and_then(|value| value.as_str())
            .map(String::from),
    })
}

fn parse_claude_plan_type(value: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(value).ok()?;
    let oauth = parsed.get("claudeAiOauth")?;
    oauth
        .get("subscriptionType")
        .or_else(|| oauth.get("rateLimitTier"))
        .and_then(|value| value.as_str())
        .map(String::from)
}

#[cfg(target_os = "macos")]
fn read_current_claude_credentials() -> Result<Vec<ClaudeCredential>> {
    let services = list_claude_keychain_items()?;
    let mut credentials = Vec::with_capacity(services.len());

    for (service_name, account_name) in services {
        let value = read_keychain_password(&service_name, &account_name)?;
        credentials.push(ClaudeCredential {
            service_name,
            account_name,
            value,
        });
    }

    Ok(credentials)
}

#[cfg(not(target_os = "macos"))]
fn read_current_claude_credentials() -> Result<Vec<ClaudeCredential>> {
    anyhow::bail!("Claude Code switching is currently supported on macOS");
}

#[cfg(target_os = "macos")]
fn write_claude_credentials(credentials: &[ClaudeCredential]) -> Result<()> {
    for credential in credentials {
        write_keychain_password(credential)?;
    }

    let desired = credentials
        .iter()
        .map(|credential| {
            (
                credential.service_name.clone(),
                credential.account_name.clone(),
            )
        })
        .collect::<HashSet<_>>();

    for (service_name, account_name) in list_claude_keychain_items()? {
        if !desired.contains(&(service_name.clone(), account_name.clone())) {
            delete_keychain_password(&service_name, &account_name)?;
        }
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write_claude_credentials(_credentials: &[ClaudeCredential]) -> Result<()> {
    anyhow::bail!("Claude Code switching is currently supported on macOS");
}

#[cfg(target_os = "macos")]
fn list_claude_keychain_items() -> Result<Vec<(String, String)>> {
    let output = run_security(["dump-keychain"])?;
    let mut account_name: Option<String> = None;
    let mut seen = HashSet::new();
    let mut items = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("\"acct\"<blob>=") {
            account_name = extract_security_value(trimmed);
            continue;
        }

        if !trimmed.starts_with("\"svce\"<blob>=") {
            continue;
        }

        let Some(service_name) = extract_security_value(trimmed) else {
            continue;
        };

        if !service_name.starts_with(CLAUDE_KEYCHAIN_SERVICE_PREFIX) {
            account_name = None;
            continue;
        }

        let account_name = account_name
            .take()
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_default();
        let key = (service_name, account_name);
        if seen.insert(key.clone()) {
            items.push(key);
        }
    }

    Ok(items)
}

#[cfg(target_os = "macos")]
fn read_keychain_password(service_name: &str, account_name: &str) -> Result<String> {
    if account_name.is_empty() {
        run_security(["find-generic-password", "-s", service_name, "-w"])
    } else {
        run_security([
            "find-generic-password",
            "-s",
            service_name,
            "-a",
            account_name,
            "-w",
        ])
    }
}

#[cfg(target_os = "macos")]
fn write_keychain_password(credential: &ClaudeCredential) -> Result<()> {
    let _ = Command::new("security")
        .arg("delete-generic-password")
        .arg("-s")
        .arg(&credential.service_name)
        .arg("-a")
        .arg(&credential.account_name)
        .output();

    let output = Command::new("security")
        .arg("add-generic-password")
        .arg("-A")
        .arg("-s")
        .arg(&credential.service_name)
        .arg("-a")
        .arg(&credential.account_name)
        .arg("-w")
        .arg(&credential.value)
        .output()
        .with_context(|| format!("Failed to write Keychain item {}", credential.service_name))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "Failed to write Keychain item {}: {}",
            credential.service_name,
            stderr.trim()
        );
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn delete_keychain_password(service_name: &str, account_name: &str) -> Result<()> {
    let output = Command::new("security")
        .arg("delete-generic-password")
        .arg("-s")
        .arg(service_name)
        .arg("-a")
        .arg(account_name)
        .output()
        .with_context(|| format!("Failed to delete Keychain item {service_name}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "Failed to delete Keychain item {}: {}",
            service_name,
            stderr.trim()
        );
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn run_security<const N: usize>(args: [&str; N]) -> Result<String> {
    let output = Command::new("security")
        .args(args)
        .output()
        .context("Failed to run security command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("security command failed: {}", stderr.trim());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_string())
}

#[cfg(target_os = "macos")]
fn extract_security_value(line: &str) -> Option<String> {
    let (_, rhs) = line.split_once('=')?;
    let start = rhs.find('"')?;
    let rest = &rhs[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}
