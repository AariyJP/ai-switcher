//! Usage API client for fetching rate limits and credits

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures::{stream, StreamExt};
use reqwest::{
    header::{
        HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, REFERER,
        USER_AGENT,
    },
    StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::auth::{
    ensure_chatgpt_tokens_fresh, ensure_claude_tokens_fresh, extract_claude_desktop_token,
    fetch_claude_desktop_profile_metadata, refresh_chatgpt_tokens, refresh_claude_tokens,
    sync_active_claude_account_credentials,
};
use crate::types::{
    AuthData, ClaudeCredential, ClaudeDesktopSession, CodexRateLimitResetConsumeResult,
    CodexRateLimitResetCredits, CodexRateLimitResetOutcome, CreditStatusDetails, RateLimitDetails,
    RateLimitStatusPayload, RateLimitWindow, StoredAccount, UsageInfo,
};

const CHATGPT_BACKEND_API: &str = "https://chatgpt.com/backend-api";
const CHATGPT_ACCOUNTS_CHECK_API: &str =
    "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_CODEX_RESPONSES_API: &str = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_RATE_LIMIT_RESET_CREDITS_API: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CHATGPT_RATE_LIMIT_RESET_CREDITS_CONSUME_API: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const OPENAI_API: &str = "https://api.openai.com/v1";
const CODEX_USER_AGENT: &str = "codex-cli/1.0.0";
const CLAUDE_API: &str = "https://api.anthropic.com/api";
const CLAUDE_MESSAGES_API: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_ANTHROPIC_VERSION: &str = "2023-06-01";
const CLAUDE_WARMUP_MODEL: &str = "claude-haiku-4-5";
const CLAUDE_USER_AGENT: &str = "claude-code/2.1.142";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_AI_API: &str = "https://claude.ai/api";
const CLAUDE_DESKTOP_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct ChatGptAccountMetadata {
    pub plan_type: Option<String>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ClaudeDesktopAccountMetadata {
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckResponse {
    #[serde(default)]
    accounts: HashMap<String, AccountsCheckEntry>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntry {
    #[serde(default)]
    account: Option<AccountsCheckAccount>,
    #[serde(default)]
    entitlement: Option<AccountsCheckEntitlement>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckAccount {
    #[serde(default)]
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntitlement {
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
struct ConsumeRateLimitResetCreditRequest {
    redeem_request_id: String,
}

#[derive(Debug, Deserialize)]
struct ConsumeRateLimitResetCreditResponse {
    code: CodexRateLimitResetOutcome,
}

#[derive(Debug, Deserialize)]
struct ClaudeStoredCredential {
    #[serde(rename = "claudeAiOauth", default)]
    claude_ai_oauth: Option<ClaudeOauthCredentials>,
}

#[derive(Debug, Clone, Deserialize)]
struct ClaudeOauthCredentials {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "subscriptionType", default)]
    subscription_type: Option<String>,
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Clone)]
struct ClaudeUsageLimit {
    used_percent: f64,
    resets_at: Option<i64>,
}

/// Get usage information for an account
pub async fn get_account_usage(account: &StoredAccount) -> Result<UsageInfo> {
    println!("[Usage] Fetching usage for account: {}", account.name);

    match &account.auth_data {
        AuthData::ApiKey { .. } => {
            println!("[Usage] API key accounts don't support usage info");
            Ok(UsageInfo {
                account_id: account.id.clone(),
                plan_type: Some("api_key".to_string()),
                primary_used_percent: None,
                primary_window_minutes: None,
                primary_resets_at: None,
                secondary_used_percent: None,
                secondary_window_minutes: None,
                secondary_resets_at: None,
                has_credits: None,
                unlimited_credits: None,
                credits_balance: None,
                rate_limit_reset_available_count: None,
                rate_limit_reset_credits: None,
                rate_limit_reset_error: None,
                error: Some("Usage info not available for API key accounts".to_string()),
            })
        }
        AuthData::ClaudeCode { .. } => get_usage_with_claude_auth(account).await,
        AuthData::ChatGPT { .. } => get_usage_with_chatgpt_auth(account).await,
        AuthData::ClaudeDesktop { .. } => get_usage_with_claude_desktop_auth(account).await,
    }
}

/// Send a minimal authenticated request to warm up account traffic paths.
pub async fn warmup_account(account: &StoredAccount) -> Result<()> {
    println!(
        "[Warmup] Sending warm-up request for account: {}",
        account.name
    );

    match &account.auth_data {
        AuthData::ApiKey { key } => warmup_with_api_key(key).await,
        AuthData::ChatGPT { .. } => warmup_with_chatgpt_auth(account).await,
        AuthData::ClaudeCode { .. } => warmup_with_claude_auth(account).await,
        AuthData::ClaudeDesktop { .. } => warmup_with_claude_desktop_auth(account).await,
    }
}

pub async fn fetch_chatgpt_account_metadata(
    account: &StoredAccount,
) -> Result<ChatGptAccountMetadata> {
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(account)?;
    let response =
        send_chatgpt_get_request(CHATGPT_ACCOUNTS_CHECK_API, access_token, chatgpt_account_id)
            .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Accounts check API error: {status} - {body}");
    }

    let payload: AccountsCheckResponse = response
        .json()
        .await
        .context("Failed to parse accounts check response")?;

    let selected_entry = chatgpt_account_id
        .and_then(|account_id| payload.accounts.get(account_id))
        .or_else(|| payload.accounts.get("default"))
        .or_else(|| payload.accounts.values().next())
        .context("Accounts check response did not include an account entry")?;

    Ok(ChatGptAccountMetadata {
        plan_type: selected_entry
            .account
            .as_ref()
            .and_then(|account| account.plan_type.clone()),
        subscription_expires_at: selected_entry
            .entitlement
            .as_ref()
            .and_then(|entitlement| entitlement.expires_at),
    })
}

pub async fn fetch_claude_desktop_account_metadata(
    account: &StoredAccount,
) -> Result<ClaudeDesktopAccountMetadata> {
    let AuthData::ClaudeDesktop {
        oauth_token_cache,
        oauth_token_cache_v2,
        ..
    } = &account.auth_data
    else {
        anyhow::bail!("Account is not a Claude Desktop account");
    };

    let metadata =
        fetch_claude_desktop_profile_metadata(oauth_token_cache, oauth_token_cache_v2.as_deref())
            .await
            .context("Failed to fetch Claude Desktop profile")?;

    Ok(ClaudeDesktopAccountMetadata {
        email: metadata.email,
        plan_type: metadata.plan_type,
    })
}

pub async fn consume_codex_rate_limit_reset_credit(
    account: &StoredAccount,
) -> Result<CodexRateLimitResetConsumeResult> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;
    let request_id = uuid::Uuid::new_v4().to_string();

    let response = send_chatgpt_rate_limit_reset_consume_request(
        access_token,
        chatgpt_account_id,
        &request_id,
    )
    .await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        let retry_response = send_chatgpt_rate_limit_reset_consume_request(
            retry_token,
            retry_account_id,
            &request_id,
        )
        .await?;
        return parse_rate_limit_reset_consume_response(retry_response).await;
    }

    parse_rate_limit_reset_consume_response(response).await
}

async fn get_usage_with_chatgpt_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let response = send_chatgpt_usage_request(access_token, chatgpt_account_id).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Usage] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        let retry_response = send_chatgpt_usage_request(retry_token, retry_account_id).await?;
        let usage = parse_usage_response(
            &refreshed_account.id,
            &refreshed_account.name,
            retry_response,
        )
        .await?;
        return Ok(attach_rate_limit_reset_credits(usage, retry_token, retry_account_id).await);
    }

    let usage = parse_usage_response(&fresh_account.id, &fresh_account.name, response).await?;
    Ok(attach_rate_limit_reset_credits(usage, access_token, chatgpt_account_id).await)
}

