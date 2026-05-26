//! Process detection commands

use std::process::Command;

use crate::types::ToolKind;

#[cfg(windows)]
use anyhow::Context;

#[cfg(windows)]
use std::collections::HashSet;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsToolProcess {
    name: String,
    process_id: u32,
    parent_process_id: u32,
    #[serde(default)]
    command_line: String,
    #[serde(default)]
    main_window_title: String,
}

#[derive(Debug, Clone, Copy)]
struct ToolPatterns {
    /// CLI command token; matched against first whitespace-separated token or its '/'-suffix
    #[cfg_attr(not(unix), allow(dead_code))]
    cli_token: &'static str,
    /// Substring identifying the desktop app binary (case sensitive within the path)
    #[cfg_attr(not(unix), allow(dead_code))]
    desktop_macos_marker: &'static str,
    /// Substrings whose presence excludes a desktop-marker match (helper apps, menubar)
    #[cfg_attr(not(unix), allow(dead_code))]
    desktop_macos_excludes: &'static [&'static str],
    /// Substrings (lowercased) identifying background helpers that should be counted as bg
    #[cfg_attr(not(unix), allow(dead_code))]
    bg_helper_markers: &'static [&'static str],
    /// Substrings (lowercased) identifying IDE plugin processes to ignore
    ide_plugin_markers: &'static [&'static str],
    /// Substring (lowercased) of this switcher binary; matches are skipped entirely
    self_marker: &'static str,
    /// Windows process name to match (case-insensitive)
    #[cfg_attr(not(windows), allow(dead_code))]
    windows_exe_lc: &'static str,
    /// Windows command-line marker for app-server descendants (lowercased), if any
    #[cfg_attr(not(windows), allow(dead_code))]
    windows_app_server_marker: Option<&'static str>,
    /// Windows command-line marker for bundled CLI under desktop resources, if any
    #[cfg_attr(not(windows), allow(dead_code))]
    windows_bundled_cli_marker: Option<&'static str>,
}

impl ToolKind {
    fn patterns(self) -> ToolPatterns {
        match self {
            ToolKind::Codex => ToolPatterns {
                cli_token: "codex",
                desktop_macos_marker: ".app/Contents/MacOS/Codex",
                desktop_macos_excludes: &["Codex Helper", "CodexBar"],
                bg_helper_markers: &["codex app-server"],
                ide_plugin_markers: &[".antigravity", "openai.chatgpt", ".vscode"],
                self_marker: "codex-switcher",
                windows_exe_lc: "codex.exe",
                windows_app_server_marker: Some("app-server"),
                windows_bundled_cli_marker: Some("resources\\codex.exe"),
            },
            ToolKind::Claude => ToolPatterns {
                cli_token: "claude",
                desktop_macos_marker: ".app/Contents/MacOS/Claude",
                desktop_macos_excludes: &["Claude Helper"],
                bg_helper_markers: &[
                    "claude.app/contents/helpers/disclaimer",
                    "/library/application support/claude/claude-code/",
                ],
                ide_plugin_markers: &[".antigravity", ".vscode", "anthropic.claude"],
                self_marker: "codex-switcher",
                windows_exe_lc: "claude.exe",
                windows_app_server_marker: None,
                windows_bundled_cli_marker: Some("appdata\\local\\anthropicclaude"),
            },
        }
    }
}

/// Information about running tool processes
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessInfo {
    /// Number of active app/CLI instances
    pub count: usize,
    /// Number of ignored background/stale processes
    pub background_count: usize,
    /// Whether switching is allowed (no active instances)
    pub can_switch: bool,
    /// Process IDs of active instances
    pub pids: Vec<u32>,
}

/// Check for running processes of the given tool
#[tauri::command]
pub async fn check_processes(tool: ToolKind) -> Result<ProcessInfo, String> {
    let (pids, bg_count) = find_processes(tool).map_err(|e| e.to_string())?;
    let count = pids.len();

    Ok(ProcessInfo {
        count,
        background_count: bg_count,
        can_switch: count == 0,
        pids,
    })
}

/// Find all running processes for the given tool. Returns (active_pids, background_count)
fn find_processes(tool: ToolKind) -> anyhow::Result<(Vec<u32>, usize)> {
    let patterns = tool.patterns();

    #[cfg(unix)]
    {
        let mut pids = Vec::new();
        let mut bg_count = 0;

        // Include TTY so we can distinguish interactive CLI sessions from
        // background helper processes such as lingering app-server instances.
        let output = Command::new("ps")
            .args(["-axo", "pid=,tty=,command="])
            .output();

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                let mut parts = line.split_whitespace();
                let Some(pid_str) = parts.next() else {
                    continue;
                };
                let Some(tty) = parts.next() else {
                    continue;
                };
                let command = parts.collect::<Vec<_>>().join(" ");
                if command.is_empty() {
                    continue;
                }

                let lowercase_command = command.to_ascii_lowercase();

                if lowercase_command.contains(patterns.self_marker) {
                    continue;
                }

                // macOS app bundle paths can contain spaces (`Codex Helper.app`), so
                // splitting on whitespace can turn helper processes into false
                // positives for the main app. Detect by full command shape instead
                // of relying on the first token alone.
                let first_token = command.split_whitespace().next().unwrap_or("");
                let is_cli = first_token == patterns.cli_token
                    || first_token.ends_with(&format!("/{}", patterns.cli_token));
                let is_desktop = command.contains(patterns.desktop_macos_marker)
                    && !patterns
                        .desktop_macos_excludes
                        .iter()
                        .any(|exclude| command.contains(exclude));

                if !is_cli && !is_desktop {
                    continue;
                }

                let Ok(pid) = pid_str.parse::<u32>() else {
                    continue;
                };

                if pid == std::process::id() || pids.contains(&pid) {
                    continue;
                }

                let is_ide_plugin = patterns
                    .ide_plugin_markers
                    .iter()
                    .any(|marker| lowercase_command.contains(marker));
                let is_bg_helper = patterns
                    .bg_helper_markers
                    .iter()
                    .any(|marker| lowercase_command.contains(marker));
                let has_tty = tty != "??" && tty != "?";

                if is_ide_plugin || is_bg_helper {
                    bg_count += 1;
                    continue;
                }

                if is_desktop || has_tty {
                    pids.push(pid);
                } else {
                    // Headless or orphaned CLI processes should not block switching.
                    bg_count += 1;
                }
            }
        }

        pids.sort_unstable();
        pids.dedup();

        return Ok((pids, bg_count));
    }

    #[cfg(windows)]
    {
        return find_windows_processes(patterns);
    }

    #[allow(unreachable_code)]
    Ok((Vec::new(), 0))
}

