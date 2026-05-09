const endpoint = process.argv[2] || "http://127.0.0.1:9224/json/list";
const shouldReload = process.argv.includes("--reload");
const targets = await (await fetch(endpoint)).json();
const pageTarget = targets.find((target) => target.type === "page" && target.url.includes("hrl.boyuai.com"));

if (!pageTarget) {
  throw new Error("Target page was not found.");
}

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let messageId = 0;
const pending = new Map();
const runtimeErrors = [];
const logEntries = [];

ws.addEventListener("message", (event) => {
  const payload = JSON.parse(event.data);
  if (payload.method === "Runtime.exceptionThrown") {
    runtimeErrors.push(payload.params.exceptionDetails.text || payload.params.exceptionDetails.exception?.description);
  }
  if (payload.method === "Log.entryAdded") {
    logEntries.push(payload.params.entry);
  }
  if (!payload.id || !pending.has(payload.id)) return;
  const { resolve, reject } = pending.get(payload.id);
  pending.delete(payload.id);
  if (payload.error) {
    reject(new Error(JSON.stringify(payload.error)));
  } else {
    resolve(payload.result);
  }
});

function cdp(method, params = {}) {
  const id = ++messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

await cdp("Runtime.enable");
await cdp("Log.enable");

if (shouldReload) {
  await cdp("Page.enable");
  await cdp("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

const result = await cdp("Runtime.evaluate", {
  expression: `(() => {
    const blocks = [...document.querySelectorAll('.sln-block')];
    const counts = blocks.reduce((acc, el) => {
      const key = el.getAttribute('data-sln-importance') || 'missing';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const sidebar = document.querySelector('#sln-sidebar');
    const firstCards = [...document.querySelectorAll('.sln-card')].slice(0, 5).map((el) => el.innerText);
    return {
      title: document.title,
      url: location.href,
      hasSidebar: Boolean(sidebar),
      sidebarText: sidebar ? sidebar.innerText.slice(0, 700) : null,
      blockCount: blocks.length,
      counts,
      firstCards,
      collapsedCount: document.querySelectorAll('.sln-collapsed').length,
      badgeCount: document.querySelectorAll('.sln-badge').length,
      scriptResources: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('content.js')).map((entry) => entry.name)
    };
  })()`,
  returnByValue: true
});

console.log(JSON.stringify({
  ...result.result.value,
  runtimeErrors,
  logEntries: logEntries.map((entry) => ({
    level: entry.level,
    source: entry.source,
    text: entry.text,
    url: entry.url
  }))
}, null, 2));
ws.close();
