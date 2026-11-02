# How Neural works

Neural is a desktop app on top of **Unified AI Base**, an open foundation with one rule: **AI proposes, the kernel authorises.** Intelligence and authority are kept apart, so you can swap models freely without changing what any of them is allowed to do.

## The three layers

**1. The app (interaction).** What you see: the Ask screen, approval cards, Activity, Permissions, Services, You and Settings. It shows things and passes your requests on. It never holds keys or talks to services itself.

**2. The model gateway (intelligence).** It turns your request into a plan. Any model can sit here: Apple's on-device model, your ChatGPT plan, Gemini, Claude or a local server. The model gets your request, the list of available capabilities and the background the kernel decides to share. It can only *propose* actions.

**3. The trusted kernel (authority).** A separate process with no model inside. It holds your identity, permissions, keys, profile and memories, and it is the only thing that touches services. For every proposal it:

1. **Validates** that the capability exists, the arguments are well formed and the task is real.
2. **Applies your policy**: Allow, Ask or Block, per service or per action. Reading defaults to allow; changing, sending and deleting default to ask; anything that spends money always asks.
3. **Confirms** with you when needed, using an approval card it writes itself from the real data. The card shows the actual recipient, file or amount, not the model's description.
4. **Executes** through the service hub (built-in services, MCP services, your Mac's apps).
5. **Verifies** the result where it can (for example, that the email really appears in Sent).
6. **Records** everything in a hash-chained activity log, so any later edit to the history is detectable.

The same action in the same task never runs twice, even if a model proposes it again.

## Keys and sign-ins

API keys, ChatGPT and Gmail sign-ins and MCP service sign-ins are stored in the macOS Keychain by the kernel. When a cloud model is called, the kernel makes the request and adds the key itself, and only for that provider's own address. The app window and the models never see a key.

## What the AI knows about you

Your profile (name, city, address, language, notes) and the things you've asked it to remember live in the kernel. With each request the kernel builds the background:

- A **model on this Mac** gets all of it.
- A **cloud model** gets your address only when the request needs it (deliveries, food, places near you). Once you have many memories, it gets only the ones that relate to the request. A small embedding model bundled with the app picks those on your Mac, by meaning (a dinner request brings your diet, allergies and payment preference).

The AI can *suggest* remembering something; saving it is an action like any other and asks you first. The **You** screen shows exactly what's sent.

## Services

- **Built-in**: files (shared folders only), Apple Mail, Contacts, Calendar, Reminders, Gmail, web search, weather, the built-in browser and this Mac.
- **MCP**: any MCP server, either a program on your Mac or an online service. Online services that need an account use the standard MCP sign-in (OAuth with PKCE), and the kernel keeps the tokens.
- MCP tools say whether they only read. Tools that don't are treated as changing things, so they ask first, until you decide otherwise in Permissions.

## Trust commitments

| Commitment | How |
|---|---|
| No unrestricted model access to your device | Models only propose; the kernel runs a fixed set of capabilities |
| No model access to raw secrets | Keys stay in the kernel and Keychain |
| Explicit, scoped, revocable permissions | Allow, Ask or Block per service or action; shared folders only |
| Independent enforcement | The kernel is a separate process with no model in it |
| Trusted confirmation | Approval cards are written by the kernel from real data |
| No duplicate actions | Idempotency per task |
| Verifiable, auditable | Result checks plus a hash-chained activity log |
| Local-first, no telemetry | Everything in `~/.uab` and the Keychain |
| Transparent cloud sharing | The model is shown on every answer; the You screen previews what's sent |
| Prompt-injection resistance | Tool results and web pages are marked as data, never instructions, and anything consequential still needs your OK |
