const DEFAULT_LLM_SETTINGS = {
  enabled: false,
  provider: "openai",
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  apiKey: "",
  anthropicVersion: "2023-06-01",
  temperature: 0.2,
  maxTokens: 1024,
  globalPrompt: ""
};

const PROVIDER_DEFAULTS = {
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini"
  },
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-3-5-haiku-latest"
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SLN_ANALYZE_BLOCKS") {
    analyzeBlocks(message.payload).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "SLN_TEST_LLM") {
    testLlm().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});

async function analyzeBlocks(payload) {
  const settings = await getLlmSettings();
  if (!settings.enabled) return { ok: false, error: "LLM is disabled." };
  validateSettings(settings);

  const blocks = (payload.blocks || []).slice(0, 80).map((block) => ({
    id: block.id,
    tag: block.tag,
    text: String(block.text || "").slice(0, 1200)
  }));

  const response = await callLlm(settings, [
    {
      role: "system",
      content: [
        "你是 Semantic Learning Navigator 的知识结构定位引擎。",
        "你的任务不是摘要，而是判断每个知识块在当前页面中的注意力投入等级。",
        "必须只返回 JSON，不要 Markdown，不要解释。",
        "importance 只能是 S/A/B/C。",
        "role 只能是 核心概念/实现细节/理论证明/背景知识。",
        "学习模式下 S 级需要生成 check_question；冲浪模式下 check_question 必须为空。",
        "用户提示词用于定义当前网页的学习目标、重点拆分标准、跳过标准和优先级偏好。",
        "如果用户提示词与 JSON schema 冲突，必须服从 JSON schema。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "analyze_learning_attention_blocks",
        mode: payload.mode,
        stage: payload.stage,
        domain: payload.domain,
        page_url: payload.pageUrl || "",
        global_user_prompt: settings.globalPrompt || "",
        page_user_prompt: payload.pagePrompt || "",
        prompt_priority: "page_user_prompt has higher priority than global_user_prompt. Both prompts can change how重点 are split and ranked, but they must not change the required JSON schema.",
        output_schema: {
          analyses: [
            {
              id: "block id",
              importance: "S/A/B/C",
              role: "核心概念/实现细节/理论证明/背景知识",
              required_depth: "当前应投入的理解深度",
              can_skip_now: true,
              future_dependency: "如果不懂，后续会卡在哪里；如果不阻塞，也要说明",
              why_it_matters: "为什么它值得或不值得投入注意力",
              minimum_mastery: "当前最低掌握标准",
              check_question: "仅学习模式 S 级生成主动回忆问题，否则为空",
              continue_status: "学习模式：✅ 可以继续下一章/❌ 必须真正理解；冲浪模式：必读/可扫读/低投入/可略过",
              detail_trap: false
            }
          ]
        },
        blocks
      })
    }
  ]);

  const content = extractResponseText(response, settings.provider);
  const parsed = parseJsonContent(content);
  if (!Array.isArray(parsed.analyses)) throw new Error("LLM response did not contain analyses array.");
  return { ok: true, analyses: parsed.analyses };
}

async function testLlm() {
  const settings = await getLlmSettings();
  validateSettings(settings);
  const response = settings.provider === "anthropic"
    ? await callAnthropicMessages(settings, [{ role: "user", content: "hello" }], { maxTokens: 40 })
    : await callOpenAiChat(settings, [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: '{"task":"ping","output":{"ok":true}}' }
    ]);
  return {
    ok: true,
    model: response.model || settings.model,
    content: extractResponseText(response, settings.provider)
  };
}

async function getLlmSettings() {
  const items = await chrome.storage.local.get({ slnLlmSettings: DEFAULT_LLM_SETTINGS });
  return normalizeLlmSettings(items.slnLlmSettings);
}

function normalizeLlmSettings(rawSettings = {}) {
  const provider = rawSettings.provider || (rawSettings.apiFormat === "messages" ? "anthropic" : "openai");
  const normalizedProvider = provider === "anthropic" ? "anthropic" : "openai";
  const defaults = PROVIDER_DEFAULTS[normalizedProvider];
  return {
    ...DEFAULT_LLM_SETTINGS,
    ...rawSettings,
    provider: normalizedProvider,
    endpoint: rawSettings.endpoint || defaults.endpoint,
    model: rawSettings.model || defaults.model,
    anthropicVersion: rawSettings.anthropicVersion || DEFAULT_LLM_SETTINGS.anthropicVersion
  };
}

function validateSettings(settings) {
  if (!["openai", "anthropic"].includes(settings.provider)) throw new Error("LLM provider must be OpenAI or Anthropic.");
  if (!settings.endpoint) throw new Error("LLM endpoint is required.");
  if (!settings.model) throw new Error("LLM model is required.");
  if (settings.provider === "anthropic" && !settings.apiKey) throw new Error("Anthropic API key is required.");
}

async function callLlm(settings, messages) {
  if (settings.provider === "anthropic") return callAnthropicMessages(settings, messages);
  return callOpenAiChat(settings, messages);
}

async function callOpenAiChat(settings, messages) {
  try {
    return await postChatCompletions(settings, messages, true);
  } catch (error) {
    if (!String(error.message).includes("400")) throw error;
    return postChatCompletions(settings, messages, false);
  }
}

async function callAnthropicMessages(settings, messages, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": settings.anthropicVersion || DEFAULT_LLM_SETTINGS.anthropicVersion,
    "anthropic-dangerous-direct-browser-access": "true"
  };

  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const userMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "")
    }));
  const body = {
    model: settings.model,
    max_tokens: Number(options.maxTokens || settings.maxTokens) || 1024,
    temperature: Number(settings.temperature) || 0.2,
    messages: userMessages.length > 0 ? userMessages : [{ role: "user", content: "hello" }]
  };
  if (system) body.system = system;

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LLM request failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function postChatCompletions(settings, messages, useJsonMode) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const body = {
    model: settings.model,
    messages,
    temperature: Number(settings.temperature) || 0.2,
    max_tokens: Number(settings.maxTokens) || 1024
  };
  if (useJsonMode) body.response_format = { type: "json_object" };

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LLM request failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function parseJsonContent(content) {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("LLM response was not valid JSON.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function extractResponseText(response, provider) {
  if (provider === "anthropic") {
    if (typeof response.content === "string") return response.content;
    if (Array.isArray(response.content)) {
      return response.content.map((part) => {
        if (typeof part === "string") return part;
        return part.text || part.content || "";
      }).join("");
    }
    return response.message?.content || response.output_text || "";
  }
  return response.choices?.[0]?.message?.content || response.output_text || "";
}
