use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Party, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use rand::Rng;

use crate::types::ToolKind;

const DISCORD_CLIENT_ID: &str = "1509183960872128672";
const PROJECT_URL: &str = "https://github.com/AariyJP/ai-switcher";
const RECONNECT_INTERVAL: Duration = Duration::from_secs(60);
const APP_CHECK_INTERVAL: Duration = Duration::from_secs(15);
const PARTY_ID: &str = "ai-switcher";

const PONDERING_WORDS: &[&str] = &[
    "Accomplishing",
    "Actioning",
    "Actualizing",
    "Architecting",
    "Baking",
    "Beaming",
    "Beboppin'",
    "Befuddling",
    "Billowing",
    "Blanching",
    "Bloviating",
    "Boogieing",
    "Boondoggling",
    "Booping",
    "Bootstrapping",
    "Brewing",
    "Bunning",
    "Burrowing",
    "Calculating",
    "Canoodling",
    "Caramelizing",
    "Cascading",
    "Catapulting",
    "Cerebrating",
    "Channeling",
    "Channelling",
    "Choreographing",
    "Churning",
    "Clauding",
    "Coalescing",
    "Cogitating",
    "Combobulating",
    "Composing",
    "Computing",
    "Concocting",
    "Considering",
    "Contemplating",
    "Cooking",
    "Crafting",
    "Creating",
    "Crunching",
    "Crystallizing",
    "Cultivating",
    "Deciphering",
    "Deliberating",
    "Determining",
    "Dilly-dallying",
    "Discombobulating",
    "Doing",
    "Doodling",
    "Drizzling",
    "Ebbing",
    "Effecting",
    "Elucidating",
    "Embellishing",
    "Enchanting",
    "Envisioning",
    "Evaporating",
    "Fermenting",
    "Fiddle-faddling",
    "Finagling",
    "Flambéing",
    "Flibbertigibbeting",
    "Flowing",
    "Flummoxing",
    "Fluttering",
    "Forging",
    "Forming",
    "Frolicking",
    "Frosting",
    "Gallivanting",
    "Galloping",
    "Garnishing",
    "Generating",
    "Gesticulating",
    "Germinating",
    "Gitifying",
    "Grooving",
    "Gusting",
    "Harmonizing",
    "Hashing",
    "Hatching",
    "Herding",
    "Honking",
    "Hullaballooing",
    "Hyperspacing",
    "Ideating",
    "Imagining",
    "Improvising",
    "Incubating",
    "Inferring",
    "Infusing",
    "Ionizing",
    "Jitterbugging",
    "Julienning",
    "Kneading",
    "Leavening",
    "Levitating",
    "Lollygagging",
    "Manifesting",
    "Marinating",
    "Meandering",
    "Metamorphosing",
    "Misting",
    "Moonwalking",
    "Moseying",
    "Mulling",
    "Mustering",
    "Musing",
    "Nebulizing",
    "Nesting",
    "Newspapering",
    "Noodling",
    "Nucleating",
    "Orbiting",
    "Orchestrating",
    "Osmosing",
    "Perambulating",
    "Percolating",
    "Perusing",
    "Philosophising",
    "Photosynthesizing",
    "Pollinating",
    "Pondering",
    "Pontificating",
    "Pouncing",
    "Precipitating",
    "Prestidigitating",
    "Processing",
    "Proofing",
    "Propagating",
    "Puttering",
    "Puzzling",
    "Quantumizing",
    "Razzle-dazzling",
    "Razzmatazzing",
    "Recombobulating",
    "Reticulating",
    "Roosting",
    "Ruminating",
    "Sautéing",
    "Scampering",
    "Schlepping",
    "Scurrying",
    "Seasoning",
    "Shenaniganing",
    "Shimmying",
    "Simmering",
    "Skedaddling",
    "Sketching",
    "Slithering",
    "Smooshing",
    "Sock-hopping",
    "Spelunking",
    "Spinning",
    "Sprouting",
    "Stewing",
    "Sublimating",
    "Swirling",
    "Swooping",
    "Symbioting",
    "Synthesizing",
    "Tempering",
    "Thinking",
    "Thundering",
    "Tinkering",
    "Tomfoolering",
    "Topsy-turvying",
    "Transfiguring",
    "Transmuting",
    "Twisting",
    "Undulating",
    "Unfurling",
    "Unravelling",
    "Vibing",
    "Waddling",
    "Wandering",
    "Warping",
    "Whatchamacalliting",
    "Whirlpooling",
    "Whirring",
    "Whisking",
    "Wibbling",
    "Working",
    "Wrangling",
    "Zesting",
    "Zigzagging",
];

