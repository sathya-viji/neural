# Build a connector

A **connector** lets Neural (and any app that speaks MCP) use your service: a todo app, a shop, a bank, a smart home. It's an ordinary **MCP server**. The extra Neural asks for is that each tool says **what it does**, so the trusted kernel knows when to ask the user and what to say on the approval card.

You can build one in an afternoon with `@uab/connector-kit`.

## 1. Describe your tools

```js
import { defineConnector } from "@uab/connector-kit";

const shop = defineConnector({
  name: "corner-shop",
  version: "1.0.0",
  tools: [
    {
      name: "search_products",
      title: "Search products",
      description: "Find products by name or category. Returns names, prices and ids.",
      input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      effects: ["read"],                       // only looks: runs without asking
      async run({ query }) { return await api.search(query); },
    },
    {
      name: "place_order",
      title: "Place an order",
      description: "Order products by id for delivery to the user's saved address.",
      input: {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } }, total: { type: "string" } },
        required: ["items", "total"],
      },
      effects: ["spend", "send"],              // costs money: the kernel always asks
      summary: "Order {items} for {total}",    // the approval card, filled from the real arguments
      async run({ items }) { const o = await api.order(items); return { text: `Order ${o.id} placed.`, data: o }; },
    },
  ],
});

await shop.serveStdio();                 // a program Neural runs on the user's computer
// or: await shop.serveHttp({ port: 4100 })   an online service at http://127.0.0.1:4100/mcp
```

A full working example is in [`examples/notes-connector`](../examples/notes-connector/index.mjs).

### Effects

| Effect | Means | What the kernel does by default |
|---|---|---|
| `read` | Looks at data, changes nothing | Runs straight away |
| `write` | Creates or changes the user's own data | Asks first |
| `delete` | Removes data | Asks first |
| `send` | Communicates with someone else | Asks first |
| `spend` | Costs money | **Always** asks, even if the user set it to Allow |
| `device` | Acts on a physical device or the local system | Runs, unless the user changes it |

You can add `risk: "low" | "medium" | "high"`, but it can only go **up**: the kernel never treats sending or deleting as lower than medium, or spending as lower than high. Users can still change any tool under Permissions.

### The approval card

`summary` is a sentence with `{argument}` placeholders. The **kernel** fills it in from the real arguments, never from the AI's description, so the user sees exactly what will happen: *"Corner Shop: Order 2 items for ₹640"*. Use nested values with dots (`{to.name}`). Lists of objects show as "N items".

## 2. Check it

```bash
npx uab-check -- node my-connector.js
npx uab-check --url http://127.0.0.1:4100/mcp
```

The check connects to your connector and fails if, for example:
- a tool has no description, or its input isn't a JSON Schema object
- it claims to only read (`readOnlyHint`) but declares other effects
- it deletes but says it isn't destructive
- the card summary uses an argument that doesn't exist

It warns when a tool has no labels at all (the kernel will then treat it as high risk and always ask), or when an action that changes things has no card summary.

## 3. Use it in Neural

- **A program:** Services → Add a service → *Run a program on this Mac instead*: `node /path/to/my-connector.js`.
- **Online:** Services → Add a service → paste the address. Put it behind HTTPS. If it needs an account, use standard MCP sign-in (OAuth); Neural shows a **Sign in** button and the kernel keeps the tokens.

## Using another language

Any MCP server works. To get Neural's exact labels, add these to each tool's `_meta`:

```json
{
  "_meta": {
    "ai.unifiedaibase/effects": ["spend", "send"],
    "ai.unifiedaibase/risk": "high",
    "ai.unifiedaibase/summary": "Order {items} for {total}"
  },
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true }
}
```

Without `_meta` labels, Neural falls back to MCP's standard hints: tools not marked `readOnlyHint` are treated as changing things and ask first.
