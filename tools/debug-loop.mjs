import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const DEFAULT_URL = "https://hrl.boyuai.com/chapter/1/%E5%8A%A8%E6%80%81%E8%A7%84%E5%88%92%E7%AE%97%E6%B3%95/";
const DEFAULT_PORT = 0;
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_FOR_TESTING_PATH = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const options = parseArgs(process.argv.slice(2));
const port = Number(options.port || process.env.SLN_DEBUG_PORT || chooseDefaultPort());
const targetUrl = options.url || process.env.SLN_DEBUG_URL || DEFAULT_URL;
const chromePath = options.chrome || process.env.CHROME_PATH || preferredChromePath();
const profileDir = options.profile || process.env.SLN_DEBUG_PROFILE || `/private/tmp/sln-debug-profile-${port}`;
const endpoint = `http://127.0.0.1:${port}/json/list`;
const shouldLaunch = !options["no-launch"];
const keepOpen = Boolean(options["keep-open"]);
const clickSelectors = normalizeList(options.click);

const results = [];
let chromeProcess = null;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` - ${detail}` : ""}`);
}

main();

async function main() {
  try {
    await runStaticChecks();
    if (shouldLaunch) await launchChrome();
    await waitForDebugger(endpoint, 20000);
    await verifyPage(endpoint, targetUrl);
    await verifyExtension(endpoint);
    printSummary();
  } catch (error) {
    console.error(`\nDebug loop failed: ${error.message}`);
    printSummary();
    process.exitCode = 1;
  } finally {
    if (chromeProcess && !keepOpen) {
      chromeProcess.kill();
    }
  }
}

async function runStaticChecks() {
  const manifestPath = join(projectRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) throw new Error("manifest.json must be MV3.");
  if (!manifest.background?.service_worker) throw new Error("manifest.json is missing background.service_worker.");
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    throw new Error("manifest.json is missing content_scripts.");
  }
  record("manifest validation", true, `${manifest.name} ${manifest.version}`);

  const jsFiles = await listFiles(projectRoot, ".js", ".mjs");
  for (const file of jsFiles) {
    if (file.includes(`${join(projectRoot, "dist")}/`)) continue;
    await runNodeCheck(file);
  }
  record("JavaScript syntax", true, `${jsFiles.filter((file) => !file.includes(`${join(projectRoot, "dist")}/`)).length} files`);
}

function runNodeCheck(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Syntax check failed for ${relative(file)}\n${stderr.trim()}`));
    });
  });
}

async function launchChrome() {
  await mkdir(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${projectRoot}`,
    `--disable-extensions-except=${projectRoot}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--new-window",
    targetUrl
  ];

  chromeProcess = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", options.verbose ? "pipe" : "ignore"],
    detached: keepOpen
  });

  chromeProcess.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(text);
  });

  chromeProcess.on("exit", (code) => {
    if (code !== null && code !== 0 && !process.exitCode) {
      console.error(`Chrome exited with code ${code}.`);
    }
  });
  if (keepOpen) chromeProcess.unref();

  record("Chrome launch", true, `${chromePath}, port ${port}`);
}

async function waitForDebugger(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await fetchJson(url);
      if (Array.isArray(targets)) {
        record("CDP endpoint", true, url);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`CDP endpoint was not ready: ${lastError?.message || url}`);
}

