//! Local OAuth server for handling Claude Code login flow.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tiny_http::{Header, Request, Response, Server};
use tokio::sync::oneshot;

use crate::types::{ClaudeCredential, OAuthLoginInfo, StoredAccount};

const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES: &str =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const PRIMARY_SERVICE_NAME: &str = "Claude Code-credentials";

#[derive(Debug, Clone)]
struct PkceCodes {
    code_verifier: String,
    code_challenge: String,
}

fn generate_pkce() -> PkceCodes {
    let mut bytes = [0u8; 64];
    rand::rng().fill_bytes(&mut bytes);

    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let digest = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);

    PkceCodes {
        code_verifier,
        code_challenge,
    }
}

fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn build_authorize_url(redirect_uri: &str, pkce: &PkceCodes, state: &str) -> String {
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPES),
        ("code_challenge", &pkce.code_challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];

    let query_string = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    format!("{AUTHORIZE_URL}?{query_string}")
}

#[derive(Debug, Clone, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ProfileResponse {
    #[serde(default)]
    account: Option<ProfileAccount>,
    #[serde(default)]
    organization: Option<ProfileOrganization>,
}

#[derive(Debug, Default, Deserialize)]
struct ProfileAccount {
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ProfileOrganization {
    #[serde(default)]
    organization_type: Option<String>,
    #[serde(default)]
    rate_limit_tier: Option<String>,
}

async fn exchange_code_for_tokens(
    redirect_uri: &str,
    pkce: &PkceCodes,
    code: &str,
    state: &str,
) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let body = json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": CLIENT_ID,
        "code_verifier": pkce.code_verifier,
        "state": state,
    });

    let resp = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("Failed to send Claude token exchange request")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Claude token exchange failed: {status} - {body}");
    }

    resp.json::<TokenResponse>()
        .await
        .context("Failed to parse Claude token exchange response")
}

async fn fetch_profile(access_token: &str) -> Option<ProfileResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .get(PROFILE_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    resp.json::<ProfileResponse>().await.ok()
}

fn build_credential_value(
    tokens: &TokenResponse,
    profile: Option<&ProfileResponse>,
) -> Result<String> {
    let mut oauth = serde_json::Map::new();
    oauth.insert("accessToken".to_string(), json!(tokens.access_token));
    oauth.insert("refreshToken".to_string(), json!(tokens.refresh_token));

    if let Some(expires_in) = tokens.expires_in {
        oauth.insert(
            "expiresAt".to_string(),
            json!(Utc::now().timestamp_millis() + expires_in * 1000),
        );
    }

    if let Some(scope) = &tokens.scope {
        let scopes: Vec<&str> = scope.split_whitespace().collect();
        oauth.insert("scopes".to_string(), json!(scopes));
    } else {
        let default_scopes: Vec<&str> = SCOPES.split_whitespace().collect();
        oauth.insert("scopes".to_string(), json!(default_scopes));
    }

    if let Some(profile) = profile {
        if let Some(org_type) = profile
            .organization
            .as_ref()
            .and_then(|o| o.organization_type.as_ref())
        {
            oauth.insert("subscriptionType".to_string(), json!(org_type));
        }
        if let Some(tier) = profile
            .organization
            .as_ref()
            .and_then(|o| o.rate_limit_tier.as_ref())
        {
            oauth.insert("rateLimitTier".to_string(), json!(tier));
        }
    }

    let value = Value::Object({
        let mut m = serde_json::Map::new();
        m.insert("claudeAiOauth".to_string(), Value::Object(oauth));
        m
    });

    serde_json::to_string(&value).context("Failed to serialize Claude credential value")
}

fn current_user_account_name() -> String {
    std::env::var("USER")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

pub struct ClaudeOAuthLoginResult {
    pub account: StoredAccount,
}

pub async fn start_claude_oauth_login(
    account_name: String,
) -> Result<(
    OAuthLoginInfo,
    oneshot::Receiver<Result<ClaudeOAuthLoginResult>>,
    Arc<AtomicBool>,
)> {
    let pkce = generate_pkce();
    let state = generate_state();

    println!("[ClaudeOAuth] Starting login for account: {account_name}");

    let server = Server::http("127.0.0.1:0")
        .map_err(|err| anyhow::anyhow!("Failed to start Claude OAuth callback server: {err}"))?;

    let actual_port = match server.server_addr().to_ip() {
        Some(addr) => addr.port(),
        None => anyhow::bail!("Failed to determine Claude OAuth server port"),
    };

    let redirect_uri = format!("http://localhost:{actual_port}/callback");
    let auth_url = build_authorize_url(&redirect_uri, &pkce, &state);

    println!("[ClaudeOAuth] Server started on port {actual_port}");
    println!("[ClaudeOAuth] Redirect URI: {redirect_uri}");

    let login_info = OAuthLoginInfo {
        auth_url: auth_url.clone(),
        callback_port: actual_port,
    };

    let (tx, rx) = oneshot::channel();
    let cancelled = Arc::new(AtomicBool::new(false));

    let server = Arc::new(server);
    let pkce_clone = pkce.clone();
    let state_clone = state.clone();
    let cancelled_clone = cancelled.clone();
    let redirect_uri_clone = redirect_uri.clone();

    thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(run_oauth_server(
            server,
            pkce_clone,
            state_clone,
            redirect_uri_clone,
            account_name,
            cancelled_clone,
        ));
        let _ = tx.send(result);
    });

    Ok((login_info, rx, cancelled))
}

