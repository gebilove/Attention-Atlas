const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "learning",
  stage: "beginner",
  collapseC: true,
  showSidebar: true
};

const PROMPT_LIBRARY_KEY = "slnPromptLibrary";

let promptLibrary = { version: 1, prompts: [] };
let currentSite = "";
let currentPromptId = "";

const controls = {
  enabled: document.querySelector("#enabled"),
  mode: Array.from(document.querySelectorAll("input[name='mode']")),
  stage: document.querySelector("#stage"),
  collapseC: document.querySelector("#collapseC"),
  showSidebar: document.querySelector("#showSidebar"),
  promptSelect: document.querySelector("#promptSelect"),
  pagePrompt: document.querySelector("#pagePrompt"),
  generatePrompt: document.querySelector("#generatePrompt"),
  pastePrompt: document.querySelector("#pastePrompt"),
  llmSettings: document.querySelector("#llmSettings"),
  reanalyze: document.querySelector("#reanalyze")
};

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  controls.enabled.checked = settings.enabled;
  controls.mode.find((control) => control.value === settings.mode).checked = true;
  controls.stage.value = settings.stage;
  controls.collapseC.checked = settings.collapseC;
  controls.showSidebar.checked = settings.showSidebar;
  syncModeUi(settings.mode);
  loadPromptForCurrentSite();
});

["enabled", "stage", "collapseC", "showSidebar"].forEach((key) => {
  controls[key].addEventListener("change", saveAndNotify);
});

controls.promptSelect.addEventListener("change", assignSelectedPrompt);
controls.pagePrompt.addEventListener("change", savePagePromptAndNotify);
controls.pagePrompt.addEventListener("paste", () => {
  window.setTimeout(savePagePromptAndNotify, 0);
});
controls.generatePrompt.addEventListener("click", generatePagePrompt);
controls.pastePrompt.addEventListener("click", pastePagePrompt);

controls.mode.forEach((control) => {
  control.addEventListener("change", () => {
    syncModeUi(currentMode());
    saveAndNotify();
  });
});

controls.reanalyze.addEventListener("click", () => saveAndNotify({ forceRefresh: true }));
controls.llmSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());

function saveAndNotify(options = {}) {
  const settings = {
    enabled: controls.enabled.checked,
    mode: currentMode(),
    stage: controls.stage.value,
    domain: "auto",
    collapseC: controls.collapseC.checked,
    showSidebar: controls.showSidebar.checked
  };

  chrome.storage.sync.set(settings, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, {
        type: "SLN_SETTINGS_UPDATED",
        settings,
        forceRefresh: Boolean(options.forceRefresh)
      });
    });
  });
}

async function savePagePromptAndNotify() {
  if (!currentSite) return;
  const text = controls.pagePrompt.value.trim();
  if (!text) {
    await unassignCurrentSite();
    saveAndNotify({ forceRefresh: true });
    return;
  }

  if (currentPromptId) {
    const prompt = promptLibrary.prompts.find((item) => item.id === currentPromptId);
    if (prompt) {
      prompt.text = text;
      prompt.name = prompt.name || makePromptName(text);
      prompt.sites = uniqueValues([...(prompt.sites || []), currentSite]);
      prompt.updatedAt = Date.now();
    }
  } else {
    const prompt = makePromptRecord(text, currentSite);
    promptLibrary.prompts.unshift(prompt);
    currentPromptId = prompt.id;
  }

  await savePromptLibrary(promptLibrary);
  renderPromptSelect();
  saveAndNotify({ forceRefresh: true });
}

async function assignSelectedPrompt() {
  const selected = controls.promptSelect.value;
  if (selected === "__new__") {
    await unassignCurrentSite();
    controls.pagePrompt.value = "";
    controls.pagePrompt.focus();
    saveAndNotify({ forceRefresh: true });
    return;
  }

  const prompt = promptLibrary.prompts.find((item) => item.id === selected);
  if (!prompt || !currentSite) return;
  await unassignCurrentSite(false);
  prompt.sites = uniqueValues([...(prompt.sites || []), currentSite]);
  prompt.updatedAt = Date.now();
  currentPromptId = prompt.id;
  controls.pagePrompt.value = prompt.text || "";
  await savePromptLibrary(promptLibrary);
  renderPromptSelect();
  saveAndNotify({ forceRefresh: true });
}

function currentMode() {
  return controls.mode.find((control) => control.checked)?.value || "learning";
}

