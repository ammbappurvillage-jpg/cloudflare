# Mraprguild Telegram Relay — Cloudflare Worker

This Worker is included for shared hosting (including InfinityFree) that cannot make direct outbound requests to `api.telegram.org`. Telegram's webhook and bot replies run on Cloudflare. WordPress stores publish notifications in a protected queue; the Worker reads that queue on a one-minute Cron Trigger and sends the messages to Telegram.

## 1. Create the Worker

1. Sign in to Cloudflare and open **Workers & Pages**.
2. Create a Worker, for example `mraprguild-tmdb-telegram-relay`.
3. Open the Worker editor and replace its starter code with the complete contents of `worker.js`.
4. Deploy the Worker and copy its HTTPS URL, for example `https://mraprguild-tmdb-telegram-relay.YOUR-SUBDOMAIN.workers.dev`.

## 2. Add Worker secrets and variables

In the Worker settings, open **Variables and Secrets**. Add these values:

| Name | Type | Value |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | Token from `@BotFather` |
| `TMDB_API_KEY` | Secret | TMDB API v3 key |
| `RELAY_SECRET` | Secret | A private random value of at least 32 characters |
| `WP_SITE_URL` | Variable | Full WordPress URL, e.g. `https://example.com` (no trailing slash) |
| `TELEGRAM_WEBHOOK_SECRET` | Secret or variable | Optional; must exactly match the Webhook Secret Token in WordPress |
| `TELEGRAM_CHAT_ID` | Variable | Optional fallback destination chat ID |
| `ALLOWED_CHAT_IDS` | Variable | Optional comma-separated user/group chat IDs; leave blank to permit all chats |

Use the same `RELAY_SECRET` in the WordPress plugin settings. Do not publish it or send it to anyone. If you set `TELEGRAM_WEBHOOK_SECRET`, copy that exact value into the plugin's **Webhook Secret Token** field too.

## 3. Enable the Cron Trigger

The `wrangler.toml` file already specifies a one-minute Cron Trigger. In the Cloudflare dashboard, open the Worker's **Triggers** settings and add the schedule `*/1 * * * *` (every minute). Deploy/save the trigger.

This trigger is required for WordPress publish notifications to be delivered. It polls the protected WordPress relay queue, sends each message, and acknowledges successful deliveries. Failed messages remain queued for a later retry.

## 4. Configure WordPress

1. Install and activate the updated Mraprguild TMDB + Telegram plugin ZIP.
2. Go to **Mraprguild Movies → TMDB + Telegram**.
3. Set **Telegram connection mode** to **Cloudflare Worker relay**.
4. Paste the deployed Worker URL into **Cloudflare Worker URL**.
5. Paste the exact same `RELAY_SECRET` into **Cloudflare Relay Secret**.
6. Enter the Telegram destination group/channel ID in **Notification Chat ID**. Add the bot to that group/channel; for a channel, make it an administrator with permission to post.
7. Keep **Automatically notify** enabled if you want publish notifications.
8. Save settings.

The WordPress TMDB API key remains in WordPress for movie imports and shortcodes. The Worker also needs the same TMDB key as its own `TMDB_API_KEY` secret so it can answer Telegram `/movie` commands. If WordPress cannot reach TMDB directly, the updated plugin tries the authenticated Worker TMDB proxy as a fallback; that fallback requires WordPress PHP to be able to reach the Worker hostname.

## 5. Register the Telegram webhook

Preferred: click **Register Telegram Webhook / Worker** in the WordPress settings screen.

If InfinityFree cannot resolve the Worker hostname from PHP, open the Worker setup page in your normal browser:

`https://YOUR-WORKER-URL/admin`

Enter the same `RELAY_SECRET` and submit **Register Telegram Webhook**. This makes the Worker call the Telegram API from Cloudflare, not from InfinityFree. The page does not put the secret in the URL.

## 6. Test

1. In WordPress settings, click **Test TMDB and Telegram**. The PHP-to-Worker check can fail if InfinityFree blocks outgoing access even though the browser setup succeeded; in that case test the bot itself.
2. Open the Telegram bot and send `/start`.
3. Send `/movie 550` or `/tmdb 550` to test TMDB lookups from Cloudflare.
4. Import a movie as a draft, then publish it. A notification should arrive in the configured chat on the next Cron Trigger run (normally within about a minute).
5. Use **Send movie to Telegram** in a movie's edit screen to queue a manual notification.

## 7. WordPress relay endpoint

The Worker reads:

`/wp-json/mraprguild-tmdb-telegram/v1/relay/queue`

and acknowledges successful deliveries at:

`/wp-json/mraprguild-tmdb-telegram/v1/relay/ack`

Both endpoints require the `X-MRGTT-Relay-Secret` request header. An unauthenticated request should return HTTP 401. The WordPress site must be public over HTTPS and must allow its REST API routes to be reached by Cloudflare.

## 8. Important limits and troubleshooting

- The Worker removes the need for WordPress to connect to `api.telegram.org` for bot commands and delivery.
- WordPress movie imports first try TMDB directly and can fall back to the authenticated Worker TMDB proxy if that request fails. The fallback requires PHP outbound access to your Worker hostname. The Worker independently connects to TMDB for bot commands.
- If `/movie` works but WordPress imports fail, check the WordPress-to-TMDB connection using the plugin's **Test TMDB and Telegram** action and ask InfinityFree to allow `api.themoviedb.org` and `image.tmdb.org`.
- If bot commands work but publish notifications do not, check that the Cron Trigger exists, `WP_SITE_URL` is correct, the plugin is active, the REST API is not blocked, and `RELAY_SECRET` matches exactly on both sides.
- If webhook setup reports `Invalid Relay Secret`, compare the WordPress Relay Secret with the Cloudflare `RELAY_SECRET` secret.
- If Telegram reports that the bot cannot post, add it to the destination group/channel and grant message permissions.
- If you change the bot token, update the Cloudflare `TELEGRAM_BOT_TOKEN` secret and deploy/save the Worker settings, then register the webhook again.
- The queue keeps up to 100 pending messages. A failed Telegram send is not acknowledged, so it remains available for retry.

This is a relay integration, not a way to bypass Telegram restrictions on the bot or a hosting provider's general policies. Live operation still depends on valid API credentials, a public WordPress REST API, and a deployed Worker with the described secrets and Cron Trigger.