const POLL_INTERVAL: Duration = Duration::from_secs(1);

static PRESENCE_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_presence_enabled(enabled: bool) {
    PRESENCE_ENABLED.store(enabled, Ordering::SeqCst);
}

fn presence_enabled() -> bool {
    PRESENCE_ENABLED.load(Ordering::SeqCst)
}

fn wait_while(condition: impl Fn() -> bool, max: Duration) {
    for _ in 0..max.as_secs() {
        if !condition() {
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

pub fn start_discord_presence() {
    let start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    set_presence_enabled(
        crate::auth::storage::get_discord_presence_enabled().unwrap_or(true),
    );

    thread::spawn(move || loop {
        if !presence_enabled() {
            thread::sleep(POLL_INTERVAL);
            continue;
        }

        let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);

        let mut app = select_app(None, &running_apps());
        if client.connect().is_ok() && set_activity(&mut client, start_time, app).is_ok() {
            let mut last_set = Instant::now();
            'connected: loop {
                wait_while(presence_enabled, APP_CHECK_INTERVAL);

                if !presence_enabled() {
                    let _ = client.close();
                    break 'connected;
                }

                let current = select_app(app, &running_apps());
                if current == app && last_set.elapsed() < RECONNECT_INTERVAL {
                    continue;
                }
                app = current;

                if set_activity(&mut client, start_time, app).is_err() {
                    break;
                }
                last_set = Instant::now();
            }
        }

        wait_while(presence_enabled, RECONNECT_INTERVAL);
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunningApp {
    Codex,
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
}

impl RunningApp {
    fn name(self) -> &'static str {
        match self {
            RunningApp::Codex => "Codex",
            RunningApp::ClaudeDesktop => "Claude Desktop",
            RunningApp::ClaudeCode => "Claude Code",
            RunningApp::Cursor => "Cursor",
        }
    }

    fn logo_url(self) -> &'static str {
        match self {
            RunningApp::Codex => "https://avatars.githubusercontent.com/u/14957082?v=4",
            RunningApp::ClaudeDesktop | RunningApp::ClaudeCode => {
                "https://claude.ai/apple-touch-icon.png"
            }
            RunningApp::Cursor => "https://cursor.com/apple-touch-icon.png",
        }
    }
}

fn running_apps() -> Vec<RunningApp> {
    let is_running = |result: anyhow::Result<(Vec<u32>, usize)>| {
        result.is_ok_and(|(pids, _)| !pids.is_empty())
    };

    let mut apps = Vec::new();
    if is_running(crate::commands::process::find_codex_processes()) {
        apps.push(RunningApp::Codex);
    }
    if let Ok(claude) = crate::commands::tool_process::scan_non_codex_processes(ToolKind::Claude) {
        if claude.desktop_running {
            apps.push(RunningApp::ClaudeDesktop);
        }
        if claude.cli_running {
            apps.push(RunningApp::ClaudeCode);
        }
    }
    if is_running(crate::commands::tool_process::find_non_codex_processes(
        ToolKind::Cursor,
    )) {
        apps.push(RunningApp::Cursor);
    }
    apps
}

fn select_app(current: Option<RunningApp>, apps: &[RunningApp]) -> Option<RunningApp> {
    current
        .filter(|app| apps.contains(app))
        .or_else(|| apps.first().copied())
}

fn set_activity(
    client: &mut DiscordIpcClient,
    start_time: i64,
    app: Option<RunningApp>,
) -> Result<(), discord_rich_presence::error::Error> {
    let Some(app) = app else {
        return client.clear_activity();
    };

    let mut activity = Activity::new()
        .details(app.name())
        .details_url(PROJECT_URL)
        .assets(
            Assets::new()
                .large_image(app.logo_url())
                .large_text(app.name())
                .large_url(PROJECT_URL),
        )
        .party(Party::new().id(PARTY_ID))
        .activity_type(ActivityType::Playing)
        .timestamps(Timestamps::new().start(start_time));

    let pondering;
    match app {
        RunningApp::ClaudeDesktop | RunningApp::ClaudeCode => {
            let idx = rand::rng().random_range(0..PONDERING_WORDS.len());
            pondering = format!("＊ {}...", PONDERING_WORDS[idx]);
            activity = activity.state(&pondering);
        }
        RunningApp::Codex => activity = activity.state("＊ Working"),
        RunningApp::Cursor => {}
    }

    client.set_activity(activity)
}