async fn get_usage_with_claude_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let synced_account = sync_active_claude_account_credentials(account)
        .ok()
        .flatten()
        .unwrap_or_else(|| account.clone());
    let fresh_account = match ensure_claude_tokens_fresh(&synced_account).await {
        Ok(account) => account,
        Err(err) => {
            println!(
                "[Usage] Claude pre-refresh failed for account {}: {}",
                synced_account.name, err
            );
            synced_account.clone()
        }
    };
    let oauth = extract_claude_auth(&fresh_account)?;

    let response = send_claude_usage_request(&oauth.access_token).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Usage] Unauthorized for Claude account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let retry_source = sync_active_claude_account_credentials(&fresh_account)
            .ok()
            .flatten()
            .unwrap_or_else(|| fresh_account.clone());
        let refreshed_account = match refresh_claude_tokens(&retry_source).await {
            Ok(account) => account,
            Err(err) => {
                return Ok(UsageInfo::error(
                    retry_source.id.clone(),
                    format_claude_auth_error(&err.to_string()),
                ));
            }
        };
        let retry_oauth = extract_claude_auth(&refreshed_account)?;
        let retry_response = send_claude_usage_request(&retry_oauth.access_token).await?;
        if retry_response.status() == StatusCode::UNAUTHORIZED {
            return Ok(UsageInfo::error(
                refreshed_account.id.clone(),
                "Claude login expired. Open Claude Code and sign in again, then import the current Claude account again.".to_string(),
            ));
        }
        return parse_claude_usage_response(&refreshed_account, retry_oauth, retry_response).await;
    }

    parse_claude_usage_response(&fresh_account, oauth, response).await
}