async function verifyExtension(url) {
  const workerTarget = await waitForTarget(url, (target) =>
    target.type === "service_worker" && target.url.startsWith("chrome-extension://"), 10000
  );
  if (!workerTarget) throw new Error("Extension service worker target was not found.");

  const client = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => ({
        id: chrome.runtime.id,
        manifest: chrome.runtime.getManifest()
      }))()`,
      returnByValue: true
    });
    const value = result.result.value;
    if (!value?.id) throw new Error("Could not read chrome.runtime.id from service worker.");
    record("extension service worker", true, `${value.manifest.name} (${value.id})`);
  } finally {
    client.close();
  }
}

async function waitForTarget(url, predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchJson(url);
    const target = targets.find(predicate);
    if (target) return target;
    await delay(500);
  }
  return null;
}

async function verifyPage(url, expectedUrl) {
  let targets = await fetchJson(url);
  let pageTarget = findTargetPage(targets, expectedUrl);
  if (!pageTarget) {
    await createPageTarget(url, expectedUrl);
    pageTarget = await waitForTarget(url, (target) => {
      if (target.type !== "page") return false;
      return isExpectedPage(target.url, expectedUrl);
    }, 10000);
    targets = await fetchJson(url);
  }
  if (!pageTarget) throw new Error(`Target page was not found for ${expectedUrl}.`);

  const client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  const runtimeErrors = [];
  const logEntries = [];

  client.onMessage((payload) => {
    if (payload.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(payload.params.exceptionDetails.text || payload.params.exceptionDetails.exception?.description);
    }
    if (payload.method === "Log.entryAdded") {
      logEntries.push(payload.params.entry);
    }
  });

  try {
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Page.enable");
    await client.send("Page.reload", { ignoreCache: true });
    await delay(Number(options["reload-wait"] || 3500));

    let result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const sidebar = document.querySelector("#sln-sidebar");
        const promptStart = document.querySelector("#sln-prompt-start");
        const blocks = [...document.querySelectorAll(".sln-block")];
        const cards = [...document.querySelectorAll(".sln-card")];
        const scripts = performance.getEntriesByType("resource")
          .filter((entry) => entry.name.includes("content.js"))
          .map((entry) => entry.name);
        return {
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          hasSidebar: Boolean(sidebar),
          hasPromptStart: Boolean(promptStart),
          blockCount: blocks.length,
          cardCount: cards.length,
          sidebarText: sidebar ? sidebar.innerText.slice(0, 300) : "",
          promptText: promptStart ? promptStart.innerText.slice(0, 300) : "",
          contentScriptResources: scripts
        };
      })()`,
      returnByValue: true
    });

    let value = result.result.value;
    if (value.readyState !== "complete") throw new Error(`Page did not finish loading: ${value.readyState}`);
    if (!value.hasSidebar && !value.hasPromptStart && value.blockCount === 0) {
      const browserInfo = await getBrowserInfo(url);
      throw new Error([
        "Content script did not render sidebar, prompt dialog, or analyzed blocks.",
        `Page: ${value.title} ${value.url}`,
        `content.js resources: ${value.contentScriptResources.join(", ") || "none"}`,
        `runtime errors: ${runtimeErrors.join(" | ") || "none"}`,
        `log entries: ${logEntries.map((entry) => `${entry.level}:${entry.text}`).join(" | ") || "none"}`,
        chromeLoadExtensionHint(browserInfo)
      ].join("\n"));
    }

    const selectors = clickSelectors.length > 0
      ? clickSelectors
      : value.hasPromptStart
        ? ["#sln-prompt-start [data-sln-prompt-generate]"]
        : [];

    for (const selector of selectors) {
      await clickSelector(client, selector);
      await delay(Number(options["click-wait"] || 2500));
      record("page click", true, selector);
    }

    if (selectors.length > 0) {
      result = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const sidebar = document.querySelector("#sln-sidebar");
          const promptStart = document.querySelector("#sln-prompt-start");
          const blocks = [...document.querySelectorAll(".sln-block")];
          const cards = [...document.querySelectorAll(".sln-card")];
          return {
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            hasSidebar: Boolean(sidebar),
            hasPromptStart: Boolean(promptStart),
            blockCount: blocks.length,
            cardCount: cards.length,
            sidebarText: sidebar ? sidebar.innerText.slice(0, 300) : "",
            promptText: promptStart ? promptStart.innerText.slice(0, 300) : ""
          };
        })()`,
        returnByValue: true
      });
      value = result.result.value;
      if (clickSelectors.length === 0 && !value.hasSidebar) {
        throw new Error("Default prompt-start click did not produce a sidebar or analysis error panel.");
      }
    }

    if (runtimeErrors.length > 0) throw new Error(`Runtime exceptions: ${runtimeErrors.join(" | ")}`);

    const severeLogs = logEntries.filter((entry) => ["error", "warning"].includes(entry.level));
    record("page content script", true, summarizePageState(value));
    if (severeLogs.length > 0) {
      record("browser log scan", false, `${severeLogs.length} warning/error entries`);
    } else {
      record("browser log scan", true, "no warning/error entries");
    }
  } finally {
    client.close();
  }
}

async function clickSelector(client, selector) {
  const rectResult = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        disabled: Boolean(element.disabled),
        text: element.innerText || element.value || element.getAttribute("aria-label") || ""
      };
    })()`,
    returnByValue: true
  });
  const rect = rectResult.result.value;
  if (!rect) throw new Error(`Click target was not found: ${selector}`);
  if (rect.disabled) throw new Error(`Click target is disabled: ${selector}`);
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`Click target is not visible: ${selector}`);

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y,
    button: "none"
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1
  });
}

