use anyhow::{Context, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use crate::types::{AuthData, StoredAccount};

const CURSOR_ACCESS_TOKEN_KEY: &str = "cursorAuth/accessToken";
const CURSOR_REFRESH_TOKEN_KEY: &str = "cursorAuth/refreshToken";
const CURSOR_EMAIL_KEY: &str = "cursorAuth/cachedEmail";
const CURSOR_PLAN_KEY: &str = "cursorAuth/stripeMembershipType";

pub fn import_current_cursor_account(account_name: String) -> Result<StoredAccount> {
    let conn = open_cursor_state_db()?;
    let access_token = read_state_value(&conn, CURSOR_ACCESS_TOKEN_KEY)?
        .filter(|value| !value.trim().is_empty())
        .context("Cursor access token was not found. Sign in to Cursor first.")?;
    let refresh_token = read_state_value(&conn, CURSOR_REFRESH_TOKEN_KEY)?
        .filter(|value| !value.trim().is_empty())
        .context("Cursor refresh token was not found. Sign in to Cursor first.")?;
    let email = read_state_value(&conn, CURSOR_EMAIL_KEY)?;

    Ok(StoredAccount::new_cursor(
        account_name,
        email,
        access_token,
        refresh_token,
    ))
}

pub fn switch_to_cursor_account(account: &StoredAccount) -> Result<()> {
    let AuthData::Cursor {
        access_token,
        refresh_token,
    } = &account.auth_data
    else {
        anyhow::bail!("Account is not a Cursor account");
    };

    let conn = open_cursor_state_db()?;
    write_state_value(&conn, CURSOR_ACCESS_TOKEN_KEY, access_token)?;
    write_state_value(&conn, CURSOR_REFRESH_TOKEN_KEY, refresh_token)?;
    write_or_clear_state_value(&conn, CURSOR_EMAIL_KEY, account.email.as_deref())?;
    delete_state_value(&conn, CURSOR_PLAN_KEY)?;
    Ok(())
}

pub fn logout_cursor() -> Result<()> {
    let conn = open_cursor_state_db()?;
    delete_state_value(&conn, CURSOR_ACCESS_TOKEN_KEY)?;
    delete_state_value(&conn, CURSOR_REFRESH_TOKEN_KEY)?;
    delete_state_value(&conn, CURSOR_EMAIL_KEY)?;
    delete_state_value(&conn, CURSOR_PLAN_KEY)?;
    Ok(())
}

fn read_state_value(conn: &Connection, key: &str) -> Result<Option<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            params![key],
            |row| row.get::<_, Value>(0),
        )
        .optional()
        .context("Failed to read Cursor state value")?;

    Ok(value.and_then(|value| match value {
        Value::Text(text) => Some(text),
        Value::Blob(bytes) => String::from_utf8(bytes).ok(),
        _ => None,
    }))
}

fn write_state_value(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .with_context(|| format!("Failed to update Cursor state key `{key}`"))?;
    Ok(())
}

fn write_or_clear_state_value(conn: &Connection, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => write_state_value(conn, key, value),
        None => delete_state_value(conn, key),
    }
}

fn delete_state_value(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM ItemTable WHERE key = ?1", params![key])
        .with_context(|| format!("Failed to clear Cursor state key `{key}`"))?;
    Ok(())
}

fn open_cursor_state_db() -> Result<Connection> {
    let path = cursor_state_db_path()?;
    if !path.exists() {
        anyhow::bail!(
            "Cursor state DB not found: {}. Launch Cursor and sign in at least once.",
            path.display()
        );
    }
    let conn = Connection::open(path).context("Failed to open Cursor state DB")?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .context("Failed to set Cursor state DB busy timeout")?;
    Ok(conn)
}

fn cursor_state_db_path() -> Result<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().context("Could not find home directory")?;
        Ok(home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb"))
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA").context("APPDATA env var not set")?;
        Ok(std::path::PathBuf::from(appdata).join("Cursor/User/globalStorage/state.vscdb"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = dirs::home_dir().context("Could not find home directory")?;
        Ok(home.join(".config/Cursor/User/globalStorage/state.vscdb"))
    }
}
