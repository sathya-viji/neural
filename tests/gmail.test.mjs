// Gmail service against a fake Google API (no network, no real account).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gmail, gmailCapabilities } from "../packages/kernel/dist/builtin/gmail.js";

const dir = mkdtempSync(join(tmpdir(), "uab-gmail-"));
writeFileSync(join(dir, "report.pdf"), "%PDF-1.4 fake");
const ctx = { home: dir, policy: () => ({ rules: [], fileRoots: [dir] }) };
const cap = (id) => gmailCapabilities.find((c) => c.id === id);

const store = {
  "gmail.client": JSON.stringify({ clientId: "x.apps.googleusercontent.com", clientSecret: "secret" }),
  "gmail.token": JSON.stringify({ refreshToken: "r1", email: "me@gmail.com" }),
};
const vault = { get: async (k) => store[k] ?? null, set: async (k, v) => void (store[k] = v) };

const calls = [];
const realFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "a1", expires_in: 3600 });
    if (url.includes("/messages?q=")) return Response.json({ messages: [{ id: "m1" }] });
    if (url.includes("/messages/m1?format=metadata")) {
      return Response.json({
        id: "m1",
        threadId: "t1",
        snippet: "Here are the numbers",
        labelIds: ["UNREAD", "INBOX"],
        payload: { headers: [{ name: "From", value: "Priya <priya@example.com>" }, { name: "Subject", value: "Q3" }, { name: "Date", value: "Sun, 1 Nov 2026" }, { name: "Message-ID", value: "<abc@mail>" }] },
      });
    }
    if (url.includes("/messages/m1?format=full")) {
      const data = Buffer.from("Hello from Priya").toString("base64url");
      return Response.json({ id: "m1", threadId: "t1", payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Q3" }], parts: [{ mimeType: "text/plain", body: { data } }, { filename: "q3.pdf", mimeType: "application/pdf", body: {} }] } });
    }
    if (url.endsWith("/messages/send")) return Response.json({ id: "s1" });
    if (url.includes("/messages/s1?format=minimal")) return Response.json({ id: "s1", labelIds: ["SENT"] });
    return new Response("not found", { status: 404 });
  };
  await gmail.init(vault);
});

after(() => {
  globalThis.fetch = realFetch;
});

test("search refreshes the token and returns sender, subject and id", async () => {
  const r = await cap("gmail.search").run({ query: "from:priya" }, ctx);
  assert.match(r.content, /\[unread\].*Priya.*"Q3"/);
  assert.match(r.content, /id m1/);
  assert.ok(calls[0].url.startsWith("https://oauth2.googleapis.com/token"));
});

test("read returns the plain text and lists attachments", async () => {
  const r = await cap("gmail.read").run({ id: "m1" }, ctx);
  assert.match(r.content, /Hello from Priya/);
  assert.match(r.content, /Attachments: q3\.pdf/);
});

test("send builds a reply with the attachment, in the same thread, and verifies it was sent", async () => {
  const args = { to: ["priya@example.com"], subject: "Re: Q3", body: "Attached.", attachments: [join(dir, "report.pdf")], replyTo: "m1" };
  const r = await cap("gmail.send").run(args, ctx);
  assert.match(r.content, /Sent from Gmail \(me@gmail.com\)/);
  const sendCall = calls.find((c) => c.url.endsWith("/messages/send"));
  const body = JSON.parse(sendCall.body);
  assert.equal(body.threadId, "t1");
  const mime = Buffer.from(body.raw, "base64url").toString("utf8");
  assert.match(mime, /In-Reply-To: <abc@mail>/);
  assert.match(mime, /filename="report.pdf"/);
  assert.match(mime, /Content-Type: application\/pdf/);
  assert.equal(await cap("gmail.send").verify(args, r, ctx), true);
});

test("attachments outside shared folders are refused", async () => {
  await assert.rejects(cap("gmail.send").run({ to: ["a@example.com"], subject: "x", body: "y", attachments: ["/etc/hosts"] }, ctx), /outside the folders/);
});

test("sign-in: Google page with PKCE, and a reply with the wrong state is rejected", async () => {
  const { get } = await import("node:http");
  const { url } = await gmail.connect();
  const u = new URL(url);
  assert.equal(u.origin, "https://accounts.google.com");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("scope"), /gmail\.readonly.*gmail\.compose/);
  assert.equal(gmail.status().connecting, true);
  const redirect = u.searchParams.get("redirect_uri");
  const status = await new Promise((resolve) => get(`${redirect}/?state=forged&code=x`, (res) => (res.resume(), resolve(res.statusCode))));
  assert.equal(status, 400);
  assert.equal(gmail.status().connecting, false);
  assert.equal(gmail.status().connected, true); // the earlier account is untouched
});

test("approval summary names the account", async () => {
  assert.match(await cap("gmail.send").summarize({ to: ["a@example.com"], subject: "Hi" }), /from me@gmail.com/);
});
