//! ChatGPT OAuth token refresh helpers

use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use super::{
    load_accounts, read_current_claude_credentials_snapshot, switch_to_account,
    switch_to_claude_account, update_account_chatgpt_tokens, update_account_claude_credentials,
};
use crate::types::{parse_chatgpt_id_token_claims, AuthData, StoredAccount};

const DEFAULT_ISSUER: &str = "https://auth.openai.com";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_SKEW_SECONDS: i64 = 60;
const CLAUDE_TOKEN_ISSUER: &str = "https://platform.claude.com";
const CLAUDE_PRIMARY_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_PRIMARY_SERVICE_NAME: &str = "Claude Code-credentials";
const CLAUDE_EXPIRY_SKEW_MILLIS: i64 = 60_000;

#[derive(Debug, serde::Deserialize)]
struct RefreshTokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeRefreshTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug)]
struct ClaudeRefreshTarget {
    index: usize,
    refresh_token: String,
    client_id: String,
    expires_at: Option<i64>,
}

/// Ensure the account has a non-expired ChatGPT access token.
/// Returns an updated account when a refresh was performed.
pub async fn ensure_chatgpt_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    match &account.auth_data {
        AuthData::ApiKey { .. } | AuthData::ClaudeCode { .. } => Ok(account.clone()),
        AuthData::ChatGPT { access_token, .. } => {
            if token_expired_or_near_expiry(access_token) {
                println!(
                    "[Auth] Access token expired/near expiry for account {}, refreshing",
                    account.name
                );
                refresh_chatgpt_tokens(account).await
            } else {
                Ok(account.clone())
            }
        }
    }
}

pub async fn ensure_claude_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    refresh_claude_tokens_inner(account, false).await
}

pub async fn refresh_claude_tokens(account: &StoredAccount) -> Result<StoredAccount> {
    refresh_claude_tokens_inner(account, true).await
}

pub fn sync_active_claude_account_credentials(
    account: &StoredAccount,
) -> Result<Option<StoredAccount>> {
    if load_accounts()?.active_claude_account_id.as_deref() != Some(account.id.as_str()) {
        return Ok(None);
    }

    let credentials = read_current_claude_credentials_snapshot()?;
    if credentials.is_empty() {
        return Ok(None);
    }

    let updated = update_account_claude_credentials(&account.id, credentials)?;
    if let Err(err) = switch_to_claude_account(&updated) {
        println!("[Auth] Failed to sync active Claude credentials from keychain: {err}");
    }

    Ok(Some(updated))
}

/// Force-refresh ChatGPT OAuth tokens for an account.
pub async fn refresh_chatgpt_tokens(account: &StoredAccount) -> Result<StoredAccount> {
    let (current_id_token, current_refresh_token, current_account_id) = match &account.auth_data {
        AuthData::ApiKey { .. } | AuthData::ClaudeCode { .. } => return Ok(account.clone()),
        AuthData::ChatGPT {
            id_token,
            refresh_token,
            account_id,
            ..
        } => (id_token.clone(), refresh_token.clone(), account_id.clone()),
    };

    if current_refresh_token.is_empty() {
        anyhow::bail!("Missing refresh token for account {}", account.name);
    }

    let refreshed = refresh_tokens_with_refresh_token(&current_refresh_token).await?;
    let next_id_token = refreshed.id_token.unwrap_or(current_id_token);
    let next_refresh_token = refreshed
        .refresh_token
        .unwrap_or_else(|| current_refresh_token.clone());

    let claims = parse_chatgpt_id_token_claims(&next_id_token);
    let next_account_id = claims.account_id.or(current_account_id);

    let is_active = load_accounts()?.active_account_id.as_deref() == Some(account.id.as_str());

    let updated = update_account_chatgpt_tokens(
        &account.id,
        next_id_token,
        refreshed.access_token,
        next_refresh_token,
        next_account_id,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
    )?;

    // Keep ~/.codex/auth.json in sync when this is the active account.
    if is_active {
        if let Err(err) = switch_to_account(&updated) {
            println!("[Auth] Failed to sync active auth.json after token refresh: {err}");
        }
    }

    Ok(updated)
}

/// Build a new ChatGPT account from a refresh token.
/// This is used by slim import to recreate full credentials.
pub async fn create_chatgpt_account_from_refresh_token(
    account_name: String,
    refresh_token: String,
) -> Result<StoredAccount> {
    if refresh_token.trim().is_empty() {
        anyhow::bail!("Missing refresh token for account {account_name}");
    }

    let refreshed = refresh_tokens_with_refresh_token(&refresh_token).await?;
    let id_token = refreshed
        .id_token
        .context("Refresh response did not include id_token")?;
    let next_refresh_token = refreshed.refresh_token.unwrap_or(refresh_token);
    let claims = parse_chatgpt_id_token_claims(&id_token);

    Ok(StoredAccount::new_chatgpt(
        account_name,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
        id_token,
        refreshed.access_token,
        next_refresh_token,
        claims.account_id,
    ))
}

async fn refresh_claude_tokens_inner(
    account: &StoredAccount,
    force: bool,
) -> Result<StoredAccount> {
    let AuthData::ClaudeCode { credentials } = &account.auth_data else {
        return Ok(account.clone());
    };

    let Some(target) = find_claude_refresh_target(credentials) else {
        if force {
            anyhow::bail!("No refreshable Claude OAuth credential found");
        }
        return Ok(account.clone());
    };

    let now_millis = Utc::now().timestamp_millis();
    if !force
        && target
            .expires_at
            .is_some_and(|expires_at| expires_at > now_millis + CLAUDE_EXPIRY_SKEW_MILLIS)
    {
        return Ok(account.clone());
    }

    let refreshed_credential = refresh_claude_credential(
        &credentials[target.index],
        &target.refresh_token,
        &target.client_id,
    )
    .await?;
    let mut next_credentials = credentials.clone();
    next_credentials[target.index] = refreshed_credential;

    let is_active =
        load_accounts()?.active_claude_account_id.as_deref() == Some(account.id.as_str());
    let updated = update_account_claude_credentials(&account.id, next_credentials)?;

    if is_active {
        if let Err(err) = switch_to_claude_account(&updated) {
            println!("[Auth] Failed to sync active Claude credentials after token refresh: {err}");
        }
    }

    Ok(updated)
}

