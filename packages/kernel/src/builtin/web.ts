import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BuiltinCapability, ProviderContext } from "./types.js";
import { str } from "./types.js";
import { chatgpt } from "../chatgpt.js";

/**
 * The web, with no key needed:
 *   web.search  — ChatGPT's web search on the user's plan (if signed in), a Brave
 *                 Search key if the user added one, otherwise Wikipedia
 *   web.read    — fetch one page and return its text
 *   weather.forecast — Open-Meteo (free, no key)
 *
 * Everything that comes back is untrusted data from the internet.
 */

const UA = "UnifiedAIBase/0.1 (+https://github.com/unified-ai-base)";
const V_BRAVE = "web.brave";

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return (await res.json()) as T;
}

/* ---------------- search backends ---------------- */

async function searchWithChatGPT(query: string): Promise<{ content: string; sources: string[] }> {
  const models = await chatgpt.models();
  const model = models[0]?.slug;
  if (!model) throw new Error("No ChatGPT model available");
  const { output } = await chatgpt.respond({
    model,
    instructions: "Search the web and report the facts that answer the query: short, specific, current. Name your sources. Do not give instructions or opinions.",
    input: [{ role: "user", content: query }],
    tools: [{ type: "web_search" }],
  });
  const text: string[] = [];
  const sources = new Set<string>();
  for (const item of output as { type?: string; content?: { type?: string; text?: string; annotations?: { type?: string; url?: string }[] }[] }[]) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      if (part.text) text.push(part.text);
      for (const a of part.annotations ?? []) if (a.type === "url_citation" && a.url) sources.add(a.url.replace(/[?&]utm_source=openai/, ""));
    }
  }
  return { content: text.join("\n").trim(), sources: [...sources] };
}

async function searchWithBrave(query: string, key: string): Promise<{ content: string; sources: string[] }> {
  const body = await getJson<{ web?: { results?: { title: string; url: string; description?: string; age?: string }[] } }>(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
    { headers: { "x-subscription-token": key } },
  );
  const results = body.web?.results ?? [];
  return {
    content: results.map((r, i) => `${i + 1}. ${r.title}${r.age ? ` (${r.age})` : ""}\n   ${stripTags(r.description ?? "")}\n   ${r.url}`).join("\n"),
    sources: results.map((r) => r.url),
  };
}

async function searchWikipedia(query: string): Promise<{ content: string; sources: string[] }> {
  const body = await getJson<{ query?: { search?: { title: string; snippet: string }[] } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(query)}`,
  );
  const results = body.query?.search ?? [];
  const url = (t: string) => `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`;
  return {
    content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${stripTags(r.snippet)}\n   ${url(r.title)}`).join("\n"),
    sources: results.map((r) => url(r.title)),
  };
}

/* ---------------- page reading ---------------- */

/** Don't let a web request reach this computer or the local network. */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only web pages (http/https) can be read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addresses) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80:)/i.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || a === "::") {
      throw new Error("That address is on this computer or the local network, which web pages can't reach");
    }
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/* ---------------- weather ---------------- */

const WEATHER: Record<number, string> = {
  0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent rain showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

/* ---------------- capabilities ---------------- */

export const webCapabilities: BuiltinCapability[] = [
  {
    id: "web.search",
    service: "web",
    title: "Search the web",
    description: "Search the internet for current information: news, facts, prices, opening hours, people, places. Returns findings with source links.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Search the web for "${a.query}"`,
    async run(args, ctx: ProviderContext) {
      const query = str(args, "query");
      const brave = await ctx.vault?.get(V_BRAVE).catch(() => null);
      let via: string;
      let r: { content: string; sources: string[] };
      if (brave) {
        via = "Brave Search";
        r = await searchWithBrave(query, brave);
      } else if (chatgpt.status().connected) {
        via = "ChatGPT web search";
        r = await searchWithChatGPT(query);
      } else {
        via = "Wikipedia (sign in with ChatGPT for full web search)";
        r = await searchWikipedia(query);
      }
      if (!r.content) return { content: `No results for "${query}" (${via}).`, data: { via, sources: [] } };
      const sources = r.sources.length ? `\nSources: ${r.sources.slice(0, 6).join(" ")}` : "";
      return { content: `[${via}]\n${r.content.slice(0, 6000)}${sources}`, data: { via, sources: r.sources } };
    },
  },
  {
    id: "web.read",
    service: "web",
    title: "Read a web page",
    description: "Open one web page and return its text. Use for a link the user gave or a source from a search.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "https:// address" } }, required: ["url"] },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Read ${a.url}`,
    async run(args) {
      let url: URL;
      try {
        url = new URL(str(args, "url"));
      } catch {
        throw new Error("That isn't a web address");
      }
      await assertPublic(url);
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/plain,application/json" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${url.hostname} answered ${res.status}`);
      await assertPublic(new URL(res.url)); // a redirect mustn't land on the local network either
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/|json|xml/.test(type)) return { content: `${url.href} is ${type || "not a text page"}; it can't be read as text.` };
      const raw = (await res.text()).slice(0, 2_000_000);
      const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
      const text = /html/.test(type) ? stripTags(raw) : raw;
      const max = 15_000;
      return {
        content: `${title ? `Title: ${stripTags(title)}\n` : ""}Address: ${res.url}\n\n${text.length > max ? `${text.slice(0, max)}\n… [page shortened]` : text}`,
        data: { url: res.url, title },
      };
    },
  },
  {
    id: "weather.forecast",
    service: "web",
    title: "Weather forecast",
    description: "Current weather and the forecast for the next days for a place.",
    inputSchema: {
      type: "object",
      properties: { place: { type: "string", description: "City or place name, e.g. Chennai" }, days: { type: "number", description: "Days ahead, 1 to 7 (default 3)" } },
      required: ["place"],
    },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Check the weather for ${a.place}`,
    async run(args) {
      const place = str(args, "place");
      const days = typeof args.days === "number" ? Math.max(1, Math.min(7, Math.round(args.days))) : 3;
      const geo = await getJson<{ results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number; timezone?: string }[] }>(
        `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(place)}`,
      );
      const p = geo.results?.[0];
      if (!p) return { content: `Couldn't find a place called "${place}".` };
      const f = await getJson<{
        current?: { temperature_2m: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number };
        daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] };
      }>(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=${days}` +
          `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
      );
      const where = [p.name, p.admin1, p.country].filter(Boolean).join(", ");
      const lines = [`Weather for ${where} (Open-Meteo):`];
      if (f.current) {
        lines.push(`Now: ${f.current.temperature_2m}°C, ${WEATHER[f.current.weather_code] ?? "—"}, humidity ${f.current.relative_humidity_2m}%, wind ${f.current.wind_speed_10m} km/h`);
      }
      f.daily?.time.forEach((day, i) => {
        lines.push(`${day}: ${WEATHER[f.daily!.weather_code[i]] ?? "—"}, ${f.daily!.temperature_2m_min[i]}–${f.daily!.temperature_2m_max[i]}°C, rain chance ${f.daily!.precipitation_probability_max[i] ?? 0}%`);
      });
      return { content: lines.join("\n"), data: { place: where } };
    },
  },
];