#[cfg(windows)]
fn find_windows_processes(patterns: ToolPatterns) -> anyhow::Result<(Vec<u32>, usize)> {
    // tasklist counts every Electron helper (`--type=gpu-process`, crashpad, renderer, etc.),
    // which inflates the badge and incorrectly blocks switching. Use PowerShell so we can inspect
    // the command line and only count live top-level app instances.
    let exe_name = patterns.windows_exe_lc;
    let process_name = exe_name.trim_end_matches(".exe");
    let powershell_script = format!(
        r#"
$windowTitles = @{{}}
Get-Process -Name {process_name} -ErrorAction SilentlyContinue | ForEach-Object {{
  $windowTitles[[uint32]$_.Id] = $_.MainWindowTitle
}}

Get-CimInstance Win32_Process |
  Where-Object {{ $_.Name -ieq '{exe_name}' }} |
  ForEach-Object {{
    [PSCustomObject]@{{
      Name = $_.Name
      ProcessId = [uint32]$_.ProcessId
      ParentProcessId = [uint32]$_.ParentProcessId
      CommandLine = if ($_.CommandLine) {{ $_.CommandLine }} else {{ '' }}
      MainWindowTitle = if ($windowTitles.ContainsKey([uint32]$_.ProcessId)) {{
        [string]$windowTitles[[uint32]$_.ProcessId]
      }} else {{
        ''
      }}
    }}
  }} |
  ConvertTo-Json -Compress
"#
    );

    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            powershell_script.as_str(),
        ])
        .output()
        .context("failed to query Windows process list")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("PowerShell process query failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let processes = parse_windows_processes(&stdout)?;

    let mut active_pids = Vec::new();
    let mut ignored_count = 0;

    for process in processes
        .iter()
        .filter(|process| is_windows_root_process(process, patterns))
    {
        let command = process.command_line.to_ascii_lowercase();
        if patterns
            .ide_plugin_markers
            .iter()
            .any(|marker| command.contains(marker))
        {
            ignored_count += 1;
            continue;
        }

        let has_window = !process.main_window_title.trim().is_empty();
        let has_renderer =
            windows_has_descendant_matching(process.process_id, &processes, |child| {
                child
                    .command_line
                    .to_ascii_lowercase()
                    .contains("--type=renderer")
            });
        let has_app_server = patterns
            .windows_app_server_marker
            .map(|marker| {
                windows_has_descendant_matching(process.process_id, &processes, |child| {
                    let command = child.command_line.to_ascii_lowercase();
                    patterns
                        .windows_bundled_cli_marker
                        .map(|cli| command.contains(cli) && command.contains(marker))
                        .unwrap_or_else(|| command.contains(marker))
                })
            })
            .unwrap_or(false);

        if has_window || has_renderer || has_app_server {
            active_pids.push(process.process_id);
        } else {
            // Ignore stale helper trees left behind after the window has already closed.
            ignored_count += 1;
        }
    }

    active_pids.sort_unstable();
    active_pids.dedup();

    Ok((active_pids, ignored_count))
}

#[cfg(windows)]
fn parse_windows_processes(stdout: &str) -> anyhow::Result<Vec<WindowsToolProcess>> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value =
        serde_json::from_str(trimmed).context("failed to parse Windows process JSON")?;

    match value {
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value)
                    .context("failed to deserialize Windows tool process entry")
            })
            .collect(),
        value => Ok(vec![serde_json::from_value(value)
            .context("failed to deserialize Windows tool process entry")?]),
    }
}

#[cfg(windows)]
fn is_windows_root_process(process: &WindowsToolProcess, patterns: ToolPatterns) -> bool {
    let name = process.name.to_ascii_lowercase();
    let command = process.command_line.to_ascii_lowercase();
    if name != patterns.windows_exe_lc {
        return false;
    }
    if command.contains(patterns.self_marker) {
        return false;
    }
    if command.contains("--type=") {
        return false;
    }
    if let Some(bundled) = patterns.windows_bundled_cli_marker {
        if command.contains(bundled) {
            return false;
        }
    }
    true
}

#[cfg(windows)]
fn windows_has_descendant_matching<F>(
    root_pid: u32,
    processes: &[WindowsToolProcess],
    mut predicate: F,
) -> bool
where
    F: FnMut(&WindowsToolProcess) -> bool,
{
    let mut queue = vec![root_pid];
    let mut visited = HashSet::new();

    while let Some(parent_pid) = queue.pop() {
        for process in processes
            .iter()
            .filter(|process| process.parent_process_id == parent_pid)
        {
            if !visited.insert(process.process_id) {
                continue;
            }

            if predicate(process) {
                return true;
            }

            queue.push(process.process_id);
        }
    }

    false
}