fn token_expired_or_near_expiry(access_token: &str) -> bool {
    match parse_jwt_exp(access_token) {
        Some(expiry) => expiry <= Utc::now().timestamp() + EXPIRY_SKEW_SECONDS,
        None => false,
    }
}

fn find_claude_refresh_target(
    credentials: &[crate::types::ClaudeCredential],
) -> Option<ClaudeRefreshTarget> {
    let mut preferred = None;
    let mut fallback = None;

    for (index, credential) in credentials.iter().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(&credential.value) else {
            continue;
        };
        let Some(oauth) = value.get("claudeAiOauth") else {
            continue;
        };
        let refresh_token = oauth
            .get("refreshToken")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let client_id = oauth
            .get("clientId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                (credential.service_name == CLAUDE_PRIMARY_SERVICE_NAME)
                    .then(|| CLAUDE_PRIMARY_CLIENT_ID.to_string())
            });

        let (Some(refresh_token), Some(client_id)) = (refresh_token, client_id) else {
            continue;
        };

        let expires_at = oauth.get("expiresAt").and_then(Value::as_i64).or_else(|| {
            oauth
                .get("expiresAt")
                .and_then(Value::as_f64)
                .map(|value| value as i64)
        });
        let has_profile_scope =
            oauth
                .get("scopes")
                .and_then(Value::as_array)
                .is_some_and(|scopes| {
                    scopes
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|scope| scope == "user:profile")
                });
        let has_plan_metadata =
            oauth.get("subscriptionType").is_some() || oauth.get("rateLimitTier").is_some();

        let target = ClaudeRefreshTarget {
            index,
            refresh_token,
            client_id,
            expires_at,
        };

        if has_profile_scope
            || credential.service_name == CLAUDE_PRIMARY_SERVICE_NAME
            || has_plan_metadata
        {
            preferred = Some(target);
            break;
        }

        if fallback.is_none() {
            fallback = Some(target);
        }
    }

    preferred.or(fallback)
}

fn parse_jwt_exp(token: &str) -> Option<i64> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    json.get("exp").and_then(|v| v.as_i64())
}

async fn refresh_tokens_with_refresh_token(refresh_token: &str) -> Result<RefreshTokenResponse> {
    let client = reqwest::Client::new();
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding::encode(refresh_token),
        urlencoding::encode(CLIENT_ID),
    );

    let mut last_send_error = None;
    let mut response = None;

    for attempt in 1..=3u8 {
        match client
            .post(format!("{DEFAULT_ISSUER}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body.clone())
            .send()
            .await
        {
            Ok(resp) => {
                response = Some(resp);
                break;
            }
            Err(err) => {
                last_send_error = Some(err);
                if attempt < 3 {
                    sleep(Duration::from_millis(250 * u64::from(attempt))).await;
                }
            }
        }
    }

    let response = match response {
        Some(resp) => resp,
        None => {
            let err = last_send_error.context("Failed to send token refresh request")?;
            return Err(err.into());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Token refresh failed: {status} - {body}");
    }

    response
        .json::<RefreshTokenResponse>()
        .await
        .context("Failed to parse token refresh response")
}

async fn refresh_claude_credential(
    credential: &crate::types::ClaudeCredential,
    refresh_token: &str,
    client_id: &str,
) -> Result<crate::types::ClaudeCredential> {
    let client = reqwest::Client::new();
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    });

    let mut last_send_error = None;
    let mut response = None;

    for attempt in 1..=3u8 {
        match client
            .post(format!("{CLAUDE_TOKEN_ISSUER}/v1/oauth/token"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                response = Some(resp);
                break;
            }
            Err(err) => {
                last_send_error = Some(err);
                if attempt < 3 {
                    sleep(Duration::from_millis(250 * u64::from(attempt))).await;
                }
            }
        }
    }

    let response = match response {
        Some(resp) => resp,
        None => {
            let err = last_send_error.context("Failed to send Claude token refresh request")?;
            return Err(err.into());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Claude token refresh failed: {status} - {body}");
    }

    let refreshed = response
        .json::<ClaudeRefreshTokenResponse>()
        .await
        .context("Failed to parse Claude token refresh response")?;
    let mut value: Value = serde_json::from_str(&credential.value)
        .context("Failed to parse stored Claude credential")?;
    let oauth = value
        .get_mut("claudeAiOauth")
        .and_then(Value::as_object_mut)
        .context("Stored Claude credential is missing claudeAiOauth")?;
    let refresh_token = refreshed
        .refresh_token
        .unwrap_or_else(|| refresh_token.to_string());

    oauth.insert("accessToken".to_string(), json!(refreshed.access_token));
    oauth.insert("refreshToken".to_string(), json!(refresh_token));
    oauth.insert("clientId".to_string(), json!(client_id));

    if let Some(expires_in) = refreshed.expires_in {
        oauth.insert(
            "expiresAt".to_string(),
            json!(Utc::now().timestamp_millis() + expires_in * 1000),
        );
    }

    Ok(crate::types::ClaudeCredential {
        service_name: credential.service_name.clone(),
        account_name: credential.account_name.clone(),
        value: serde_json::to_string(&value).context("Failed to serialize Claude credential")?,
    })
}