async fn parse_usage_response(
    account_id: &str,
    account_name: &str,
    response: reqwest::Response,
) -> Result<UsageInfo> {
    let status = response.status();
    println!("[Usage] Response status: {status}");

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        println!("[Usage] Error response: {body}");
        return Ok(UsageInfo::error(
            account_id.to_string(),
            format!("API error: {status}"),
        ));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read response body")?;
    println!(
        "[Usage] Response body: {}",
        &body_text[..body_text.len().min(200)]
    );

    let payload: RateLimitStatusPayload =
        serde_json::from_str(&body_text).context("Failed to parse usage response")?;

    println!("[Usage] Parsed plan_type: {}", payload.plan_type);

    let usage = convert_payload_to_usage_info(account_id, payload);
    println!(
        "[Usage] {} - primary: {:?}%, plan: {:?}",
        account_name, usage.primary_used_percent, usage.plan_type
    );

    Ok(usage)
}

async fn attach_rate_limit_reset_credits(
    mut usage: UsageInfo,
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> UsageInfo {
    match fetch_rate_limit_reset_credits(access_token, chatgpt_account_id).await {
        Ok(reset_credits) => {
            usage.rate_limit_reset_available_count = Some(reset_credits.available_count);
            usage.rate_limit_reset_credits = Some(reset_credits);
        }
        Err(err) => {
            eprintln!("[Usage] Failed to fetch rate limit reset credits: {err}");
            usage.rate_limit_reset_error = Some(err.to_string());
        }
    }
    usage
}

async fn fetch_rate_limit_reset_credits(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<CodexRateLimitResetCredits> {
    let response = send_chatgpt_get_request(
        CHATGPT_RATE_LIMIT_RESET_CREDITS_API,
        access_token,
        chatgpt_account_id,
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Rate limit reset credits API error: {status} - {body}");
    }

    response
        .json()
        .await
        .context("Failed to parse rate limit reset credits response")
}

async fn parse_rate_limit_reset_consume_response(
    response: reqwest::Response,
) -> Result<CodexRateLimitResetConsumeResult> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Rate limit reset consume API error: {status} - {body}");
    }

    let payload: ConsumeRateLimitResetCreditResponse = response
        .json()
        .await
        .context("Failed to parse rate limit reset consume response")?;
    Ok(CodexRateLimitResetConsumeResult {
        outcome: payload.code,
    })
}

async fn get_usage_with_claude_desktop_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let AuthData::ClaudeDesktop { session, .. } = &account.auth_data else {
        anyhow::bail!("Account is not a Claude Desktop account");
    };

    let org_uuid = session
        .org_uuid
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            session
                .cookies
                .iter()
                .find(|cookie| cookie.name == "lastActiveOrg")
                .map(|cookie| cookie.value.clone())
                .filter(|value| !value.is_empty())
        })
        .context(
            "Claude Desktop account is missing its organization id. Re-import the account from Claude Desktop.",
        )?;

    let response = send_claude_desktop_usage_request(session, &org_uuid).await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        println!("[Usage] Claude Desktop error response: {body}");
        let message = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            "Claude Desktop session expired or was blocked. Open Claude Desktop, sign in, then re-import this account.".to_string()
        } else {
            format!("Claude Desktop usage API error: {status}")
        };
        return Ok(UsageInfo::error(account.id.clone(), message));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read Claude Desktop usage response body")?;
    println!(
        "[Usage] Claude Desktop response body: {}",
        &body_text[..body_text.len().min(200)]
    );

    let payload: Value = serde_json::from_str(&body_text)
        .context("Failed to parse Claude Desktop usage response")?;
    let usage = convert_claude_payload_to_usage_info(account, account.plan_type.clone(), &payload);
    println!(
        "[Usage] {} - Claude Desktop primary: {:?}%, plan: {:?}",
        account.name, usage.primary_used_percent, usage.plan_type
    );

    Ok(usage)
}

