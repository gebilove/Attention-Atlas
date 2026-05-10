const DEFAULT_LLM_SETTINGS = {
  enabled: true,
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
  anthropicVersion: "2023-06-01",
  temperature: 0.2,
  maxTokens: 4096,
  globalPrompt: ""
};

const PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyPlaceholder: "sk-...；本地兼容服务可留空"
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-latest",
    apiKeyPlaceholder: "sk-ant-..."
  }
};

const PROMPT_LIBRARY_KEY = "slnPromptLibrary";

const controls = {
  provider: document.querySelector("#provider"),
  baseUrl: document.querySelector("#baseUrl"),
  model: document.querySelector("#model"),
  modelOptions: document.querySelector("#modelOptions"),
  modelStatus: document.querySelector("#modelStatus"),
  refreshModels: document.querySelector("#refreshModels"),
  apiKey: document.querySelector("#apiKey"),
  temperature: document.querySelector("#temperature"),
  maxTokens: document.querySelector("#maxTokens"),
  globalPrompt: document.querySelector("#globalPrompt"),
  save: document.querySelector("#save"),
  test: document.querySelector("#test"),
  testStatus: document.querySelector("#testStatus"),
  promptList: document.querySelector("#promptList"),
  status: document.querySelector("#status")
};

chrome.storage.local.get({ slnLlmSettings: DEFAULT_LLM_SETTINGS }, (items) => {
  const settings = normalizeSettings(items.slnLlmSettings);
  controls.provider.value = settings.provider;
  controls.baseUrl.value = settings.baseUrl;
  controls.model.value = settings.model;
  controls.apiKey.value = settings.apiKey;
  controls.temperature.value = settings.temperature;
  controls.maxTokens.value = settings.maxTokens;
  controls.globalPrompt.value = settings.globalPrompt;
  updateProviderHints(settings.provider);
});

controls.provider.addEventListener("change", () => {
  const provider = controls.provider.value;
  const previousProvider = provider === "openai" ? "anthropic" : "openai";
  const currentBase = controls.baseUrl.value.trim();
  if (!currentBase || currentBase === PROVIDERS[previousProvider].baseUrl) {
    controls.baseUrl.value = PROVIDERS[provider].baseUrl;
  }
  if (!controls.model.value.trim() || controls.model.value.trim() === PROVIDERS[previousProvider].model) {
    controls.model.value = PROVIDERS[provider].model;
  }
  updateProviderHints(provider);
});
controls.save.addEventListener("click", saveSettings);
controls.promptList.addEventListener("click", handlePromptManagerClick);
controls.refreshModels.addEventListener("click", refreshModelList);
controls.baseUrl.addEventListener("change", () => clearModelList());
controls.provider.addEventListener("change", () => clearModelList());
controls.test.addEventListener("click", async () => {
  saveSettings("testing");
  setButtonBusy(controls.test, true, "测试中");
  setTestStatus("正在测试连接...", "");
  chrome.runtime.sendMessage({ type: "SLN_TEST_LLM" }, (response) => {
    setButtonBusy(controls.test, false);
    if (chrome.runtime.lastError) {
      setTestStatus(chrome.runtime.lastError.message, "error");
      return;
    }
    if (response?.ok) {
      setTestStatus(`连接成功：${response.model || "model ok"}`, "ok");
    } else {
      setTestStatus(response?.error || "连接失败", "error");
    }
  });
});

renderPromptManager();

function saveSettings(reason = "manual") {
  const settings = {
    enabled: true,
    provider: controls.provider.value,
    baseUrl: controls.baseUrl.value.trim(),
    model: controls.model.value.trim(),
    apiKey: controls.apiKey.value.trim(),
    anthropicVersion: DEFAULT_LLM_SETTINGS.anthropicVersion,
    temperature: Number(controls.temperature.value),
    maxTokens: Number(controls.maxTokens.value),
    globalPrompt: controls.globalPrompt.value.trim()
  };

  chrome.storage.local.set({ slnLlmSettings: settings }, () => {
    if (reason !== "testing") setStatus("已保存", "ok");
  });
}

function setStatus(message, kind) {
  controls.status.innerHTML = kind === "" && message ? `${escapeHtml(message)}<span aria-hidden="true"></span>` : escapeHtml(message);
  controls.status.dataset.kind = kind;
}

function setTestStatus(message, kind) {
  controls.testStatus.innerHTML = kind === "" && message ? `${escapeHtml(message)}<span aria-hidden="true"></span>` : escapeHtml(message);
  controls.testStatus.dataset.kind = kind;
}

