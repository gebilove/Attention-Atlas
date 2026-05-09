const endpoint = process.argv[2] || "http://127.0.0.1:9224/json/list";
const targets = await (await fetch(endpoint)).json();
const workerTarget = targets.find((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"));

if (!workerTarget) {
  throw new Error("Extension service worker was not found.");
}

const ws = new WebSocket(workerTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let messageId = 0;
const pending = new Map();

ws.addEventListener("message", (event) => {
  const payload = JSON.parse(event.data);
  if (!payload.id || !pending.has(payload.id)) return;
  const { resolve, reject } = pending.get(payload.id);
  pending.delete(payload.id);
  if (payload.error) reject(new Error(JSON.stringify(payload.error)));
  else resolve(payload.result);
});

function cdp(method, params = {}) {
  const id = ++messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await cdp("Runtime.enable");
const result = await cdp("Runtime.evaluate", {
  expression: `(() => ({
    id: chrome.runtime.id,
    manifest: chrome.runtime.getManifest()
  }))()`,
  returnByValue: true
});

console.log(JSON.stringify(result.result.value, null, 2));
ws.close();
