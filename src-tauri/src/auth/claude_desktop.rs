use anyhow::{Context, Result};
use serde_json::Value;

use crate::types::{AuthData, ClaudeDesktopCookie, ClaudeDesktopSession, StoredAccount};

const OAUTH_TOKEN_CACHE_KEY: &str = "oauth:tokenCache";
const OAUTH_TOKEN_CACHE_V2_KEY: &str = "oauth:tokenCacheV2";
const V10_PREFIX: &[u8; 3] = b"v10";
#[cfg(windows)]
const DPAPI_PREFIX: &[u8; 5] = b"DPAPI";
#[cfg(windows)]
const AES_GCM_NONCE_LEN: usize = 12;
#[cfg(windows)]
const AES_GCM_TAG_LEN: usize = 16;
#[cfg(windows)]
const AES_256_KEY_LEN: usize = 32;

pub fn import_current_claude_desktop_account(account_name: String) -> Result<StoredAccount> {
    let config = read_config_json()?;
    let plaintext = decrypt_cache_field(&config, OAUTH_TOKEN_CACHE_KEY)?.with_context(|| {
        format!(
            "oauth:tokenCache not found in {}. Sign in to Claude Desktop first.",
            config_path()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        )
    })?;
    let (email, plan_type) = parse_metadata(&plaintext);
    let session = read_current_claude_desktop_session()?;
    let oauth_token_cache_v2 = decrypt_cache_field(&config, OAUTH_TOKEN_CACHE_V2_KEY)
        .ok()
        .flatten()
        .filter(|p| !is_empty_token_cache(p));
    Ok(StoredAccount::new_claude_desktop(
        account_name,
        email,
        plan_type,
        plaintext,
        session,
        oauth_token_cache_v2,
    ))
}

pub fn read_current_claude_desktop_session() -> Result<ClaudeDesktopSession> {
    let cookies = read_claude_desktop_cookies()?;
    let session_key = cookies
        .iter()
        .find(|cookie| cookie.name == "sessionKey")
        .map(|cookie| cookie.value.clone())
        .context("Claude Desktop sessionKey cookie not found")?;
    let org_uuid = cookies
        .iter()
        .find(|cookie| cookie.name == "lastActiveOrg")
        .map(|cookie| cookie.value.clone());
    let device_id = cookies
        .iter()
        .find(|cookie| cookie.name == "anthropic-device-id")
        .map(|cookie| cookie.value.clone());

    Ok(ClaudeDesktopSession {
        session_key,
        org_uuid,
        device_id,
        cookies,
    })
}

pub fn switch_to_claude_desktop_account(account: &StoredAccount) -> Result<()> {
    let AuthData::ClaudeDesktop {
        oauth_token_cache,
        oauth_token_cache_v2,
        session,
    } = &account.auth_data
    else {
        anyhow::bail!("Account is not a Claude Desktop account");
    };
    kill_claude_desktop_processes();
    write_oauth_token_caches(oauth_token_cache, oauth_token_cache_v2.as_deref())?;
    write_claude_desktop_session(session)?;
    Ok(())
}

#[cfg(windows)]
fn kill_claude_desktop_processes() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = std::process::Command::new("taskkill")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["/F", "/IM", "Claude.exe", "/T"])
        .output();
}

#[cfg(target_os = "macos")]
fn kill_claude_desktop_processes() {
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-x", "Claude"])
        .output();
}

#[cfg(not(any(windows, target_os = "macos")))]
fn kill_claude_desktop_processes() {}

pub fn read_current_claude_desktop_token_cache_snapshot() -> Result<String> {
    read_current_oauth_token_cache()
}

pub fn logout_claude_desktop() -> Result<()> {
    kill_claude_desktop_processes();
    clear_oauth_token_cache()?;
    clear_claude_desktop_cookies()?;
    Ok(())
}