async fn send_claude_desktop_usage_request(
    session: &ClaudeDesktopSession,
    org_uuid: &str,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let url = format!("{CLAUDE_AI_API}/organizations/{org_uuid}/usage");

    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(CLAUDE_DESKTOP_USER_AGENT),
    );
    headers.insert(REFERER, HeaderValue::from_static("https://claude.ai/"));
    headers.insert(
        HeaderName::from_static("anthropic-client-platform"),
        HeaderValue::from_static("web_claude_ai"),
    );
    headers.insert(
        HeaderName::from_static("anthropic-client-version"),
        HeaderValue::from_static("1.0.0"),
    );
    if let Some(device_id) = session.device_id.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(value) = HeaderValue::from_str(device_id) {
            headers.insert(HeaderName::from_static("anthropic-device-id"), value);
        }
    }
    if let Ok(cookie_header) = HeaderValue::from_str(&build_cookie_header(session)) {
        headers.insert(COOKIE, cookie_header);
    }

    println!("[Usage] Requesting Claude Desktop usage: {url}");

    client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("Failed to send Claude Desktop usage request to {url}"))
}

fn build_cookie_header(session: &ClaudeDesktopSession) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts = Vec::new();
    for cookie in &session.cookies {
        if cookie.name.is_empty() || cookie.value.is_empty() {
            continue;
        }
        if !seen.insert(cookie.name.as_str()) {
            continue;
        }
        parts.push(format!("{}={}", cookie.name, cookie.value));
    }
    if !seen.contains("sessionKey") && !session.session_key.is_empty() {
        parts.push(format!("sessionKey={}", session.session_key));
    }
    parts.join("; ")
}

async fn parse_claude_usage_response(
    account: &StoredAccount,
    oauth: ClaudeOauthCredentials,
    response: reqwest::Response,
) -> Result<UsageInfo> {
    let status = response.status();
    println!("[Usage] Claude response status: {status}");

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        println!("[Usage] Claude error response: {body}");
        return Ok(UsageInfo::error(
            account.id.clone(),
            format!("Claude usage API error: {status}"),
        ));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read Claude usage response body")?;
    println!(
        "[Usage] Claude response body: {}",
        &body_text[..body_text.len().min(200)]
    );

    let payload: Value =
        serde_json::from_str(&body_text).context("Failed to parse Claude usage response")?;
    let usage = convert_claude_payload_to_usage_info(account, oauth.subscription_type, &payload);
    println!(
        "[Usage] {} - Claude primary: {:?}%, plan: {:?}",
        account.name, usage.primary_used_percent, usage.plan_type
    );

    Ok(usage)
}

async fn warmup_with_chatgpt_auth(account: &StoredAccount) -> Result<()> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let mut response = send_chatgpt_warmup_request(access_token, chatgpt_account_id, true).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Warmup] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        response = send_chatgpt_warmup_request(retry_token, retry_account_id, true).await?;
    }

    finish_warmup("ChatGPT", response, true).await
}

async fn warmup_with_api_key(api_key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let payload = build_warmup_payload(false, true);
    let response = client
        .post(format!("{OPENAI_API}/responses"))
        .header(USER_AGENT, CODEX_USER_AGENT)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .json(&payload)
        .send()
        .await
        .context("Failed to send API key warm-up request")?;

    finish_warmup("API key", response, false).await
}

