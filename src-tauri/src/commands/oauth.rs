//! OAuth login Tauri commands

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::auth::claude_oauth::{
    start_claude_oauth_login, wait_for_claude_oauth_login, ClaudeOAuthLoginResult,
};
use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{
    add_account, load_accounts, set_active_account, switch_to_account, switch_to_claude_account,
    touch_account,
};
use crate::types::{AccountInfo, OAuthLoginInfo, ToolKind};

struct PendingOAuth {
    rx: oneshot::Receiver<anyhow::Result<OAuthLoginResult>>,
    cancelled: Arc<AtomicBool>,
}

struct PendingClaudeOAuth {
    rx: oneshot::Receiver<anyhow::Result<ClaudeOAuthLoginResult>>,
    cancelled: Arc<AtomicBool>,
}

// Global state for pending OAuth login
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);
static PENDING_CLAUDE_OAUTH: Mutex<Option<PendingClaudeOAuth>> = Mutex::new(None);

/// Start the OAuth login flow
#[tauri::command]
pub async fn start_login(account_name: String) -> Result<OAuthLoginInfo, String> {
    // Cancel any previous pending flow so it does not keep the callback port occupied.
    if let Some(previous) = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending.take()
    } {
        previous.cancelled.store(true, Ordering::Relaxed);
    }

    let (info, rx, cancelled) = start_oauth_login(account_name)
        .await
        .map_err(|e| e.to_string())?;

    // Store the receiver for later
    {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        *pending = Some(PendingOAuth { rx, cancelled });
    }

    Ok(info)
}

/// Wait for the OAuth login to complete and add the account
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let pending = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending
            .take()
            .ok_or_else(|| "No pending OAuth login".to_string())?
    };

    let account = wait_for_oauth_login(pending.rx)
        .await
        .map_err(|e| e.to_string())?;

    // Add the account to storage
    let stored = add_account(account).map_err(|e| e.to_string())?;

    // Make it active and switch to it
    set_active_account(&stored.id).map_err(|e| e.to_string())?;
    switch_to_account(&stored).map_err(|e| e.to_string())?;
    touch_account(&stored.id).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Cancel a pending OAuth login
#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    let mut pending = PENDING_OAUTH.lock().unwrap();
    if let Some(pending_oauth) = pending.take() {
        pending_oauth.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Start the Claude OAuth login flow
#[tauri::command]
pub async fn start_claude_login(account_name: String) -> Result<OAuthLoginInfo, String> {
    if let Some(previous) = {
        let mut pending = PENDING_CLAUDE_OAUTH.lock().unwrap();
        pending.take()
    } {
        previous.cancelled.store(true, Ordering::Relaxed);
    }

    let (info, rx, cancelled) = start_claude_oauth_login(account_name)
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut pending = PENDING_CLAUDE_OAUTH.lock().unwrap();
        *pending = Some(PendingClaudeOAuth { rx, cancelled });
    }

    Ok(info)
}

/// Wait for the Claude OAuth login to complete and add the account
#[tauri::command]
pub async fn complete_claude_login() -> Result<AccountInfo, String> {
    let pending = {
        let mut pending = PENDING_CLAUDE_OAUTH.lock().unwrap();
        pending
            .take()
            .ok_or_else(|| "No pending Claude OAuth login".to_string())?
    };

    let account = wait_for_claude_oauth_login(pending.rx)
        .await
        .map_err(|e| e.to_string())?;

    let stored = add_account(account).map_err(|e| e.to_string())?;

    set_active_account(&stored.id).map_err(|e| e.to_string())?;
    switch_to_claude_account(&stored).map_err(|e| e.to_string())?;
    touch_account(&stored.id).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id_for(ToolKind::Claude);

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Cancel a pending Claude OAuth login
#[tauri::command]
pub async fn cancel_claude_login() -> Result<(), String> {
    let mut pending = PENDING_CLAUDE_OAUTH.lock().unwrap();
    if let Some(pending_oauth) = pending.take() {
        pending_oauth.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}
