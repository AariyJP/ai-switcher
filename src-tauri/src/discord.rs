use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use rand::Rng;

const DISCORD_CLIENT_ID: &str = "1509183960872128672";
const PROJECT_URL: &str = "https://github.com/AariyJP/ai-switcher";
const RECONNECT_INTERVAL: Duration = Duration::from_secs(60);

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

        if client.connect().is_ok() && set_activity(&mut client, start_time).is_ok() {
            'connected: loop {
                wait_while(presence_enabled, RECONNECT_INTERVAL);

                if !presence_enabled() {
                    let _ = client.close();
                    break 'connected;
                }

                if set_activity(&mut client, start_time).is_err() {
                    break;
                }
            }
        }

        wait_while(presence_enabled, RECONNECT_INTERVAL);
    });
}

fn set_activity(
    client: &mut DiscordIpcClient,
    start_time: i64,
) -> Result<(), discord_rich_presence::error::Error> {
    let idx = rand::rng().random_range(0..PONDERING_WORDS.len());
    let details = format!("＊ {}...", PONDERING_WORDS[idx]);

    client.set_activity(
        Activity::new()
            .details(&details)
            .details_url(PROJECT_URL)
            .assets(Assets::new().large_url(PROJECT_URL))
            .activity_type(ActivityType::Playing)
            .timestamps(Timestamps::new().start(start_time)),
    )
}
