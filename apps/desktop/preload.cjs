// The window can only call these channels. It never sees the kernel process,
// the model's API key or the services directly.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
  "hello", "ask", "stop", "conversation.new",
  "approvals.pending", "approvals.resolve",
  "capabilities", "policy.get", "policy.set", "roots.add", "roots.remove",
  "audit", "audit.verify", "tasks",
  "services", "services.reload", "services.edit",
  "gmail.status", "gmail.configure", "gmail.connect", "gmail.disconnect", "gmail.guide",
  "chatgpt.status", "chatgpt.connect", "chatgpt.disconnect", "chatgpt.models",
  "browser.open", "browser.go", "browser.back", "browser.forward", "browser.reload",
  "browser.external", "browser.close", "browser.bounds", "browser.state",
  "settings.get", "settings.set", "key.set", "key.has", "local.models", "cloud.models", "builtin.status",
  "reveal", "openHome",
]);

contextBridge.exposeInMainWorld("uab", {
  call(channel, ...args) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(listener) {
    const fn = (_e, msg) => listener(msg.channel, msg.payload);
    ipcRenderer.on("uab:event", fn);
    return () => ipcRenderer.removeListener("uab:event", fn);
  },
});