async fn warmup_with_claude_auth(account: &StoredAccount) -> Result<()> {
    let synced_account = sync_active_claude_account_credentials(account)
        .ok()
        .flatten()
        .unwrap_or_else(|| account.clone());
    let fresh_account = match ensure_claude_tokens_fresh(&synced_account).await {
        Ok(account) => account,
        Err(err) => {
            println!(
                "[Warmup] Claude pre-refresh failed for account {}: {}",
                synced_account.name, err
            );
            synced_account.clone()
        }
    };
    let oauth = extract_claude_auth(&fresh_account)?;

    let response = send_claude_warmup_request(&oauth.access_token).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Warmup] Unauthorized for Claude account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let retry_source = sync_active_claude_account_credentials(&fresh_account)
            .ok()
            .flatten()
            .unwrap_or_else(|| fresh_account.clone());
        let refreshed_account = refresh_claude_tokens(&retry_source).await?;
        let retry_oauth = extract_claude_auth(&refreshed_account)?;
        let retry_response = send_claude_warmup_request(&retry_oauth.access_token).await?;
        return finish_warmup("Claude Code", retry_response, false).await;
    }

    finish_warmup("Claude Code", response, false).await
}

async fn warmup_with_claude_desktop_auth(account: &StoredAccount) -> Result<()> {
    let AuthData::ClaudeDesktop {
        oauth_token_cache,
        oauth_token_cache_v2,
        ..
    } = &account.auth_data
    else {
        anyhow::bail!("Account is not a Claude Desktop account");
    };
    let access_token = match oauth_token_cache_v2.as_deref() {
        Some(cache) => extract_claude_desktop_token(cache)?,
        None => extract_claude_desktop_token(oauth_token_cache)?,
    };

    let response = send_claude_warmup_request(&access_token).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        anyhow::bail!(
            "Claude Desktop token was rejected. Re-import the account from Claude Desktop."
        );
    }

    finish_warmup("Claude Desktop", response, false).await
}

async fn finish_warmup(source: &str, response: reqwest::Response, is_sse: bool) -> Result<()> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        println!("[Warmup] {source} warm-up error response: {body}");
        anyhow::bail!("{source} warm-up failed with status {status}");
    }

    let body = response.text().await.unwrap_or_default();
    log_warmup_response(source, &body, is_sse);
    Ok(())
}

fn build_claude_warmup_payload() -> serde_json::Value {
    json!({
        "model": CLAUDE_WARMUP_MODEL,
        "max_tokens": 1,
        "system": "You are Claude Code, Anthropic's official CLI for Claude.",
        "messages": [
            {
                "role": "user",
                "content": "Hi"
            }
        ]
    })
}

fn build_warmup_payload(stream: bool, include_max_output_tokens: bool) -> serde_json::Value {
    let mut payload = json!({
        "model": "gpt-5.4-mini",
        "instructions": "You are Codex.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "Hi"
                    }
                ]
            }
        ],
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "reasoning": {
            "effort": "low"
        },
        "store": false,
        "stream": stream
    });

    if include_max_output_tokens {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("max_output_tokens".to_string(), json!(1));
        }
    }

    payload
}

fn build_chatgpt_headers(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_USER_AGENT));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}")).context("Invalid access token")?,
    );

    if let Some(acc_id) = chatgpt_account_id {
        println!("[Usage] Using ChatGPT Account ID: {acc_id}");
        if let Ok(header_name) = HeaderName::from_bytes(b"chatgpt-account-id") {
            if let Ok(header_value) = HeaderValue::from_str(acc_id) {
                headers.insert(header_name, header_value);
            }
        }
    }

    Ok(headers)
}

fn extract_chatgpt_auth(account: &StoredAccount) -> Result<(&str, Option<&str>)> {
    match &account.auth_data {
        AuthData::ChatGPT {
            access_token,
            account_id,
            ..
        } => Ok((access_token.as_str(), account_id.as_deref())),
        AuthData::ApiKey { .. } | AuthData::ClaudeCode { .. } | AuthData::ClaudeDesktop { .. } => {
            anyhow::bail!("Account is not using ChatGPT OAuth")
        }
    }
}

fn extract_claude_auth(account: &StoredAccount) -> Result<ClaudeOauthCredentials> {
    match &account.auth_data {
        AuthData::ClaudeCode { credentials, .. } => {
            find_claude_oauth_credentials(credentials).context("Claude OAuth credentials not found")
        }
        AuthData::ApiKey { .. } | AuthData::ChatGPT { .. } | AuthData::ClaudeDesktop { .. } => {
            anyhow::bail!("Account is not using Claude Code OAuth")
        }
    }
}

