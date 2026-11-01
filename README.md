# Unified AI Base

**One intelligence. Every device. Any service.**
An open, model-independent foundation for intention-centric computing: you say what you want done, and it gets done. You don't have to pick the app or the device.

> AI proposes. The kernel authorises.

This repository is **Generation 1**: the core runtime and a desktop workspace.

## What's here

```
packages/
  protocol/   Shared contract: capabilities, proposals, decisions, audit records, kernel RPC
  kernel/     The trusted kernel (runs as its own process)
              identity · permissions · approvals · execution · verification · audit · vault
              + service hub: built-in services and any MCP server
  gateway/    The intelligence layer: local or cloud models turn intentions into proposals
  cli/        Command-line host (`uab "…"`)
apps/
  desktop/    Electron desktop workspace: Ask, Activity, Permissions, Services, Settings
tests/        End-to-end tests (real kernel process, scripted model)
```

### How a request flows

1. **Understand.** The gateway sends your request and the available capabilities to the model you chose.
2. **Discover.** The kernel lists every capability from built-in services and connected MCP servers.
3. **Prepare.** The model proposes one action at a time (a capability plus arguments).
4. **Validate.** The kernel checks the task, the capability, the arguments and your permissions.
5. **Confirm.** If the policy says *ask*, the kernel shows an approval card built only from its own data.
6. **Execute.** The kernel runs the action through the service hub. The model never touches a service.
7. **Verify.** The kernel checks the result and records it in a hash-chained activity history.

The same action in the same task runs only once, even if the model proposes it twice.

### Built-in services

On a Mac these use the apps already there (Mail, Contacts, Calendar, Reminders). macOS asks once per app before allowing access.

| Service | Capabilities | Default |
|---|---|---|
| Files | search, read (shared folders only) | allow |
| Contacts | find | allow |
| Apple Mail | draft (opens for you to review), send | ask |
| Calendar | list events, add, move | allow / ask |
| Reminders | list, add | allow / ask |
| This computer | time, notification, open a file or link | allow / ask |

Elsewhere, or with `UAB_DEMO_SERVICES=1` (used by the tests), Contacts reads `~/.uab/contacts.json` and Mail saves `.eml` files to a local outbox instead of sending.

Add any MCP server in `~/.uab/services.json` (same format as other MCP apps). Use `"vault:NAME"` for secrets so they stay in the Keychain.

## Run it

Requirements: Node 22+ and macOS (Linux and Windows mostly work; the vault falls back to a file there).

```bash
npm install
npm start          # build + open the desktop app
npm test           # end-to-end tests
npm run cli -- "find the q3 report and email it to sam"
```

### Pick a model

- **Local (default):** install [Ollama](https://ollama.com), then run `ollama pull qwen3:8b`. Any OpenAI-compatible local server also works (LM Studio, llama.cpp).
- **Cloud:** go to Settings → Cloud, choose Anthropic or OpenAI-compatible, and paste your API key (it's stored in the Keychain).

## Your data

Everything lives in `~/.uab` (or `$UAB_HOME`): `policy.json`, `audit.jsonl`, `tasks.jsonl`, `services.json`, `settings.json`, `contacts.json` and `outbox/`. There is no telemetry.

## Roadmap

- [x] Kernel: proposals, policy, approvals, idempotency, verification, audit, vault
- [x] Model gateway: Ollama / OpenAI-compatible / Claude
- [x] MCP host and built-in services
- [x] Desktop workspace
- [ ] Real mail and calendar services, provider SDK and a connector guide
- [ ] Conformance tests for services
- [ ] Voice input
- [ ] Android runtime and cross-device handoff (Generation 2)

## License

Apache-2.0
