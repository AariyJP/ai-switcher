use std::{thread, time::Duration};

use discord_rich_presence::{
    activity::{Activity, ActivityType},
    DiscordIpc, DiscordIpcClient,
};

const DISCORD_CLIENT_ID: &str = "1509183960872128672";
const RECONNECT_INTERVAL: Duration = Duration::from_secs(30);

pub fn start_discord_presence() {
    thread::spawn(|| loop {
        let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);

        if client.connect().is_ok() && set_activity(&mut client).is_ok() {
            loop {
                thread::sleep(RECONNECT_INTERVAL);

                if set_activity(&mut client).is_err() {
                    break;
                }
            }
        }

        thread::sleep(RECONNECT_INTERVAL);
    });
}

fn set_activity(client: &mut DiscordIpcClient) -> Result<(), discord_rich_presence::error::Error> {
    client.set_activity(
        Activity::new()
            .name("AI Switcher")
            .activity_type(ActivityType::Playing),
    )
}