fn find_claude_oauth_credentials(
    credentials: &[ClaudeCredential],
) -> Option<ClaudeOauthCredentials> {
    let mut fallback = None;

    for credential in credentials {
        let Ok(parsed) = serde_json::from_str::<ClaudeStoredCredential>(&credential.value) else {
            continue;
        };
        let Some(oauth) = parsed.claude_ai_oauth else {
            continue;
        };
        let is_primary_service = credential.service_name == "Claude Code-credentials";
        let has_plan_metadata =
            oauth.subscription_type.is_some() || oauth.rate_limit_tier.is_some();

        if is_primary_service || has_plan_metadata {
            return Some(oauth);
        }

        if fallback.is_none() {
            fallback = Some(oauth);
        }
    }

    fallback
}

async fn send_chatgpt_usage_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    send_chatgpt_get_request(
        &format!("{CHATGPT_BACKEND_API}/wham/usage"),
        access_token,
        chatgpt_account_id,
    )
    .await
}

async fn send_chatgpt_rate_limit_reset_consume_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
    redeem_request_id: &str,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    let payload = ConsumeRateLimitResetCreditRequest {
        redeem_request_id: redeem_request_id.to_string(),
    };

    client
        .post(CHATGPT_RATE_LIMIT_RESET_CREDITS_CONSUME_API)
        .headers(headers)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .json(&payload)
        .send()
        .await
        .context("Failed to consume ChatGPT rate limit reset credit")
}

fn build_claude_headers(access_token: &str, with_version: bool) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(CLAUDE_USER_AGENT));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}")).context("Invalid access token")?,
    );
    if with_version {
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static(CLAUDE_ANTHROPIC_VERSION),
        );
    }
    headers.insert(
        HeaderName::from_static("anthropic-beta"),
        HeaderValue::from_static(CLAUDE_OAUTH_BETA),
    );
    Ok(headers)
}

async fn send_claude_usage_request(access_token: &str) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let url = format!("{CLAUDE_API}/oauth/usage");
    let headers = build_claude_headers(access_token, false)?;

    println!("[Usage] Requesting Claude usage: {url}");

    client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("Failed to send Claude usage request to {url}"))
}

async fn send_claude_warmup_request(access_token: &str) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_claude_headers(access_token, true)?;
    let payload = build_claude_warmup_payload();

    client
        .post(CLAUDE_MESSAGES_API)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .context("Failed to send Claude warm-up request")
}

async fn send_chatgpt_get_request(
    url: &str,
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    println!("[Usage] Requesting: {url}");

    client
        .get(url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("Failed to send GET request to {url}"))
}

async fn send_chatgpt_warmup_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
    stream: bool,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    let payload = build_warmup_payload(stream, false);

    client
        .post(CHATGPT_CODEX_RESPONSES_API)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .context("Failed to send ChatGPT warm-up request")
}

fn log_warmup_response(source: &str, body: &str, is_sse: bool) {
    if body.trim().is_empty() {
        println!("[Warmup] {source} warm-up response was empty");
        return;
    }

    let preview = truncate_text(body, 300);
    println!("[Warmup] {source} warm-up response preview: {preview}");

    let extracted = if is_sse {
        extract_text_from_sse(body)
    } else {
        extract_text_from_json(body)
    };

    if let Some(message) = extracted {
        let message_preview = truncate_text(&message, 200);
        println!("[Warmup] {source} warm-up message: {message_preview}");
    }
}

fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    let mut out = text[..max_len].to_string();
    out.push_str("...");
    out
}

fn extract_text_from_sse(body: &str) -> Option<String> {
    let mut last_text: Option<String> = None;
    for line in body.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let data = line.trim_start_matches("data:").trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if let Some(text) = extract_last_text_from_value(&value) {
                last_text = Some(text);
            }
        }
    }
    last_text.filter(|text| !text.trim().is_empty())
}

fn extract_text_from_json(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    extract_last_text_from_value(&value)
}

fn extract_last_text_from_value(value: &Value) -> Option<String> {
    let mut last: Option<String> = None;
    collect_last_text(value, &mut last);
    last
}