function setButtonBusy(button, busy, label = "") {
  if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
  button.disabled = busy;
  if (busy) {
    button.innerHTML = `<span class="button-busy"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;
    return;
  }
  button.textContent = button.dataset.idleText;
}

function normalizeSettings(rawSettings = {}) {
  const provider = rawSettings.provider || (rawSettings.apiFormat === "messages" ? "anthropic" : "openai");
  const normalizedProvider = provider === "anthropic" ? "anthropic" : "openai";
  const defaults = PROVIDERS[normalizedProvider];
  const baseUrl = rawSettings.baseUrl || deriveBaseUrlFromEndpoint(rawSettings.endpoint) || defaults.baseUrl;
  return {
    ...DEFAULT_LLM_SETTINGS,
    ...rawSettings,
    enabled: true,
    provider: normalizedProvider,
    baseUrl,
    model: rawSettings.model || defaults.model
  };
}

function deriveBaseUrlFromEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== "string") return "";
  return endpoint
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/messages$/i, "");
}

function updateProviderHints(provider) {
  const defaults = PROVIDERS[provider] || PROVIDERS.openai;
  controls.baseUrl.placeholder = defaults.baseUrl;
  controls.model.placeholder = defaults.model;
  controls.apiKey.placeholder = defaults.apiKeyPlaceholder;
}

async function refreshModelList() {
  const provider = controls.provider.value === "anthropic" ? "anthropic" : "openai";
  const baseUrl = controls.baseUrl.value.trim();
  const apiKey = controls.apiKey.value.trim();
  if (!baseUrl) {
    setModelStatus("请先填写 Base URL", "error");
    return;
  }
  setButtonBusy(controls.refreshModels, true, "获取中");
  setModelStatus("正在从 Base URL 获取模型列表...", "");
  try {
    const models = await fetchModelList({ provider, baseUrl, apiKey });
    renderModelOptions(models);
    if (models.length === 0) {
      setModelStatus("接口返回 0 个模型", "error");
    } else {
      setModelStatus(`已获取 ${models.length} 个模型，点击输入框可选择`, "ok");
    }
  } catch (error) {
    renderModelOptions([]);
    setModelStatus(error.message || "获取模型列表失败", "error");
  } finally {
    setButtonBusy(controls.refreshModels, false);
  }
}

async function fetchModelList({ provider, baseUrl, apiKey }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers = { "Content-Type": "application/json" };
  if (provider === "anthropic") {
    if (!apiKey) throw new Error("Anthropic 接口需要 API Key 才能列出模型");
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = DEFAULT_LLM_SETTINGS.anthropicVersion;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, { method: "GET", headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}: ${text.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids = data
    .map((item) => (typeof item === "string" ? item : item?.id || item?.name))
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim());
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

function renderModelOptions(models) {
  controls.modelOptions.innerHTML = models
    .map((id) => `<option value="${escapeAttribute(id)}"></option>`)
    .join("");
}

function clearModelList() {
  controls.modelOptions.innerHTML = "";
  setModelStatus("", "");
}

function setModelStatus(message, kind) {
  controls.modelStatus.textContent = message;
  controls.modelStatus.dataset.kind = kind;
}

async function renderPromptManager() {
  const library = await loadPromptLibrary();
  if (library.prompts.length === 0) {
    controls.promptList.innerHTML = `<div class="prompt-empty">还没有网站提示词。进入没有提示词的网站后，可以在页面弹窗或 popup 中自动生成。</div>`;
    return;
  }

  controls.promptList.innerHTML = library.prompts.map((prompt) => `
    <article class="prompt-card" data-prompt-id="${escapeAttribute(prompt.id)}">
      <h3>${escapeHtml(prompt.name || makePromptName(prompt.text || ""))}</h3>
      <label>提示词名称</label>
      <input class="prompt-name" type="text" value="${escapeAttribute(prompt.name || "")}">
      <label>提示词内容</label>
      <textarea class="prompt-text">${escapeHtml(prompt.text || "")}</textarea>
      <label>关联网站</label>
      <textarea class="sites" placeholder="每行一个网站 origin">${escapeHtml((prompt.sites || []).join("\n"))}</textarea>
      <div class="prompt-actions">
        <button class="secondary" type="button" data-prompt-action="save">保存提示词</button>
        <button class="danger" type="button" data-prompt-action="delete">删除</button>
      </div>
    </article>
  `).join("");
}

async function handlePromptManagerClick(event) {
  const action = event.target?.dataset?.promptAction;
  if (!action) return;
  const card = event.target.closest("[data-prompt-id]");
  const promptId = card?.dataset.promptId;
  if (!promptId) return;

  const library = await loadPromptLibrary();
  const index = library.prompts.findIndex((prompt) => prompt.id === promptId);
  if (index === -1) return;

  if (action === "delete") {
    library.prompts.splice(index, 1);
    await savePromptLibrary(library);
    renderPromptManager();
    return;
  }

  const prompt = library.prompts[index];
  const text = card.querySelector(".prompt-text").value.trim();
  prompt.name = card.querySelector(".prompt-name").value.trim() || makePromptName(text);
  prompt.text = text;
  prompt.sites = parseSites(card.querySelector(".sites").value);
  prompt.updatedAt = Date.now();
  await savePromptLibrary(library);
  renderPromptManager();
}

async function loadPromptLibrary() {
  const items = await chrome.storage.local.get({ [PROMPT_LIBRARY_KEY]: { version: 1, prompts: [] } });
  const library = items[PROMPT_LIBRARY_KEY] || { version: 1, prompts: [] };
  return {
    version: 1,
    prompts: Array.isArray(library.prompts) ? library.prompts : []
  };
}

function savePromptLibrary(library) {
  return chrome.storage.local.set({ [PROMPT_LIBRARY_KEY]: library });
}

function parseSites(value) {
  return uniqueValues(String(value || "")
    .split(/[\n,，]+/)
    .map((site) => normalizeSite(site))
    .filter(Boolean));
}

function normalizeSite(site) {
  const trimmed = site.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    try {
      return new URL(`https://${trimmed}`).origin;
    } catch {
      return "";
    }
  }
}

function makePromptName(text) {
  const firstLine = String(text || "").split(/\n+/).map((line) => line.trim()).find(Boolean) || "未命名提示词";
  return firstLine.replace(/[。.!?？]$/, "").slice(0, 28);
}

function uniqueValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
