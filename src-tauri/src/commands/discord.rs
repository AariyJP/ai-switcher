use crate::auth::storage;

#[tauri::command]
pub async fn get_discord_presence_enabled() -> Result<bool, String> {
    storage::get_discord_presence_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_discord_presence_enabled(enabled: bool) -> Result<(), String> {
    storage::set_discord_presence_enabled(enabled).map_err(|e| e.to_string())?;
    crate::discord::set_presence_enabled(enabled);
    Ok(())
}