fn collect_last_text(value: &Value, last: &mut Option<String>) {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                if matches!(key.as_str(), "text" | "delta" | "output_text") {
                    if let Value::String(text) = val {
                        if !text.is_empty() {
                            *last = Some(text.clone());
                        }
                    }
                }
                collect_last_text(val, last);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_last_text(item, last);
            }
        }
        _ => {}
    }
}

/// Convert API response to UsageInfo
fn convert_payload_to_usage_info(account_id: &str, payload: RateLimitStatusPayload) -> UsageInfo {
    let (primary, secondary) = extract_rate_limits(payload.rate_limit);
    let credits = extract_credits(payload.credits);
    let rate_limit_reset_available_count = payload
        .rate_limit_reset_credits
        .as_ref()
        .map(|summary| summary.available_count);

    UsageInfo {
        account_id: account_id.to_string(),
        plan_type: Some(payload.plan_type),
        primary_used_percent: primary.as_ref().map(|w| w.used_percent),
        primary_window_minutes: primary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        primary_resets_at: primary.as_ref().and_then(|w| w.reset_at),
        secondary_used_percent: secondary.as_ref().map(|w| w.used_percent),
        secondary_window_minutes: secondary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        secondary_resets_at: secondary.as_ref().and_then(|w| w.reset_at),
        has_credits: credits.as_ref().map(|c| c.has_credits),
        unlimited_credits: credits.as_ref().map(|c| c.unlimited),
        credits_balance: credits.and_then(|c| c.balance),
        rate_limit_reset_available_count,
        rate_limit_reset_credits: None,
        rate_limit_reset_error: None,
        error: None,
    }
}

fn convert_claude_payload_to_usage_info(
    account: &StoredAccount,
    plan_type: Option<String>,
    payload: &Value,
) -> UsageInfo {
    let primary = extract_claude_limit(payload, "five_hour");
    let secondary = extract_claude_limit(payload, "seven_day")
        .or_else(|| extract_claude_limit(payload, "seven_day_sonnet"));
    let credits_balance = extract_claude_credits(payload);
    let extra_usage = payload.get("extra_usage");
    let has_credits = credits_balance
        .as_ref()
        .map(|_| true)
        .or_else(|| {
            extra_usage
                .and_then(|value| value.get("is_enabled"))
                .and_then(Value::as_bool)
        })
        .or_else(|| extract_bool_field(payload, &["has_credits", "hasCredits"]));
    let unlimited_credits = extra_usage
        .and_then(|value| value.get("monthly_limit"))
        .map(Value::is_null)
        .or_else(|| extract_bool_field(payload, &["unlimited_credits", "unlimitedCredits"]));

    UsageInfo {
        account_id: account.id.clone(),
        plan_type: plan_type
            .or_else(|| account.plan_type.clone())
            .or_else(|| Some("claude".to_string())),
        primary_used_percent: primary.as_ref().map(|limit| limit.used_percent),
        primary_window_minutes: primary.as_ref().map(|_| 5 * 60),
        primary_resets_at: primary.as_ref().and_then(|limit| limit.resets_at),
        secondary_used_percent: secondary.as_ref().map(|limit| limit.used_percent),
        secondary_window_minutes: secondary.as_ref().map(|_| 7 * 24 * 60),
        secondary_resets_at: secondary.as_ref().and_then(|limit| limit.resets_at),
        has_credits,
        unlimited_credits,
        credits_balance,
        rate_limit_reset_available_count: None,
        rate_limit_reset_credits: None,
        rate_limit_reset_error: None,
        error: None,
    }
}

fn extract_claude_limit(payload: &Value, key: &str) -> Option<ClaudeUsageLimit> {
    let value = payload.get(key)?;
    let used_percent = extract_claude_used_percent(value)?;
    let resets_at =
        extract_timestamp_field(value, &["resets_at", "reset_at", "resetsAt", "resetAt"]);

    Some(ClaudeUsageLimit {
        used_percent,
        resets_at,
    })
}

fn extract_claude_used_percent(value: &Value) -> Option<f64> {
    if let Some(remaining) = extract_number_field(
        value,
        &[
            "remaining_percentage",
            "remaining_percent",
            "remainingPercentage",
            "remainingPercent",
        ],
    ) {
        return Some(100.0 - normalize_claude_percent(remaining));
    }

    extract_number_field(
        value,
        &[
            "utilization",
            "used_percentage",
            "used_percent",
            "usedPercentage",
            "usedPercent",
        ],
    )
    .map(normalize_claude_percent)
}

