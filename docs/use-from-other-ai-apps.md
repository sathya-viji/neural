# Use Neural from other AI apps

Claude Desktop, ChatGPT, Cursor and other apps that support MCP can act **through** Neural. They get the services you've connected (files, mail, calendar, Gmail, Zomato and so on), but:

- every action follows **your permissions in Neural**
- anything important asks **you in Neural**, and the approval card names the app that asked
- everything is recorded in Neural's **Activity**
- the other app never sees your keys or sign-ins

## Set it up

1. In Neural: **Settings → Other AI apps → Let other AI apps use Neural**.
2. Click **Copy setup**. You get something like this (with your own pairing key):

   ```json
   {
     "mcpServers": {
       "neural": {
         "command": "/Applications/Neural.app/Contents/MacOS/Neural",
         "args": ["/Applications/Neural.app/Contents/Resources/app/dist/uab-mcp.js"],
         "env": { "ELECTRON_RUN_AS_NODE": "1", "NEURAL_PAIRING_KEY": "…", "UAB_HOME": "/Users/you/.uab" }
       }
     }
   }
   ```

3. Paste it into the other app's MCP configuration. For **Claude Desktop**: Settings → Developer → Edit Config, merge it into `claude_desktop_config.json`, and restart Claude Desktop.
4. Keep Neural open while you use it. If it's closed, the other app gets a short message asking you to open it.

## Approving from anywhere

When another app asks for something that needs your OK, the kernel's approval card can be answered in three places. Whichever you answer first counts:

- **Neural on your Mac:** the card appears in Neural (with a notification if it's in the background).
- **In the app's own chat:** turn on *Settings → Other AI apps → Let these apps ask me to approve in their own chat*. Neural offers its card to the app in two standard ways: as a confirmation prompt (MCP elicitation) and as an interactive card (MCP Apps), whose buttons use tools the AI can't see plus a one-time code. The app draws it and only you can answer it, not the AI. Whether it appears depends on the app: as of November 2026, Claude Desktop's chat doesn't show either for locally run connectors, so approve in Neural or on your phone. **Anything that spends money is always approved in Neural itself.**
- **On your phone, in Neural's approvals page:** *Settings → Approve from your phone* (same Wi-Fi as the Mac).

If you take longer than about 40 seconds, the app is told the request is waiting for your OK, not that it failed. It can check the outcome later with `neural_check_request`, so nothing is done twice.

## How it stays safe

- **Off by default.** Nothing can connect until you switch it on.
- **Pairing key.** Only apps whose config contains the key can connect. **New pairing key** in Settings cuts off every app set up with the old one.
- **Local only.** The connection is a socket in your data folder that only your Mac account can open. Nothing listens on the network.
- **Same kernel, same rules.** Requests from other apps go through the exact checks, approvals and records as Neural's own. If you decline, the other app is told not to try another way.

## How it works

`uab-mcp` is a small MCP server that the other app starts. It connects to the kernel inside the running Neural app, lists the kernel's capabilities as MCP tools, and turns each tool call into a **proposal**: the kernel validates it, applies your policy, asks you if needed, runs it, verifies it and records it.
