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

## How it stays safe

- **Off by default.** Nothing can connect until you switch it on.
- **Pairing key.** Only apps whose config contains the key can connect. **New pairing key** in Settings cuts off every app set up with the old one.
- **Local only.** The connection is a socket in your data folder that only your Mac account can open. Nothing listens on the network.
- **Same kernel, same rules.** Requests from other apps go through the exact checks, approvals and records as Neural's own. If you decline, the other app is told not to try another way.

## How it works

`uab-mcp` is a small MCP server that the other app starts. It connects to the kernel inside the running Neural app, lists the kernel's capabilities as MCP tools, and turns each tool call into a **proposal**: the kernel validates it, applies your policy, asks you if needed, runs it, verifies it and records it.
