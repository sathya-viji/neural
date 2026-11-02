#!/usr/bin/env node
/**
 * Connector check: does this MCP server tell Neural's kernel enough to keep the
 * user in control? It connects, lists the tools and reports problems.
 *
 *   uab-check -- node my-connector.js        a program
 *   uab-check --url http://127.0.0.1:4100/mcp an online service (one that doesn't need sign-in)
 *
 * Exit code 1 if anything fails. Warnings don't fail the check.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CONNECTOR_META, EFFECTS, MIN_RISK, type Effect, type Risk } from "@uab/protocol";

export interface Finding {
  level: "fail" | "warn" | "pass";
  tool?: string;
  message: string;
}

interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  _meta?: Record<string, unknown>;
}

const ORDER: Risk[] = ["low", "medium", "high"];

/** Check a list of tools as an MCP server returned them. */
export function checkTools(tools: ToolInfo[]): Finding[] {
  const out: Finding[] = [];
  if (!tools.length) return [{ level: "fail", message: "The connector offers no tools." }];
  const seen = new Set<string>();
  for (const t of tools) {
    const f = (level: Finding["level"], message: string) => out.push({ level, tool: t.name, message });
    if (seen.has(t.name)) f("fail", "Two tools share this name.");
    seen.add(t.name);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) f("warn", "Use a snake_case name, e.g. add_note.");
    if (!t.description || t.description.trim().length < 15) f("fail", "Needs a description that says what it does and when to use it (the AI reads this).");
    else if (t.description.length > 1024) f("warn", "The description is over 1024 characters; models may cut it.");
    if (!t.title && !t.annotations?.title) f("warn", "Add a short human title (shown in Permissions and approval cards).");
    if (t.inputSchema?.type !== "object") f("fail", 'inputSchema must be a JSON Schema with type "object".');
    for (const r of t.inputSchema?.required ?? []) if (!(r in (t.inputSchema?.properties ?? {}))) f("fail", `Required argument "${r}" isn't described in properties.`);

    const raw = t._meta?.[CONNECTOR_META.effects];
    if (raw === undefined) {
      if (t.annotations?.readOnlyHint === undefined) f("warn", `No labels: the kernel will treat it as high risk and always ask. Declare ${CONNECTOR_META.effects} (or at least readOnlyHint).`);
      else f("warn", `Only MCP hints: declare ${CONNECTOR_META.effects} so the kernel knows exactly what it does.`);
      continue;
    }
    if (!Array.isArray(raw) || !raw.length) {
      f("fail", `${CONNECTOR_META.effects} must be a non-empty list.`);
      continue;
    }
    const bad = raw.filter((e) => !EFFECTS.includes(e as Effect));
    if (bad.length) f("fail", `Unknown effects: ${bad.join(", ")}. Use ${EFFECTS.join(", ")}.`);
    const effects = raw.filter((e): e is Effect => EFFECTS.includes(e as Effect));
    const readOnly = effects.every((e) => e === "read");
    if (t.annotations?.readOnlyHint === true && !readOnly) f("fail", `readOnlyHint says it only reads, but it declares ${effects.filter((e) => e !== "read").join(", ")}.`);
    if (t.annotations?.readOnlyHint === false && readOnly) f("warn", "readOnlyHint is false but the effects say it only reads.");
    if (effects.includes("delete") && t.annotations?.destructiveHint === false) f("fail", "It deletes, but destructiveHint is false.");
    const risk = t._meta?.[CONNECTOR_META.risk] as Risk | undefined;
    if (risk !== undefined && !ORDER.includes(risk)) f("fail", `${CONNECTOR_META.risk} must be low, medium or high.`);
    const floor = effects.map((e) => MIN_RISK[e]).reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "low" as Risk);
    if (risk && ORDER.indexOf(risk) < ORDER.indexOf(floor)) f("warn", `Declared risk "${risk}" is below what ${effects.join(", ")} implies; the kernel will use "${floor}".`);

    const summary = t._meta?.[CONNECTOR_META.summary];
    if (summary !== undefined) {
      if (typeof summary !== "string") f("fail", `${CONNECTOR_META.summary} must be text.`);
      else
        for (const key of summary.match(/\{([\w.]+)\}/g) ?? []) {
          const field = key.slice(1, -1).split(".")[0];
          if (!(field in (t.inputSchema?.properties ?? {}))) f("fail", `The approval-card summary uses {${field}}, which isn't an argument.`);
        }
    } else if (!readOnly) f("warn", "Add a summary template so the approval card reads well (e.g. 'Send {amount} to {to}').");
  }
  for (const t of tools) if (!out.some((x) => x.tool === t.name && x.level !== "pass")) out.push({ level: "pass", tool: t.name, message: "Looks good." });
  return out;
}

/** Connect to a connector (a command or a URL), list its tools and check them. */
export async function checkConnector(target: { command: string[] } | { url: string }): Promise<{ server?: { name: string; version: string }; findings: Finding[] }> {
  const client = new Client({ name: "uab-check", version: "0.1.0" });
  const transport =
    "url" in target
      ? new StreamableHTTPClientTransport(new URL(target.url))
      : new StdioClientTransport({ command: target.command[0], args: target.command.slice(1), env: getDefaultEnvironment(), stderr: "ignore" });
  try {
    await client.connect(transport);
  } catch (err) {
    const message = /401|unauthori[sz]ed/i.test(String(err)) ? "This service needs sign-in. Run the check against a local copy." : `Couldn't connect: ${(err as Error).message}`;
    return { findings: [{ level: "fail", message }] };
  }
  try {
    const info = client.getServerVersion();
    const { tools } = await client.listTools();
    const findings = checkTools(tools as ToolInfo[]);
    if (!info?.name || !info?.version) findings.unshift({ level: "warn", message: "The server should report a name and version." });
    return { server: info ? { name: info.name, version: info.version } : undefined, findings };
  } finally {
    await client.close().catch(() => {});
  }
}

// Command line
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("uab-check")) {
  const args = process.argv.slice(2);
  const urlAt = args.indexOf("--url");
  const dash = args.indexOf("--");
  const target = urlAt >= 0 ? { url: args[urlAt + 1] } : { command: dash >= 0 ? args.slice(dash + 1) : args };
  if (!("url" in target) && !target.command.length) {
    console.log("Usage: uab-check -- node my-connector.js   |   uab-check --url http://127.0.0.1:4100/mcp");
    process.exit(2);
  }
  const { server, findings } = await checkConnector(target);
  if (server) console.log(`${server.name} ${server.version}\n`);
  const icon = { pass: "✓", warn: "!", fail: "✗" };
  for (const f of findings) console.log(`${icon[f.level]} ${f.tool ? `${f.tool}: ` : ""}${f.message}`);
  const fails = findings.filter((f) => f.level === "fail").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  console.log(`\n${fails ? `${fails} failed` : "Passed"}${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""}.`);
  process.exit(fails ? 1 : 0);
}