fn clear_oauth_token_cache() -> Result<()> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Claude Desktop config: {}", path.display()))?;
    let mut value: Value = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse Claude Desktop config: {}", path.display()))?;

    let Some(map) = value.as_object_mut() else {
        anyhow::bail!("Claude Desktop config root is not a JSON object");
    };

    let removed_v1 = map.remove(OAUTH_TOKEN_CACHE_KEY).is_some();
    let removed_v2 = map.remove(OAUTH_TOKEN_CACHE_V2_KEY).is_some();
    if !removed_v1 && !removed_v2 {
        return Ok(());
    }

    let serialized = serde_json::to_string_pretty(&value)
        .context("Failed to serialize Claude Desktop config")?;
    std::fs::write(&path, serialized)
        .with_context(|| format!("Failed to write Claude Desktop config: {}", path.display()))?;
    Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn clear_claude_desktop_cookies() -> Result<()> {
    let path = cookies_path()?;
    if !path.exists() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open(&path)
        .with_context(|| format!("Failed to open Claude Desktop cookies: {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    conn.execute("DELETE FROM cookies WHERE host_key LIKE '%claude.ai'", [])
        .context("Failed to clear Claude Desktop cookies")?;
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn clear_claude_desktop_cookies() -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn claude_desktop_config_dir() -> Result<std::path::PathBuf> {
    let appdata = std::env::var_os("APPDATA").context("APPDATA env var not set")?;
    Ok(std::path::PathBuf::from(appdata).join("Claude"))
}

#[cfg(target_os = "macos")]
fn claude_desktop_config_dir() -> Result<std::path::PathBuf> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    Ok(home.join("Library/Application Support/Claude"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn claude_desktop_config_dir() -> Result<std::path::PathBuf> {
    anyhow::bail!("Claude Desktop switching is not supported on this platform")
}

fn config_path() -> Result<std::path::PathBuf> {
    Ok(claude_desktop_config_dir()?.join("config.json"))
}

fn is_empty_token_cache(plaintext: &str) -> bool {
    let trimmed = plaintext.trim();
    trimmed.is_empty() || trimmed == "{}"
}

fn read_config_json() -> Result<Value> {
    let path = config_path()?;
    if !path.exists() {
        anyhow::bail!(
            "Claude Desktop config not found: {}. Launch Claude Desktop and sign in at least once.",
            path.display()
        );
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read Claude Desktop config: {}", path.display()))?;
    serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse Claude Desktop config: {}", path.display()))
}

fn write_config_json(value: &Value) -> Result<()> {
    let path = config_path()?;
    let serialized =
        serde_json::to_string_pretty(value).context("Failed to serialize Claude Desktop config")?;
    std::fs::write(&path, serialized)
        .with_context(|| format!("Failed to write Claude Desktop config: {}", path.display()))
}

fn decrypt_cache_field(config: &Value, key: &str) -> Result<Option<String>> {
    match config.get(key).and_then(|v| v.as_str()) {
        Some(encrypted_b64) => Ok(Some(decrypt_token_cache(encrypted_b64)?)),
        None => Ok(None),
    }
}

fn read_current_oauth_token_cache() -> Result<String> {
    let config = read_config_json()?;
    decrypt_cache_field(&config, OAUTH_TOKEN_CACHE_KEY)?.with_context(|| {
        format!(
            "oauth:tokenCache not found in {}. Sign in to Claude Desktop first.",
            config_path()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        )
    })
}

fn write_oauth_token_caches(v1_plaintext: &str, v2_plaintext: Option<&str>) -> Result<()> {
    let mut value = read_config_json()?;
    let Some(map) = value.as_object_mut() else {
        anyhow::bail!("Claude Desktop config root is not a JSON object");
    };

    map.insert(
        OAUTH_TOKEN_CACHE_KEY.to_string(),
        Value::String(encrypt_token_cache(v1_plaintext)?),
    );

    match v2_plaintext.filter(|v2| !is_empty_token_cache(v2)) {
        Some(v2) => {
            map.insert(
                OAUTH_TOKEN_CACHE_V2_KEY.to_string(),
                Value::String(encrypt_token_cache(v2)?),
            );
        }
        None => {
            map.remove(OAUTH_TOKEN_CACHE_V2_KEY);
        }
    }

    write_config_json(&value)
}

fn write_claude_desktop_session(session: &ClaudeDesktopSession) -> Result<()> {
    let mut cookies = session.cookies.clone();
    upsert_memory_cookie(&mut cookies, "sessionKey", &session.session_key);
    if let Some(org_uuid) = session.org_uuid.as_deref().filter(|s| !s.is_empty()) {
        upsert_memory_cookie(&mut cookies, "lastActiveOrg", org_uuid);
    }
    if let Some(device_id) = session.device_id.as_deref().filter(|s| !s.is_empty()) {
        upsert_memory_cookie(&mut cookies, "anthropic-device-id", device_id);
    }
    write_claude_desktop_cookies(&cookies)
}

fn upsert_memory_cookie(cookies: &mut Vec<ClaudeDesktopCookie>, name: &str, value: &str) {
    if let Some(cookie) = cookies.iter_mut().find(|cookie| cookie.name == name) {
        cookie.value = value.to_string();
        return;
    }
    cookies.push(default_claude_desktop_cookie(name, value));
}

fn default_claude_desktop_cookie(name: &str, value: &str) -> ClaudeDesktopCookie {
    let now = chrome_time_now();
    ClaudeDesktopCookie {
        name: name.to_string(),
        value: value.to_string(),
        host_key: Some(default_cookie_host_key(name).to_string()),
        top_frame_site_key: Some(String::new()),
        path: Some("/".to_string()),
        expires_utc: Some(now + 400 * 24 * 60 * 60 * 1_000_000),
        is_secure: Some(1),
        is_httponly: Some(if name == "sessionKey" { 1 } else { 0 }),
        has_expires: Some(1),
        is_persistent: Some(1),
        priority: Some(1),
        samesite: Some(-1),
        source_scheme: Some(2),
        source_port: Some(443),
        source_type: Some(0),
        has_cross_site_ancestor: Some(0),
        creation_utc: Some(now),
        last_access_utc: Some(now),
        last_update_utc: Some(now),
    }
}

fn default_cookie_host_key(name: &str) -> &'static str {
    if name == "anthropic-device-id" {
        "claude.ai"
    } else {
        ".claude.ai"
    }
}

fn chrome_time_now() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    (now.as_secs() as i64 + 11_644_473_600) * 1_000_000 + i64::from(now.subsec_micros())
}

#[cfg(any(windows, target_os = "macos"))]
fn write_claude_desktop_cookies(cookies: &[ClaudeDesktopCookie]) -> Result<()> {
    let path = cookies_path()?;
    if !path.exists() {
        anyhow::bail!(
            "Claude Desktop cookies database not found: {}. Launch Claude Desktop at least once first.",
            path.display()
        );
    }
    let mut conn = rusqlite::Connection::open(&path)
        .with_context(|| format!("Failed to open Claude Desktop cookies: {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM cookies WHERE host_key LIKE '%claude.ai'", [])
        .context("Failed to clear Claude Desktop cookies")?;
    for cookie in cookies {
        if cookie.name.is_empty() || cookie.value.is_empty() {
            continue;
        }
        let host_key = cookie
            .host_key
            .as_deref()
            .filter(|value| value.ends_with("claude.ai"))
            .unwrap_or_else(|| default_cookie_host_key(&cookie.name));
        let encrypted_value = encrypt_cookie_value(host_key, &cookie.value)?;
        let now = chrome_time_now();
        tx.execute(
            "INSERT OR REPLACE INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            rusqlite::params![
                cookie.creation_utc.unwrap_or(now),
                host_key,
                cookie.top_frame_site_key.as_deref().unwrap_or(""),
                cookie.name.as_str(),
                "",
                encrypted_value,
                cookie.path.as_deref().unwrap_or("/"),
                cookie.expires_utc.unwrap_or(now + 400 * 24 * 60 * 60 * 1_000_000),
                cookie.is_secure.unwrap_or(1),
                cookie.is_httponly.unwrap_or(if cookie.name == "sessionKey" { 1 } else { 0 }),
                cookie.last_access_utc.unwrap_or(now),
                cookie.has_expires.unwrap_or(1),
                cookie.is_persistent.unwrap_or(1),
                cookie.priority.unwrap_or(1),
                cookie.samesite.unwrap_or(-1),
                cookie.source_scheme.unwrap_or(2),
                cookie.source_port.unwrap_or(443),
                cookie.last_update_utc.unwrap_or(now),
                cookie.source_type.unwrap_or(0),
                cookie.has_cross_site_ancestor.unwrap_or(0),
            ],
        )
        .with_context(|| format!("Failed to write Claude Desktop cookie: {}", cookie.name))?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn write_claude_desktop_cookies(_cookies: &[ClaudeDesktopCookie]) -> Result<()> {
    anyhow::bail!("Claude Desktop cookie switching is not supported on this platform")
}

fn parse_metadata(plaintext: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(plaintext) else {
        return (None, None);
    };

    let email = dig_str(&value, &[&["email"], &["emailAddress"]])
        .or_else(|| {
            dig_str(
                &value,
                &[&["account", "email"], &["account", "emailAddress"]],
            )
        })
        .or_else(|| dig_str(&value, &[&["user", "email"]]))
        .or_else(|| dig_str(&value, &[&["claudeAiOauth", "emailAddress"]]));

    let plan = dig_str(
        &value,
        &[
            &["subscriptionType"],
            &["planType"],
            &["billingType"],
            &["plan"],
        ],
    )
    .or_else(|| {
        dig_str(
            &value,
            &[
                &["account", "subscriptionType"],
                &["claudeAiOauth", "subscriptionType"],
                &["claudeAiOauth", "rateLimitTier"],
                &["organization", "rateLimitTier"],
            ],
        )
    });

    (email, plan)
}

fn dig_str(value: &Value, paths: &[&[&str]]) -> Option<String> {
    for path in paths {
        let mut cur = value;
        let mut ok = true;
        for key in path.iter() {
            match cur.get(*key) {
                Some(next) => cur = next,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            if let Some(s) = cur.as_str() {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn local_state_path() -> Result<std::path::PathBuf> {
    Ok(claude_desktop_config_dir()?.join("Local State"))
}

#[cfg(windows)]
fn cookies_path() -> Result<std::path::PathBuf> {
    Ok(claude_desktop_config_dir()?.join("Network").join("Cookies"))
}

#[cfg(target_os = "macos")]
fn cookies_path() -> Result<std::path::PathBuf> {
    Ok(claude_desktop_config_dir()?.join("Cookies"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn cookies_path() -> Result<std::path::PathBuf> {
    anyhow::bail!("Claude Desktop cookies are not supported on this platform")
}

#[cfg(any(windows, target_os = "macos"))]
fn read_claude_desktop_cookies() -> Result<Vec<ClaudeDesktopCookie>> {
    let path = cookies_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let tmp = std::env::temp_dir().join(format!(
        "ai-switcher-claude-cookies-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    std::fs::copy(&path, &tmp).with_context(|| {
        format!(
            "Failed to snapshot Claude Desktop cookies. Close Claude Desktop before importing this account: {}",
            path.display()
        )
    })?;

    let result = (|| -> Result<Vec<ClaudeDesktopCookie>> {
        let conn =
            rusqlite::Connection::open_with_flags(&tmp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .context("Failed to open Claude Desktop cookies snapshot")?;
        let mut stmt = conn
            .prepare(
                "SELECT creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor FROM cookies WHERE host_key LIKE '%claude.ai'",
            )
            .context("Failed to prepare cookies query")?;
        let rows = stmt
            .query_map([], |row| {
                let creation_utc: i64 = row.get(0)?;
                let host_key: String = row.get(1)?;
                let top_frame_site_key: String = row.get(2)?;
                let name: String = row.get(3)?;
                let value: String = row.get(4)?;
                let encrypted: Vec<u8> = row.get(5)?;
                let path: String = row.get(6)?;
                let expires_utc: i64 = row.get(7)?;
                let is_secure: i64 = row.get(8)?;
                let is_httponly: i64 = row.get(9)?;
                let last_access_utc: i64 = row.get(10)?;
                let has_expires: i64 = row.get(11)?;
                let is_persistent: i64 = row.get(12)?;
                let priority: i64 = row.get(13)?;
                let samesite: i64 = row.get(14)?;
                let source_scheme: i64 = row.get(15)?;
                let source_port: i64 = row.get(16)?;
                let last_update_utc: i64 = row.get(17)?;
                let source_type: i64 = row.get(18)?;
                let has_cross_site_ancestor: i64 = row.get(19)?;
                Ok(ClaudeDesktopCookie {
                    name,
                    value,
                    host_key: Some(host_key),
                    top_frame_site_key: Some(top_frame_site_key),
                    path: Some(path),
                    expires_utc: Some(expires_utc),
                    is_secure: Some(is_secure),
                    is_httponly: Some(is_httponly),
                    has_expires: Some(has_expires),
                    is_persistent: Some(is_persistent),
                    priority: Some(priority),
                    samesite: Some(samesite),
                    source_scheme: Some(source_scheme),
                    source_port: Some(source_port),
                    source_type: Some(source_type),
                    has_cross_site_ancestor: Some(has_cross_site_ancestor),
                    creation_utc: Some(creation_utc),
                    last_access_utc: Some(last_access_utc),
                    last_update_utc: Some(last_update_utc),
                })
                .map(|mut cookie| {
                    if cookie.value.is_empty() && !encrypted.is_empty() {
                        match decrypt_cookie_value(&encrypted) {
                            Ok(value) => cookie.value = value,
                            Err(err) => {
                                println!(
                                    "[ClaudeDesktop] Failed to decrypt cookie {}: {err}",
                                    cookie.name
                                );
                            }
                        }
                    }
                    cookie
                })
            })
            .context("Failed to query cookies table")?;

        let mut out = Vec::new();
        for row in rows {
            let cookie = row.context("Failed to read cookies row")?;
            if cookie.value.is_empty() {
                continue;
            }
            out.push(cookie);
        }
        Ok(out)
    })();

    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(not(any(windows, target_os = "macos")))]
fn read_claude_desktop_cookies() -> Result<Vec<ClaudeDesktopCookie>> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn decrypt_cookie_value(raw: &[u8]) -> Result<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    if raw.len() < V10_PREFIX.len() {
        anyhow::bail!("cookie value too short");
    }
    if &raw[0..V10_PREFIX.len()] != V10_PREFIX {
        anyhow::bail!("unsupported cookie value prefix");
    }
    if raw.len() < V10_PREFIX.len() + AES_GCM_NONCE_LEN + AES_GCM_TAG_LEN {
        anyhow::bail!("cookie value too short for AES-GCM payload");
    }
    let nonce = &raw[V10_PREFIX.len()..V10_PREFIX.len() + AES_GCM_NONCE_LEN];
    let ciphertext = &raw[V10_PREFIX.len() + AES_GCM_NONCE_LEN..];

    let key_bytes = master_key_windows()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|e| anyhow::anyhow!("AES-GCM decrypt failed: {e}"))?;

    // Chromium 124+ prepends 32 bytes of SHA-256(host_key) before the cookie
    // value for integrity. Detect by checking whether the first 32 bytes look
    // like binary noise rather than printable text.
    let bytes = if plaintext.len() > 32
        && plaintext
            .iter()
            .take(32)
            .any(|b| !b.is_ascii() || *b < 0x20)
    {
        plaintext[32..].to_vec()
    } else {
        plaintext
    };
    String::from_utf8(bytes).context("Decrypted cookie value is not UTF-8")
}

#[cfg(windows)]
fn encrypt_cookie_value(host_key: &str, value: &str) -> Result<Vec<u8>> {
    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
    use aes_gcm::{Aes256Gcm, Key};
    use sha2::{Digest, Sha256};

    let key_bytes = master_key_windows()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut plaintext = Vec::with_capacity(32 + value.len());
    plaintext.extend_from_slice(&Sha256::digest(host_key.as_bytes()));
    plaintext.extend_from_slice(value.as_bytes());
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_slice())
        .map_err(|e| anyhow::anyhow!("AES-GCM encrypt failed: {e}"))?;

    let mut out = Vec::with_capacity(V10_PREFIX.len() + AES_GCM_NONCE_LEN + ciphertext.len());
    out.extend_from_slice(V10_PREFIX);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

#[cfg(target_os = "macos")]
fn decrypt_cookie_value(raw: &[u8]) -> Result<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    if raw.len() < V10_PREFIX.len() {
        anyhow::bail!("cookie value too short");
    }
    if &raw[0..V10_PREFIX.len()] != V10_PREFIX {
        anyhow::bail!("unsupported cookie value prefix");
    }
    let ciphertext = &raw[V10_PREFIX.len()..];

    let key = macos_aes_key()?;
    let iv: [u8; 16] = [0x20; 16];

    let plaintext = Aes128CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|e| anyhow::anyhow!("AES-CBC decrypt failed: {e}"))?;

    let bytes = if plaintext.len() > 32
        && plaintext
            .iter()
            .take(32)
            .any(|b| !b.is_ascii() || *b < 0x20)
    {
        plaintext[32..].to_vec()
    } else {
        plaintext
    };
    String::from_utf8(bytes).context("Decrypted cookie value is not UTF-8")
}

#[cfg(target_os = "macos")]
fn encrypt_cookie_value(host_key: &str, value: &str) -> Result<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use sha2::{Digest, Sha256};
    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    let key = macos_aes_key()?;
    let iv: [u8; 16] = [0x20; 16];

    let mut plaintext = Vec::with_capacity(32 + value.len());
    plaintext.extend_from_slice(&Sha256::digest(host_key.as_bytes()));
    plaintext.extend_from_slice(value.as_bytes());

    let ciphertext =
        Aes128CbcEnc::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(&plaintext);

    let mut out = Vec::with_capacity(V10_PREFIX.len() + ciphertext.len());
    out.extend_from_slice(V10_PREFIX);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

#[cfg(windows)]
fn decrypt_token_cache(encrypted_b64: &str) -> Result<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use base64::Engine;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(encrypted_b64.as_bytes())
        .context("Failed to base64-decode oauth:tokenCache")?;
    let header_len = V10_PREFIX.len() + AES_GCM_NONCE_LEN + AES_GCM_TAG_LEN;
    if raw.len() < header_len || &raw[0..V10_PREFIX.len()] != V10_PREFIX {
        anyhow::bail!("Unsupported or malformed oauth:tokenCache blob");
    }
    let nonce = &raw[V10_PREFIX.len()..V10_PREFIX.len() + AES_GCM_NONCE_LEN];
    let ciphertext = &raw[V10_PREFIX.len() + AES_GCM_NONCE_LEN..];

    let key_bytes = master_key_windows()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|e| anyhow::anyhow!("AES-GCM decrypt failed: {e}"))?;
    String::from_utf8(plaintext).context("Decrypted oauth:tokenCache is not valid UTF-8")
}

#[cfg(windows)]
fn encrypt_token_cache(plaintext: &str) -> Result<String> {
    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
    use aes_gcm::{Aes256Gcm, Key};
    use base64::Engine;

    let key_bytes = master_key_windows()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("AES-GCM encrypt failed: {e}"))?;

    let mut out = Vec::with_capacity(V10_PREFIX.len() + AES_GCM_NONCE_LEN + ciphertext.len());
    out.extend_from_slice(V10_PREFIX);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(&out))
}

#[cfg(windows)]
fn master_key_windows() -> Result<Vec<u8>> {
    use base64::Engine;
    let path = local_state_path()?;
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read {}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse {}", path.display()))?;
    let encrypted_b64 = value
        .get("os_crypt")
        .and_then(|v| v.get("encrypted_key"))
        .and_then(|v| v.as_str())
        .with_context(|| format!("os_crypt.encrypted_key missing in {}", path.display()))?;
    let mut wrapped = base64::engine::general_purpose::STANDARD
        .decode(encrypted_b64.as_bytes())
        .context("Failed to base64-decode encrypted_key")?;
    if wrapped.len() < DPAPI_PREFIX.len() || &wrapped[0..DPAPI_PREFIX.len()] != DPAPI_PREFIX {
        anyhow::bail!("encrypted_key missing DPAPI prefix");
    }
    let dpapi_blob = wrapped.split_off(DPAPI_PREFIX.len());
    let key = unsafe { dpapi_unprotect(&dpapi_blob)? };
    if key.len() != AES_256_KEY_LEN {
        anyhow::bail!("Unexpected AES key length: {}", key.len());
    }
    Ok(key)
}

#[cfg(windows)]
unsafe fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = CryptUnprotectData(
        &mut in_blob,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        0,
        &mut out_blob,
    );

    if ok == 0 {
        anyhow::bail!("CryptUnprotectData failed");
    }

    let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
    let result = slice.to_vec();
    LocalFree(out_blob.pbData as *mut core::ffi::c_void);
    Ok(result)
}

#[cfg(target_os = "macos")]
fn decrypt_token_cache(encrypted_b64: &str) -> Result<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use base64::Engine;
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(encrypted_b64.as_bytes())
        .context("Failed to base64-decode oauth:tokenCache")?;
    if raw.len() < V10_PREFIX.len() || &raw[0..V10_PREFIX.len()] != V10_PREFIX {
        anyhow::bail!("Unsupported or malformed oauth:tokenCache blob");
    }
    let ciphertext = &raw[V10_PREFIX.len()..];

    let key = macos_aes_key()?;
    let iv: [u8; 16] = [0x20; 16];

    let plaintext = Aes128CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|e| anyhow::anyhow!("AES-CBC decrypt failed: {e}"))?;
    String::from_utf8(plaintext).context("Decrypted oauth:tokenCache is not valid UTF-8")
}

#[cfg(target_os = "macos")]
fn encrypt_token_cache(plaintext: &str) -> Result<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use base64::Engine;
    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    let key = macos_aes_key()?;
    let iv: [u8; 16] = [0x20; 16];

    let ciphertext = Aes128CbcEnc::new(&key.into(), &iv.into())
        .encrypt_padded_vec_mut::<Pkcs7>(plaintext.as_bytes());

    let mut out = Vec::with_capacity(V10_PREFIX.len() + ciphertext.len());
    out.extend_from_slice(V10_PREFIX);
    out.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(&out))
}

#[cfg(target_os = "macos")]
fn macos_aes_key() -> Result<[u8; 16]> {
    let password = security_framework::passwords::get_generic_password(
        "Claude Safe Storage",
        "Claude",
    )
    .context("Failed to read 'Claude Safe Storage' password from macOS Keychain. Allow access when prompted, or launch Claude Desktop and sign in at least once.")?;

    let key = pbkdf2::pbkdf2_hmac_array::<sha1::Sha1, 16>(&password, b"saltysalt", 1003);
    Ok(key)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn decrypt_token_cache(_encrypted_b64: &str) -> Result<String> {
    anyhow::bail!("Claude Desktop switching is not supported on this platform")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn encrypt_token_cache(_plaintext: &str) -> Result<String> {
    anyhow::bail!("Claude Desktop switching is not supported on this platform")
}
