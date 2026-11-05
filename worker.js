/**
 * Mraprguild TMDB + Telegram relay for restricted shared hosting.
 * Secrets (Cloudflare Worker > Settings > Variables and Secrets):
 *   TELEGRAM_BOT_TOKEN (secret)
 *   TMDB_API_KEY (secret)
 *   RELAY_SECRET (secret; same value configured in WordPress)
 * Optional variables:
 *   WP_SITE_URL (e.g. https://example.com)
 *   TELEGRAM_WEBHOOK_SECRET (must match WordPress setting if used)
 *   TELEGRAM_CHAT_ID (fallback notification destination)
 *   ALLOWED_CHAT_IDS (comma-separated numeric Telegram chat IDs; blank allows all chats)
 */

const WP_NAMESPACE = "/wp-json/mraprguild-tmdb-telegram/v1/relay";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(request, env, bodySecret = "") {
  const supplied = request.headers.get("X-MRGTT-Relay-Secret") || bodySecret || "";
  return !!env.RELAY_SECRET && constantTimeEqual(supplied, env.RELAY_SECRET);
}

async function telegram(env, method, payload = null, httpMethod = "POST") {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN Worker secret.");
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const options = { method: httpMethod, headers: { accept: "application/json" } };
  if (payload && httpMethod !== "GET") {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram API returned HTTP ${response.status}.`);
  }
  return data;
}

async function tmdb(env, id) {
  if (!env.TMDB_API_KEY) throw new Error("Missing TMDB_API_KEY Worker secret.");
  const url = new URL(`https://api.themoviedb.org/3/movie/${encodeURIComponent(id)}`);
  url.searchParams.set("api_key", env.TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("append_to_response", "credits,videos");
  const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const movie = await response.json().catch(() => ({}));
  if (!response.ok || movie.success === false || !movie.id) {
    throw new Error(movie.status_message || `TMDB returned HTTP ${response.status}. Check the movie ID and TMDB_API_KEY.`);
  }
  return movie;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function director(movie) {
  const crew = movie?.credits?.crew || [];
  const person = crew.find((p) => String(p.job || "").toLowerCase() === "director");
  return person?.name || "";
}

function producers(movie) {
  const names = (movie?.credits?.crew || [])
    .filter((p) => String(p.job || "").toLowerCase() === "producer")
    .map((p) => p.name)
    .filter(Boolean);
  return [...new Set(names)].slice(0, 3).join(", ");
}

function cast(movie) {
  return (movie?.credits?.cast || []).slice(0, 7).map((p) => p.name).filter(Boolean).join(", ");
}

function trailer(movie) {
  const videos = movie?.videos?.results || [];
  const item = videos.find((v) => String(v.site).toLowerCase() === "youtube" && v.key && ["trailer", "teaser"].includes(String(v.type).toLowerCase()));
  return item ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.key)}` : "";
}

function movieMessage(movie) {
  let text = `<b>🎬 ${esc(movie.title || "Movie")}</b>`;
  if (movie.tagline) text += `\n<i>${esc(movie.tagline)}</i>`;
  if (movie.release_date) text += `\n<b>Release:</b> ${esc(movie.release_date)}`;
  if (movie.runtime) text += `\n<b>Runtime:</b> ${Number(movie.runtime)} min`;
  const genres = (movie.genres || []).map((g) => g.name).filter(Boolean).join(", ");
  if (genres) text += `\n<b>Genres:</b> ${esc(genres)}`;
  if (movie.vote_average !== undefined) text += `\n<b>TMDB Rating:</b> ${Number(movie.vote_average).toFixed(1)}/10 (${Number(movie.vote_count || 0)} votes)`;
  if (movie.status) text += `\n<b>Status:</b> ${esc(movie.status)}`;
  const dir = director(movie);
  if (dir) text += `\n<b>Director:</b> ${esc(dir)}`;
  const prod = producers(movie);
  if (prod) text += `\n<b>Producer:</b> ${esc(prod)}`;
  const actors = cast(movie);
  if (actors) text += `\n<b>Cast:</b> ${esc(actors)}`;
  if (movie.overview) {
    const overview = Array.from(String(movie.overview)).slice(0, 900).join("");
    text += `\n\n<b>Overview:</b>\n${esc(overview)}`;
  }
  const trailerUrl = trailer(movie);
  if (trailerUrl) text += `\n\n<a href="${esc(trailerUrl)}">Watch trailer</a>`;
  if (movie.homepage && /^https:\/\//i.test(movie.homepage)) text += `\n<a href="${esc(movie.homepage)}">Official website</a>`;
  text += `\n<a href="https://www.themoviedb.org/movie/${Number(movie.id)}">View on TMDB</a>`;
  text += "\n\n<i>Data provided by TMDB. This bot is not endorsed or certified by TMDB.</i>";
  const chars = Array.from(text);
  if (chars.length > 3900) text = chars.slice(0, 3850).join("") + "…\n\n<i>Data: TMDB.</i>";
  return text;
}

function allowedChat(chatId, env) {
  const raw = String(env.ALLOWED_CHAT_IDS || "").trim();
  if (!raw) return true;
  return raw.split(",").map((v) => v.trim()).includes(String(chatId));
}

async function processTelegramUpdate(update, env) {
  const message = update?.message;
  if (!message?.chat?.id || !message?.text) return;
  const chatId = String(message.chat.id);
  if (!allowedChat(chatId, env)) return;
  const text = String(message.text).trim();
  const match = text.match(/^\/(start|help|movie|tmdb)(?:@[A-Za-z0-9_]+)?(?:\s+(\d+))?(?:\s|$)/i);
  if (!match) return;
  const command = match[1].toLowerCase();
  const id = match[2] ? Number.parseInt(match[2], 10) : 0;
  if (command === "start" || command === "help") {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "<b>Mraprguild Movie Bot</b>\n\nUse <code>/movie TMDB_ID</code> to get movie details.\nExample: <code>/movie 550</code>\n\nYou can also use <code>/tmdb TMDB_ID</code>.",
      parse_mode: "HTML",
    });
    return;
  }
  if (!id || id < 1) {
    await telegram(env, "sendMessage", { chat_id: chatId, text: "Please enter a TMDB movie ID. Example: /movie 550" });
    return;
  }
  try {
    const movie = await tmdb(env, id);
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: movieMessage(movie),
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
  } catch (error) {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: `Could not fetch that movie: ${String(error.message || error).slice(0, 700)}`,
    });
  }
}

async function health(env) {
  const [botResult, tmdbResult] = await Promise.allSettled([
    telegram(env, "getMe", null, "GET"),
    (async () => {
      if (!env.TMDB_API_KEY) throw new Error("Missing TMDB_API_KEY.");
      const url = new URL("https://api.themoviedb.org/3/configuration");
      url.searchParams.set("api_key", env.TMDB_API_KEY);
      const r = await fetch(url.toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.images) throw new Error(d.status_message || `TMDB HTTP ${r.status}`);
      return true;
    })(),
  ]);
  if (botResult.status === "rejected") throw botResult.reason;
  return {
    ok: true,
    telegram: { username: botResult.value.result?.username || "" },
    tmdb_ok: tmdbResult.status === "fulfilled",
    tmdb_error: tmdbResult.status === "rejected" ? String(tmdbResult.reason?.message || tmdbResult.reason) : "",
  };
}

async function pollWordPressQueue(env) {
  if (!env.WP_SITE_URL || !env.RELAY_SECRET) return;
  const root = String(env.WP_SITE_URL).replace(/\/$/, "");
  const queueUrl = `${root}${WP_NAMESPACE}/queue?limit=10`;
  const queueResponse = await fetch(queueUrl, {
    headers: { "X-MRGTT-Relay-Secret": env.RELAY_SECRET, accept: "application/json" },
  });
  if (!queueResponse.ok) throw new Error(`WordPress queue returned HTTP ${queueResponse.status}.`);
  const queueData = await queueResponse.json();
  if (!queueData.ok || !Array.isArray(queueData.items)) throw new Error("WordPress returned an invalid notification queue.");
  for (const item of queueData.items) {
    if (!item.id || !item.text) continue;
    const chatId = item.chat_id || env.TELEGRAM_CHAT_ID;
    if (!chatId) {
      console.error(`Queue item ${item.id} has no chat ID; leaving it queued.`);
      continue;
    }
    try {
      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: String(item.text),
        parse_mode: "HTML",
        disable_web_page_preview: false,
      });
      const ack = await fetch(`${root}${WP_NAMESPACE}/ack`, {
        method: "POST",
        headers: {
          "X-MRGTT-Relay-Secret": env.RELAY_SECRET,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ id: item.id }),
      });
      if (!ack.ok) console.error(`Could not acknowledge queue item ${item.id}: HTTP ${ack.status}`);
    } catch (error) {
      // Do not acknowledge failed sends; the next scheduled run retries the item.
      console.error(`Telegram queue delivery failed for ${item.id}:`, error);
    }
  }
}

function adminPage() {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mraprguild Relay Setup</title><style>body{font:16px system-ui;max-width:620px;margin:40px auto;padding:0 16px;color:#172033}main{border:1px solid #ddd;border-radius:14px;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #aaa}button{background:#18243a;color:white;border:0;font-weight:700}.danger{background:#8a1c1c}</style></head><body><main><h1>Mraprguild Telegram Relay</h1><p>Enter the private RELAY_SECRET configured in your Cloudflare Worker. The secret is sent in the request body and is not placed in the URL.</p><form method="post" action="/setup"><label>Relay Secret<input name="secret" type="password" required autocomplete="off"></label><button type="submit">Register Telegram Webhook</button></form><form method="post" action="/delete-webhook"><label>Relay Secret<input name="secret" type="password" required autocomplete="off"></label><button class="danger" type="submit">Remove Telegram Webhook</button></form><p>After registration, use the WordPress plugin's Test Connections button to verify Telegram and TMDB.</p></main></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/admin") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return adminPage();
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) return json({ ok: false, error: "Forbidden" }, 403);
      }
      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false, error: "Invalid JSON" }, 400);
      try {
        await processTelegramUpdate(update, env);
        return json({ ok: true });
      } catch (error) {
        console.error("Telegram update failed:", error);
        return json({ ok: false, error: String(error.message || error) }, 500);
      }
    }
    if (url.pathname === "/setup" && request.method === "POST") {
      let body = {};
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) body = await request.json().catch(() => ({}));
      else {
        const form = await request.formData().catch(() => null);
        if (form) body.secret = String(form.get("secret") || "");
      }
      if (!isAuthorized(request, env, String(body.secret || ""))) return json({ ok: false, error: "Invalid Relay Secret" }, 403);
      try {
        const webhookUrl = `${url.origin}/telegram`;
        const result = await telegram(env, "setWebhook", {
          url: webhookUrl,
          allowed_updates: ["message"],
          ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
        });
        return json({ ok: true, description: result.description || `Webhook registered: ${webhookUrl}`, webhook_url: webhookUrl });
      } catch (error) {
        return json({ ok: false, error: String(error.message || error) }, 502);
      }
    }
    if (url.pathname === "/delete-webhook" && request.method === "POST") {
      let bodySecret = "";
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = await request.json().catch(() => ({}));
        bodySecret = String(body.secret || "");
      } else if (contentType.includes("form")) {
        const form = await request.formData().catch(() => null);
        if (form) bodySecret = String(form.get("secret") || "");
      }
      if (!isAuthorized(request, env, bodySecret)) return json({ ok: false, error: "Unauthorized" }, 403);
      try {
        const result = await telegram(env, "deleteWebhook", { drop_pending_updates: false });
        return json({ ok: true, description: result.description || "Webhook removed." });
      } catch (error) {
        return json({ ok: false, error: String(error.message || error) }, 502);
      }
    }
    if (url.pathname.startsWith("/tmdb/") && request.method === "GET") {
      if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 403);
      const tmdbPath = url.pathname.slice("/tmdb/".length);
      if (!(tmdbPath === "configuration" || /^movie\/\d+$/.test(tmdbPath))) {
        return json({ ok: false, error: "TMDB proxy path is not allowed." }, 404);
      }
      if (!env.TMDB_API_KEY) return json({ ok: false, error: "Missing TMDB_API_KEY Worker secret." }, 500);
      const upstream = new URL(`https://api.themoviedb.org/3/${tmdbPath}`);
      for (const [key, value] of url.searchParams.entries()) {
        if (key !== "api_key") upstream.searchParams.set(key, value);
      }
      upstream.searchParams.set("api_key", env.TMDB_API_KEY);
      const tmdbResponse = await fetch(upstream.toString(), { headers: { accept: "application/json" } });
      const body = await tmdbResponse.text();
      return new Response(body, {
        status: tmdbResponse.status,
        headers: {
          "content-type": tmdbResponse.headers.get("content-type") || "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 403);
      try {
        return json(await health(env));
      } catch (error) {
        return json({ ok: false, error: String(error.message || error) }, 502);
      }
    }
    return json({ ok: false, error: "Not found" }, 404);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pollWordPressQueue(env));
  },
};