function syncModeUi(mode) {
  const isSurfing = mode === "surfing";
  controls.stage.closest(".section").hidden = isSurfing;
  controls.collapseC.closest("label").querySelector("span").textContent = isSurfing ? "低价值内容弱化" : "C 级内容自动折叠";
  controls.reanalyze.textContent = isSurfing ? "定位当前页重点" : "分析当前页";
}

async function loadPromptForCurrentSite() {
  chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
    currentSite = siteKey(tab?.url || "");
    promptLibrary = await loadPromptLibrary();
    currentPromptId = "";

    const assigned = promptLibrary.prompts.find((prompt) => (prompt.sites || []).includes(currentSite));
    if (assigned) {
      currentPromptId = assigned.id;
      controls.pagePrompt.value = assigned.text || "";
    } else {
      controls.pagePrompt.value = "";
      const legacyPrompt = await loadLegacyPagePrompt(tab?.url || "");
      if (legacyPrompt) {
        const prompt = makePromptRecord(legacyPrompt, currentSite);
        promptLibrary.prompts.unshift(prompt);
        currentPromptId = prompt.id;
        controls.pagePrompt.value = prompt.text;
        await savePromptLibrary(promptLibrary);
      }
    }

    renderPromptSelect();
  });
}

async function pastePagePrompt() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const start = controls.pagePrompt.selectionStart ?? controls.pagePrompt.value.length;
    const end = controls.pagePrompt.selectionEnd ?? controls.pagePrompt.value.length;
    controls.pagePrompt.value = `${controls.pagePrompt.value.slice(0, start)}${text}${controls.pagePrompt.value.slice(end)}`;
    controls.pagePrompt.focus();
    const cursor = start + text.length;
    controls.pagePrompt.setSelectionRange(cursor, cursor);
    savePagePromptAndNotify();
  } catch {
    controls.pagePrompt.focus();
  }
}

function generatePagePrompt() {
  controls.generatePrompt.disabled = true;
  const originalText = controls.generatePrompt.textContent;
  controls.generatePrompt.textContent = "生成中";

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) {
      restoreGenerateButton(originalText);
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      type: "SLN_GENERATE_PAGE_PROMPT",
      payload: {
        mode: currentMode(),
        stage: controls.stage.value
      }
    }, async (response) => {
      restoreGenerateButton(originalText);
      if (chrome.runtime.lastError || !response?.ok || !response.prompt) {
        controls.pagePrompt.focus();
        return;
      }
      controls.pagePrompt.value = response.prompt;
      await savePagePromptAndNotify();
    });
  });
}

function restoreGenerateButton(text) {
  controls.generatePrompt.disabled = false;
  controls.generatePrompt.textContent = text;
}

function renderPromptSelect() {
  const options = [
    `<option value="__new__"${currentPromptId ? "" : " selected"}>新建当前网站提示词</option>`
  ];
  promptLibrary.prompts.forEach((prompt) => {
    const siteCount = (prompt.sites || []).length;
    const label = `${escapeHtml(prompt.name || makePromptName(prompt.text || ""))} (${siteCount} 个网站)`;
    options.push(`<option value="${escapeAttribute(prompt.id)}"${prompt.id === currentPromptId ? " selected" : ""}>${label}</option>`);
  });
  controls.promptSelect.innerHTML = options.join("");
}

async function unassignCurrentSite(save = true) {
  promptLibrary.prompts.forEach((prompt) => {
    prompt.sites = (prompt.sites || []).filter((site) => site !== currentSite);
  });
  currentPromptId = "";
  if (save) {
    await savePromptLibrary(promptLibrary);
    renderPromptSelect();
  }
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

function makePromptRecord(text, site) {
  const now = Date.now();
  return {
    id: `prompt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: makePromptName(text),
    text,
    sites: site ? [site] : [],
    createdAt: now,
    updatedAt: now
  };
}

function makePromptName(text) {
  const firstLine = String(text || "").split(/\n+/).map((line) => line.trim()).find(Boolean) || "未命名提示词";
  return firstLine.replace(/[。.!?？]$/, "").slice(0, 28);
}

function siteKey(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function loadLegacyPagePrompt(url) {
  const key = legacyPagePromptKey(url);
  if (!key) return "";
  const items = await chrome.storage.local.get({ [key]: "" });
  return items[key] || "";
}

function legacyPagePromptKey(url) {
  try {
    const parsed = new URL(url);
    return `sln-page-prompt:${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
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