async fn run_oauth_server(
    server: Arc<Server>,
    pkce: PkceCodes,
    expected_state: String,
    redirect_uri: String,
    account_name: String,
    cancelled: Arc<AtomicBool>,
) -> Result<ClaudeOAuthLoginResult> {
    let timeout = Duration::from_secs(300);
    let start = std::time::Instant::now();

    loop {
        if cancelled.load(Ordering::Relaxed) {
            anyhow::bail!("Claude OAuth login cancelled");
        }

        if start.elapsed() > timeout {
            anyhow::bail!("Claude OAuth login timed out");
        }

        let request = match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(req)) => req,
            Ok(None) => continue,
            Err(_) => continue,
        };

        let result =
            handle_oauth_request(request, &pkce, &expected_state, &redirect_uri, &account_name)
                .await;

        match result {
            HandleResult::Continue => continue,
            HandleResult::Success(account) => {
                server.unblock();
                return Ok(ClaudeOAuthLoginResult { account });
            }
            HandleResult::Error(e) => {
                server.unblock();
                return Err(e);
            }
        }
    }
}

enum HandleResult {
    Continue,
    Success(StoredAccount),
    Error(anyhow::Error),
}

async fn handle_oauth_request(
    request: Request,
    pkce: &PkceCodes,
    expected_state: &str,
    redirect_uri: &str,
    account_name: &str,
) -> HandleResult {
    let url_str = request.url().to_string();
    let parsed = match url::Url::parse(&format!("http://localhost{url_str}")) {
        Ok(u) => u,
        Err(_) => {
            let _ = request.respond(Response::from_string("Bad Request").with_status_code(400));
            return HandleResult::Continue;
        }
    };

    let path = parsed.path();

    if path != "/callback" {
        let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
        return HandleResult::Continue;
    }

    println!("[ClaudeOAuth] Received callback request");
    let params: std::collections::HashMap<String, String> =
        parsed.query_pairs().into_owned().collect();

    if let Some(error) = params.get("error") {
        let error_desc = params
            .get("error_description")
            .map(|s| s.as_str())
            .unwrap_or("Unknown error");
        println!("[ClaudeOAuth] Error from provider: {error} - {error_desc}");
        let _ = request.respond(
            Response::from_string(format!("OAuth Error: {error} - {error_desc}"))
                .with_status_code(400),
        );
        return HandleResult::Error(anyhow::anyhow!("OAuth error: {error} - {error_desc}"));
    }

    let returned_state = params.get("state").map(String::as_str).unwrap_or_default();
    if returned_state != expected_state {
        println!("[ClaudeOAuth] State mismatch!");
        let _ = request.respond(Response::from_string("State mismatch").with_status_code(400));
        return HandleResult::Error(anyhow::anyhow!("OAuth state mismatch"));
    }

    let code = match params.get("code") {
        Some(c) if !c.is_empty() => c.clone(),
        _ => {
            println!("[ClaudeOAuth] Missing authorization code");
            let _ = request.respond(
                Response::from_string("Missing authorization code").with_status_code(400),
            );
            return HandleResult::Error(anyhow::anyhow!("Missing authorization code"));
        }
    };

    println!("[ClaudeOAuth] Got authorization code, exchanging for tokens...");

    let tokens = match exchange_code_for_tokens(redirect_uri, pkce, &code, expected_state).await {
        Ok(tokens) => tokens,
        Err(e) => {
            println!("[ClaudeOAuth] Token exchange failed: {e}");
            let _ = request.respond(
                Response::from_string(format!("Token exchange failed: {e}"))
                    .with_status_code(500),
            );
            return HandleResult::Error(e);
        }
    };

    println!("[ClaudeOAuth] Token exchange successful");

    let profile = fetch_profile(&tokens.access_token).await;
    let email = profile
        .as_ref()
        .and_then(|p| p.account.as_ref().and_then(|account| account.email.clone()));
    let plan_type = profile.as_ref().and_then(|p| {
        p.organization
            .as_ref()
            .and_then(|o| o.organization_type.clone())
    });

    let credential_value = match build_credential_value(&tokens, profile.as_ref()) {
        Ok(value) => value,
        Err(e) => {
            let _ = request.respond(
                Response::from_string(format!("Failed to build credential: {e}"))
                    .with_status_code(500),
            );
            return HandleResult::Error(e);
        }
    };

    let credential = ClaudeCredential {
        service_name: PRIMARY_SERVICE_NAME.to_string(),
        account_name: current_user_account_name(),
        value: credential_value,
    };

    let account = StoredAccount::new_claude_code(
        account_name.to_string(),
        email,
        plan_type,
        vec![credential],
    );

    let success_html = r#"<!DOCTYPE html>
<html>
<head>
    <title>Claude Login Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #d97706 0%, #b45309 100%); }
        .container { text-align: center; background: white; padding: 40px 60px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        h1 { color: #333; margin-bottom: 10px; }
        p { color: #666; }
        .checkmark { font-size: 48px; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="checkmark">✓</div>
        <h1>Claude Login Successful!</h1>
        <p>You can close this window and return to AI Switcher.</p>
    </div>
</body>
</html>"#;

    let response = Response::from_string(success_html).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap(),
    );
    let _ = request.respond(response);

    HandleResult::Success(account)
}

pub async fn wait_for_claude_oauth_login(
    rx: oneshot::Receiver<Result<ClaudeOAuthLoginResult>>,
) -> Result<StoredAccount> {
    let result = rx.await.context("Claude OAuth login was cancelled")??;
    Ok(result.account)
}
