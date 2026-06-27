//! Window decoration commands

#[tauri::command]
pub fn set_window_theme(window: tauri::Window, dark: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::mem::size_of;
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
        };

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let value: u32 = if dark { 1 } else { 0 };
        let caption_color: u32 = if dark { 0x000a0a0a } else { 0x00ffffff };
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                &value as *const u32 as *const _,
                size_of::<u32>() as u32,
            );
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_CAPTION_COLOR as u32,
                &caption_color as *const u32 as *const _,
                size_of::<u32>() as u32,
            );
        }
    }

    #[cfg(not(windows))]
    let _ = (window, dark);

    Ok(())
}