function summarizePageState(value) {
  if (value.hasSidebar) return `sidebar rendered, ${value.blockCount} blocks, ${value.cardCount} cards`;
  if (value.hasPromptStart) return "prompt-start dialog rendered";
  return `${value.blockCount} blocks rendered`;
}

function findTargetPage(targets, expectedUrl) {
  return targets.find((target) => target.type === "page" && isExpectedPage(target.url, expectedUrl));
}

function isExpectedPage(actualUrl, expectedUrl) {
  if (actualUrl === expectedUrl) return true;
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return actual.host === expected.host && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

async function createPageTarget(listEndpoint, pageUrl) {
  const createEndpoint = listEndpoint.replace(/\/json\/list$/, `/json/new?${encodeURIComponent(pageUrl)}`);
  const response = await fetch(createEndpoint, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Could not create page target: ${response.status} ${await response.text()}`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function getBrowserInfo(listEndpoint) {
  try {
    return await fetchJson(listEndpoint.replace(/\/json\/list$/, "/json/version"));
  } catch {
    return {};
  }
}

function chromeLoadExtensionHint(browserInfo) {
  const browser = String(browserInfo.Browser || "");
  const match = browser.match(/^Chrome\/(\d+)/);
  const major = match ? Number(match[1]) : 0;
  if (major >= 137) {
    return [
      "Detected official Chrome >= 137. Official Chrome branded builds no longer load unpacked extensions from --load-extension.",
      "Use Chrome for Testing or Chromium, then pass --chrome /path/to/browser, or set CHROME_PATH."
    ].join("\n");
  }
  return "If this is official Chrome, try Chrome for Testing or Chromium when --load-extension is ignored.";
}

async function listFiles(root, ...extensions) {
  const entries = await readdir(root);
  const files = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const fullPath = join(root, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      files.push(...await listFiles(fullPath, ...extensions));
    } else if (extensions.includes(extname(fullPath))) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      setOption(parsed, key, true);
    } else {
      setOption(parsed, key, next);
      index += 1;
    }
  }
  return parsed;
}

function chooseDefaultPort() {
  return 9300 + Math.floor(Math.random() * 400);
}

function preferredChromePath() {
  if (existsSync(CHROME_FOR_TESTING_PATH)) return CHROME_FOR_TESTING_PATH;
  return DEFAULT_CHROME_PATH;
}

function setOption(parsed, key, value) {
  if (parsed[key] === undefined) {
    parsed[key] = value;
  } else if (Array.isArray(parsed[key])) {
    parsed[key].push(value);
  } else {
    parsed[key] = [parsed[key], value];
  }
}

function normalizeList(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function printSummary() {
  const failed = results.filter((result) => !result.ok);
  console.log(`\nDebug loop summary: ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    failed.forEach((result) => console.log(`- ${result.name}: ${result.detail}`));
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function relative(file) {
  return file.replace(`${projectRoot}/`, "");
}

class CdpClient {
  static async connect(webSocketUrl) {
    const ws = new WebSocket(webSocketUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      ws.addEventListener("open", resolvePromise, { once: true });
      ws.addEventListener("error", rejectPromise, { once: true });
    });
    return new CdpClient(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.messageId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
  }

  onMessage(listener) {
    this.listeners.push(listener);
  }

  handleMessage(event) {
    const payload = JSON.parse(event.data);
    this.listeners.forEach((listener) => listener(payload));
    if (!payload.id || !this.pending.has(payload.id)) return;
    const { resolve: resolvePromise, reject: rejectPromise } = this.pending.get(payload.id);
    this.pending.delete(payload.id);
    if (payload.error) rejectPromise(new Error(JSON.stringify(payload.error)));
    else resolvePromise(payload.result);
  }

  send(method, params = {}) {
    const id = ++this.messageId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
  }

  close() {
    this.ws.close();
  }
}
