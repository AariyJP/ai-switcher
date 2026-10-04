//! ChatGPT OAuth token refresh helpers

use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use super::{
    load_accounts, read_current_auth, read_current_claude_credentials_snapshot, save_accounts,
    switch_to_account, switch_to_claude_account, sync_active_account_tokens,
    update_account_chatgpt_tokens, update_account_claude_credentials, AUTH_OPERATION_LOCK,
};
use crate::types::{
    parse_chatgpt_id_token_claims, AccountsStore, AuthData, AuthDotJson, StoredAccount,
};

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

#[derive(Debug)]
struct TokenRefreshUpdate {
    id_token: String,
    access_token: String,
    refresh_token: String,
    id_token_error: Option<anyhow::Error>,
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

/// Ensure the account has non-expired ChatGPT OAuth tokens.
/// Returns an updated account when a refresh was performed.
pub async fn ensure_chatgpt_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    if !chatgpt_tokens_need_refresh(account) {
        return Ok(account.clone());
    }

    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
    ensure_chatgpt_tokens_fresh_locked(account).await
}

/// Ensure ChatGPT OAuth tokens are fresh while the caller holds AUTH_OPERATION_LOCK.
pub(crate) async fn ensure_chatgpt_tokens_fresh_locked(
    account: &StoredAccount,
) -> Result<StoredAccount> {
    if !matches!(account.auth_data, AuthData::ChatGPT { .. }) {
        return Ok(account.clone());
    }

    // Codex may have refreshed the active account while this task waited for
    // the lock. Prefer those live credentials over rotating the stored token.
    let (current, _) = load_account_reconciling_live_auth(&account.id)?;

    match &current.auth_data {
        AuthData::ApiKey { .. }
        | AuthData::ClaudeCode { .. }
        | AuthData::ClaudeDesktop { .. }
        | AuthData::Cursor { .. } => Ok(current.clone()),
        AuthData::ChatGPT {
            id_token,
            access_token,
            ..
        } => {
            if chatgpt_tokens_need_refresh_at(id_token, access_token, Utc::now().timestamp()) {
                refresh_chatgpt_tokens_locked(&current).await
            } else {
                Ok(current)
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
    if !matches!(account.auth_data, AuthData::ChatGPT { .. }) {
        return Ok(account.clone());
    }

    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
    refresh_chatgpt_tokens_locked(account).await
}

async fn refresh_chatgpt_tokens_locked(account: &StoredAccount) -> Result<StoredAccount> {
    let (current, is_active) = load_account_reconciling_live_auth(&account.id)?;

    if is_active && crate::commands::process::ensure_codex_not_running().is_err() {
        return Ok(current);
    }

    let (current_id_token, current_refresh_token, current_account_id) = match &current.auth_data {
        AuthData::ChatGPT {
            id_token,
            refresh_token,
            account_id,
            ..
        } => (id_token.clone(), refresh_token.clone(), account_id.clone()),
        AuthData::ApiKey { .. }
        | AuthData::ClaudeCode { .. }
        | AuthData::ClaudeDesktop { .. }
        | AuthData::Cursor { .. } => return Ok(current),
    };

    if current_refresh_token.is_empty() {
        anyhow::bail!("Missing refresh token for account {}", current.name);
    }

    let refreshed = refresh_tokens_with_refresh_token(&current_refresh_token).await?;
    let next = merge_refresh_response(
        current_id_token,
        current_refresh_token,
        refreshed,
        Utc::now().timestamp(),
    );

    let claims = parse_chatgpt_id_token_claims(&next.id_token);
    let next_account_id = claims.account_id.or(current_account_id);

    let updated = update_account_chatgpt_tokens(
        &account.id,
        next.id_token,
        next.access_token,
        next.refresh_token,
        next_account_id,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
    )?;
    println!("[Auth] Refreshed OAuth tokens for: {}", updated.name);

    // Refresh tokens can be single-use. Persist a rotated replacement before
    // reporting an unusable ID token, so a later retry can still recover.
    if let Some(error) = next.id_token_error {
        return Err(error);
    }

    // Re-read active state after the network request before touching auth.json.
    let is_active = load_accounts()?.active_account_id.as_deref() == Some(account.id.as_str());
    if is_active {
        if let Err(err) = switch_to_account(&updated) {
            println!("[Auth] Failed to sync active auth.json after token refresh: {err}");
        }
    }

    Ok(updated)
}

fn reconcile_active_account_from_auth(
    store: &mut AccountsStore,
    account_id: &str,
    auth: &AuthDotJson,
) -> bool {
    if store.active_account_id.as_deref() != Some(account_id) {
        return false;
    }

    sync_active_account_tokens(store, auth)
}

fn load_account_reconciling_live_auth(account_id: &str) -> Result<(StoredAccount, bool)> {
    let mut store = load_accounts()?;
    let is_active = store.active_account_id.as_deref() == Some(account_id);

    if is_active {
        if let Some(auth) = read_current_auth()? {
            if reconcile_active_account_from_auth(&mut store, account_id, &auth) {
                save_accounts(&store)?;
            }
        }
    }

    let account = store
        .accounts
        .into_iter()
        .find(|stored| stored.id == account_id)
        .context("Account not found")?;
    Ok((account, is_active))
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
    let AuthData::ClaudeCode { credentials, .. } = &account.auth_data else {
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

fn chatgpt_tokens_need_refresh(account: &StoredAccount) -> bool {
    match &account.auth_data {
        AuthData::ApiKey { .. }
        | AuthData::ClaudeCode { .. }
        | AuthData::ClaudeDesktop { .. }
        | AuthData::Cursor { .. } => false,
        AuthData::ChatGPT {
            id_token,
            access_token,
            ..
        } => chatgpt_tokens_need_refresh_at(id_token, access_token, Utc::now().timestamp()),
    }
}

fn chatgpt_tokens_need_refresh_at(id_token: &str, access_token: &str, now: i64) -> bool {
    id_token_needs_refresh_at(id_token, now) || token_expired_or_near_expiry_at(access_token, now)
}

fn id_token_needs_refresh_at(token: &str, now: i64) -> bool {
    match parse_jwt_exp(token) {
        Some(expiry) => expiry <= now + EXPIRY_SKEW_SECONDS,
        None => true,
    }
}

fn token_expired_or_near_expiry_at(token: &str, now: i64) -> bool {
    match parse_jwt_exp(token) {
        Some(expiry) => expiry <= now + EXPIRY_SKEW_SECONDS,
        None => false,
    }
}

fn resolve_refreshed_id_token(
    current_id_token: String,
    refreshed_id_token: Option<String>,
    now: i64,
) -> Result<String> {
    match refreshed_id_token {
        Some(id_token) if id_token_needs_refresh_at(&id_token, now) => {
            anyhow::bail!("Token refresh returned an invalid or expired id_token")
        }
        Some(id_token) => Ok(id_token),
        None if id_token_needs_refresh_at(&current_id_token, now) => {
            anyhow::bail!(
                "Token refresh did not return a fresh id_token; sign in to the account again"
            )
        }
        None => Ok(current_id_token),
    }
}

fn merge_refresh_response(
    current_id_token: String,
    current_refresh_token: String,
    refreshed: RefreshTokenResponse,
    now: i64,
) -> TokenRefreshUpdate {
    let (id_token, id_token_error) =
        match resolve_refreshed_id_token(current_id_token.clone(), refreshed.id_token, now) {
            Ok(id_token) => (id_token, None),
            Err(error) => (current_id_token, Some(error)),
        };

    TokenRefreshUpdate {
        id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token.unwrap_or(current_refresh_token),
        id_token_error,
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
            .timeout(Duration::from_secs(10))
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
#[cfg(test)]
mod tests {
    use super::{
        chatgpt_tokens_need_refresh, chatgpt_tokens_need_refresh_at, merge_refresh_response,
        reconcile_active_account_from_auth, resolve_refreshed_id_token, RefreshTokenResponse,
    };
    use crate::types::{AccountsStore, AuthData, AuthDotJson, StoredAccount, TokenData};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn jwt_with_exp(exp: i64) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("header.{payload}.signature")
    }

    fn account_jwt(account_id: &str, exp: i64, signature: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"exp":{exp},"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#
        ));
        format!("header.{payload}.{signature}")
    }

    #[test]
    fn refresh_required_when_id_token_expired_but_access_token_valid() {
        let now = 1_800_000_000;
        let id_token = jwt_with_exp(now - 3_600);
        let access_token = jwt_with_exp(now + 3_600);

        assert!(chatgpt_tokens_need_refresh_at(
            &id_token,
            &access_token,
            now
        ));
    }

    #[test]
    fn refresh_not_required_when_both_tokens_are_valid() {
        let now = 1_800_000_000;
        let id_token = jwt_with_exp(now + 3_600);
        let access_token = jwt_with_exp(now + 3_600);

        assert!(!chatgpt_tokens_need_refresh_at(
            &id_token,
            &access_token,
            now
        ));
    }

    #[test]
    fn refresh_required_when_access_token_expired() {
        let now = 1_800_000_000;
        let id_token = jwt_with_exp(now + 3_600);
        let access_token = jwt_with_exp(now - 3_600);

        assert!(chatgpt_tokens_need_refresh_at(
            &id_token,
            &access_token,
            now
        ));
    }

    #[test]
    fn expired_id_token_requires_replacement_from_refresh_response() {
        let now = 1_800_000_000;
        let current_id_token = jwt_with_exp(now - 3_600);

        let error = resolve_refreshed_id_token(current_id_token, None, now).unwrap_err();

        assert!(error
            .to_string()
            .contains("did not return a fresh id_token"));
    }

    #[test]
    fn valid_id_token_can_be_preserved_when_refresh_response_omits_it() {
        let now = 1_800_000_000;
        let current_id_token = jwt_with_exp(now + 3_600);

        let resolved = resolve_refreshed_id_token(current_id_token.clone(), None, now).unwrap();

        assert_eq!(resolved, current_id_token);
    }

    #[test]
    fn active_account_uses_fresh_tokens_from_live_auth() {
        let now = chrono::Utc::now().timestamp();
        let mut account = StoredAccount::new_chatgpt(
            "Active".into(),
            None,
            None,
            None,
            account_jwt("workspace-a", now - 3_600, "stored"),
            jwt_with_exp(now - 3_600),
            "stored-refresh".into(),
            Some("workspace-a".into()),
        );
        let local_id = account.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account.clone()],
            active_account_id: Some(local_id.clone()),
            ..AccountsStore::default()
        };
        let auth = AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: account_jwt("workspace-a", now + 3_600, "live"),
                access_token: jwt_with_exp(now + 3_600),
                refresh_token: "live-refresh".into(),
                account_id: Some("workspace-a".into()),
            }),
            last_refresh: None,
        };

        assert!(chatgpt_tokens_need_refresh(&account));
        assert!(reconcile_active_account_from_auth(
            &mut store, &local_id, &auth
        ));

        account = store.accounts.remove(0);
        assert!(!chatgpt_tokens_need_refresh(&account));
        let AuthData::ChatGPT { refresh_token, .. } = account.auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(refresh_token, "live-refresh");
    }

    #[test]
    fn inactive_account_does_not_use_live_auth() {
        let now = chrono::Utc::now().timestamp();
        let account = StoredAccount::new_chatgpt(
            "Inactive".into(),
            None,
            None,
            None,
            account_jwt("workspace-a", now - 3_600, "stored"),
            jwt_with_exp(now - 3_600),
            "stored-refresh".into(),
            Some("workspace-a".into()),
        );
        let local_id = account.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account],
            active_account_id: Some("different-local-account".into()),
            ..AccountsStore::default()
        };
        let auth = AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: account_jwt("workspace-a", now + 3_600, "live"),
                access_token: jwt_with_exp(now + 3_600),
                refresh_token: "live-refresh".into(),
                account_id: Some("workspace-a".into()),
            }),
            last_refresh: None,
        };

        assert!(!reconcile_active_account_from_auth(
            &mut store, &local_id, &auth
        ));
        let AuthData::ChatGPT { refresh_token, .. } = &store.accounts[0].auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(refresh_token, "stored-refresh");
    }

    #[test]
    fn rotated_refresh_token_is_retained_when_id_token_is_missing() {
        let now = 1_800_000_000;
        let current_id_token = jwt_with_exp(now - 3_600);
        let refreshed = RefreshTokenResponse {
            id_token: None,
            access_token: "new-access".into(),
            refresh_token: Some("rotated-refresh".into()),
        };

        let update = merge_refresh_response(
            current_id_token.clone(),
            "old-refresh".into(),
            refreshed,
            now,
        );

        assert_eq!(update.id_token, current_id_token);
        assert_eq!(update.refresh_token, "rotated-refresh");
        assert!(update.id_token_error.is_some());
    }
}