fn normalize_claude_percent(value: f64) -> f64 {
    let percent = if value <= 1.0 { value * 100.0 } else { value };
    if percent.is_finite() {
        percent.max(0.0).min(100.0)
    } else {
        0.0
    }
}

fn extract_claude_credits(payload: &Value) -> Option<String> {
    for key in [
        "credits_balance",
        "creditsBalance",
        "credit_balance",
        "creditBalance",
        "balance",
        "remaining_credits",
        "remainingCredits",
    ] {
        if let Some(text) = payload.get(key).and_then(value_to_display_string) {
            return Some(text);
        }
    }

    for key in ["credits", "creditBalance", "credit_balance"] {
        if let Some(value) = payload.get(key) {
            if let Some(text) = value_to_display_string(value) {
                return Some(text);
            }
            if let Some(text) = extract_value_field(
                value,
                &[
                    "credits_balance",
                    "creditsBalance",
                    "balance",
                    "remaining_credits",
                    "remainingCredits",
                ],
            )
            .and_then(value_to_display_string)
            {
                return Some(text);
            }
        }
    }

    payload
        .get("extra_usage")
        .and_then(extract_claude_extra_usage_credits)
}

fn extract_claude_extra_usage_credits(extra_usage: &Value) -> Option<String> {
    let used = extract_value_field(extra_usage, &["used_credits", "usedCredits"])
        .and_then(value_to_display_string)?;
    let limit = extract_value_field(extra_usage, &["monthly_limit", "monthlyLimit"])
        .filter(|value| !value.is_null())
        .and_then(value_to_display_string);

    limit
        .map(|limit| format!("{used} / {limit} spent"))
        .or_else(|| Some(format!("{used} spent")))
}

fn extract_value_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key))
}

fn extract_number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    extract_value_field(value, keys).and_then(value_to_f64)
}

fn extract_bool_field(value: &Value, keys: &[&str]) -> Option<bool> {
    extract_value_field(value, keys).and_then(Value::as_bool)
}

fn extract_timestamp_field(value: &Value, keys: &[&str]) -> Option<i64> {
    extract_value_field(value, keys).and_then(parse_claude_timestamp)
}

fn value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }
}

fn value_to_display_string(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn parse_claude_timestamp(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_f64().map(normalize_claude_timestamp),
        Value::String(text) => {
            if let Ok(timestamp) = text.parse::<f64>() {
                return Some(normalize_claude_timestamp(timestamp));
            }
            DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|timestamp| timestamp.timestamp())
        }
        _ => None,
    }
}

fn normalize_claude_timestamp(timestamp: f64) -> i64 {
    let seconds = if timestamp > 1_000_000_000_000.0 {
        timestamp / 1000.0
    } else {
        timestamp
    };
    seconds.round() as i64
}

fn format_claude_auth_error(error: &str) -> String {
    if error.contains("invalid_grant") {
        return "Claude refresh token is no longer valid. Open Claude Code and sign in again, then import the current Claude account again.".to_string();
    }

    if error.contains("Unauthorized") || error.contains("401") {
        return "Claude login expired. Open Claude Code and sign in again, then import the current Claude account again.".to_string();
    }

    error.to_string()
}

fn extract_rate_limits(
    rate_limit: Option<RateLimitDetails>,
) -> (Option<RateLimitWindow>, Option<RateLimitWindow>) {
    match rate_limit {
        Some(details) => (details.primary_window, details.secondary_window),
        None => (None, None),
    }
}

fn extract_credits(credits: Option<CreditStatusDetails>) -> Option<CreditStatusDetails> {
    credits
}

/// Refresh all account usage
pub async fn refresh_all_usage(accounts: &[StoredAccount]) -> Vec<UsageInfo> {
    println!("[Usage] Refreshing usage for {} accounts", accounts.len());

    let concurrency = accounts.len().min(10).max(1);
    let results: Vec<UsageInfo> = stream::iter(accounts.iter().cloned())
        .map(|account| async move {
            match get_account_usage(&account).await {
                Ok(info) => info,
                Err(e) => {
                    println!("[Usage] Error for {}: {}", account.name, e);
                    UsageInfo::error(account.id.clone(), e.to_string())
                }
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    println!("[Usage] Refresh complete");
    results
}
