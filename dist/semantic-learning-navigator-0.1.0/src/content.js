(function semanticLearningNavigator() {
  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "learning",
    stage: "beginner",
    domain: "auto",
    collapseC: true,
    showSidebar: true
  };

  const STAGES = {
    beginner: "入门",
    course: "能推进课程",
    interview: "面试导向",
    engineering: "工程导向",
    math: "数学导向",
    research: "研究导向"
  };

  const DOMAIN_MAINLINES = {
    math: ["定义", "直觉", "定理", "推导"],
    ml: ["数据", "损失", "优化", "泛化"],
    os: ["抽象", "调度", "内存", "并发"],
    compiler: ["Token", "AST", "IR", "优化"],
    dl: ["表示", "反向传播", "架构"],
    economics: ["激励", "均衡", "博弈"],
    physics: ["守恒", "状态", "演化"],
    rl: ["状态/动作", "价值函数", "Bellman", "TD", "策略改进"]
  };

  const DOMAIN_TERMS = {
    math: ["definition", "theorem", "lemma", "proof", "derive", "matrix", "vector", "定义", "定理", "证明", "推导"],
    ml: ["dataset", "loss", "gradient", "regularization", "training", "泛化", "损失", "优化", "梯度"],
    os: ["process", "thread", "memory", "scheduler", "lock", "concurrency", "进程", "线程", "内存", "调度"],
    compiler: ["token", "lexer", "parser", "ast", "ir", "optimization", "语法", "词法", "中间表示"],
    dl: ["neural", "backprop", "transformer", "attention", "embedding", "反向传播", "注意力", "表示"],
    economics: ["incentive", "equilibrium", "utility", "game", "market", "均衡", "激励", "效用", "博弈"],
    physics: ["energy", "force", "momentum", "state", "conservation", "能量", "守恒", "动量", "状态"],
    rl: ["bellman", "policy", "reward", "q-learning", "dqn", "td", "value function", "强化学习", "价值函数", "奖励"]
  };

  const ROLE_PATTERNS = [
    {
      role: "理论证明",
      patterns: ["proof", "prove", "lemma", "theorem", "corollary", "convergence", "证明", "定理", "引理", "收敛", "推导"]
    },
    {
      role: "实现细节",
      patterns: ["api", "install", "implementation", "parameter", "config", "runtime", "gpu", "cuda", "代码", "实现", "参数", "配置", "接口", "优化"]
    },
    {
      role: "核心概念",
      patterns: ["definition", "intuition", "concept", "principle", "objective", "loss", "state", "policy", "bellman", "定义", "直觉", "概念", "原理", "目标", "损失", "价值", "策略"]
    },
    {
      role: "背景知识",
      patterns: ["history", "background", "motivation", "related work", "example", "背景", "历史", "动机", "例子"]
    }
  ];

  const DETAIL_TRAPS = ["proof", "derive", "boundary", "edge case", "optimization", "api", "hyperparameter", "implementation detail", "证明", "边界", "特殊情况", "符号", "推导", "工程优化", "API", "超参数"];

  let state = {
    settings: DEFAULT_SETTINGS,
    pagePrompt: "",
    blocks: [],
    progress: {
      completed: {},
      answers: {}
    },
    tooltip: null,
    activeBlockId: "",
    activeBlockRaf: 0,
    currentDomain: "",
    analysisContext: null
  };

  init();

  function init() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      state.settings = settings;
      loadPagePrompt(() => {});
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "SLN_SETTINGS_UPDATED") {
        const previousSettings = state.settings;
        cleanup();
        state.settings = { ...DEFAULT_SETTINGS, ...message.settings };
        loadPagePrompt(() => {
          if (!state.settings.enabled) return;
          if (message.forceRefresh) {
            run({ forceRefresh: true });
            return;
          }
          refreshExistingAnalysis(previousSettings);
        });
      }
    });
  }

  async function run(options = {}) {
    if (isPdfLikePage()) {
      await runPdfMode(options);
      return;
    }

    const domain = state.settings.domain === "auto" ? detectDomain(document.body.innerText) : state.settings.domain;
    state.currentDomain = domain;
    const stage = activeStage();
    const elements = collectKnowledgeBlocks();
    const blocks = elements.map((element, index) => {
      const block = {
        id: `sln-${index + 1}`,
        element,
        text: normalizeText(element.innerText || element.textContent || ""),
        tag: element.tagName.toLowerCase(),
        domain
      };
      return block;
    }).filter((block) => block.text.length > 0);
    const analyses = await analyzeBlocksWithCache(blocks, stage, domain, options);
    state.analysisContext = makeAnalysisContext(stage, domain);

    loadProgress((progress) => {
      state.progress = progress;
      state.blocks = analyses;
      renderBlocks(analyses);
      renderSidebar(analyses, domain);
      startActiveBlockTracking();
    });
  }

  async function runPdfMode(options = {}) {
    renderPdfLoading();
    try {
      const pdfUrl = findPdfUrl();
      if (!pdfUrl) throw new Error("PDF URL was not found.");
      const pdfBlocks = await extractPdfBlocks(pdfUrl);
      if (pdfBlocks.length === 0) throw new Error("No readable PDF text blocks were extracted.");
      renderPdfDocument(pdfBlocks, pdfUrl);

      const pageText = pdfBlocks.map((block) => block.text).join(" ");
      const domain = state.settings.domain === "auto" ? detectDomain(pageText) : state.settings.domain;
      state.currentDomain = domain;
      const stage = activeStage();
      const blocks = Array.from(document.querySelectorAll("[data-sln-pdf-block]")).map((element, index) => {
        const block = {
          id: `sln-pdf-${index + 1}`,
          element,
          text: normalizeText(element.innerText || element.textContent || ""),
          tag: "p",
          domain
        };
        return block;
      }).filter((block) => block.text.length > 0);
      const analyses = await analyzeBlocksWithCache(blocks, stage, domain, options);
      state.analysisContext = makeAnalysisContext(stage, domain);

      loadProgress((progress) => {
        state.progress = progress;
        state.blocks = analyses;
        renderBlocks(analyses);
        renderSidebar(analyses, domain);
        startActiveBlockTracking();
      });
    } catch (error) {
      renderPdfError(error);
    }
  }

  function isPdfLikePage() {
    return /\.pdf(?:$|[?#])/i.test(location.href) ||
      document.contentType === "application/pdf" ||
      Boolean(document.querySelector("embed[type='application/pdf'], iframe[src*='.pdf'], embed[src*='.pdf']"));
  }

  function findPdfUrl() {
    if (/\.pdf(?:$|[?#])/i.test(location.href)) return location.href;
    const embedded = document.querySelector("embed[type='application/pdf'], iframe[src*='.pdf'], embed[src*='.pdf']");
    const src = embedded?.getAttribute("src");
    return src ? new URL(src, location.href).href : "";
  }

  function renderPdfLoading() {
    document.body.classList.add("sln-pdf-page");
    document.body.innerHTML = `
      <main id="sln-pdf-reader">
        <section class="sln-pdf-status">
          <h1>正在读取 PDF</h1>
          <p>正在提取文本块并准备学习模式分析。</p>
        </section>
      </main>
    `;
  }

  function renderPdfError(error) {
    document.body.classList.add("sln-pdf-page");
    document.body.innerHTML = `
      <main id="sln-pdf-reader">
        <section class="sln-pdf-status">
          <h1>PDF 暂时无法解析</h1>
          <p>${escapeHtml(error.message || "这个 PDF 没有可提取文本，或浏览器阻止扩展读取文件。")}</p>
          <p>扫描版 PDF、复杂字体编码 PDF 或跨域受限 PDF 需要后续接入 pdf.js 才能稳定支持。</p>
        </section>
      </main>
    `;
  }

  function renderPdfDocument(blocks, pdfUrl) {
    document.body.classList.add("sln-pdf-page");
    document.body.innerHTML = `
      <main id="sln-pdf-reader">
        <header class="sln-pdf-header">
          <div>
            <h1>PDF 学习阅读</h1>
            <p>${escapeHtml(new URL(pdfUrl).pathname.split("/").pop() || "PDF document")}</p>
          </div>
          <a href="${escapeAttribute(pdfUrl)}" target="_blank" rel="noreferrer">打开原 PDF</a>
        </header>
        <article class="sln-pdf-content"></article>
      </main>
    `;

    const content = document.querySelector(".sln-pdf-content");
    blocks.forEach((block) => {
      const section = document.createElement("section");
      section.className = "sln-pdf-block";
      section.dataset.slnPdfBlock = "true";
      section.innerHTML = `
        <div class="sln-pdf-page-label">Page ${block.page}</div>
        <p>${escapeHtml(block.text)}</p>
      `;
      content.appendChild(section);
    });
  }

  async function extractPdfBlocks(pdfUrl) {
    const response = await fetch(pdfUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`PDF 请求失败：${response.status}`);
    const buffer = await response.arrayBuffer();
    const text = await extractPdfText(buffer);
    return splitPdfTextIntoBlocks(text);
  }

  async function extractPdfText(buffer) {
    const bytes = new Uint8Array(buffer);
    const binary = bytesToBinary(bytes);
    const pages = [];
    const streamRegex = /<<[\s\S]*?>>\s*stream\r?\n/g;
    let match;

    while ((match = streamRegex.exec(binary))) {
      const dict = match[0];
      const streamStart = streamRegex.lastIndex;
      const streamEnd = binary.indexOf("endstream", streamStart);
      if (streamEnd === -1) break;

      let rawEnd = streamEnd;
      while (rawEnd > streamStart && (binary.charCodeAt(rawEnd - 1) === 10 || binary.charCodeAt(rawEnd - 1) === 13)) rawEnd -= 1;
      const raw = binaryToBytes(binary.slice(streamStart, rawEnd));
      const decoded = dict.includes("/FlateDecode") ? await inflateBytes(raw) : raw;
      const content = bytesToBinary(decoded);
      const pageText = extractTextFromPdfContent(content);
      if (pageText.length > 40) pages.push(pageText);
      streamRegex.lastIndex = streamEnd + "endstream".length;
    }

    return pages.join("\n\n");
  }

  async function inflateBytes(bytes) {
    if (!("DecompressionStream" in globalThis)) return bytes;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return bytes;
    }
  }

  function extractTextFromPdfContent(content) {
    const chunks = [];
    collectPdfStringMatches(content, /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")/g, chunks);
    collectPdfArrayMatches(content, /\[([\s\S]*?)\]\s*TJ/g, chunks);
    collectPdfHexMatches(content, /<([0-9A-Fa-f\s]{4,})>\s*Tj/g, chunks);
    return normalizeText(chunks.join(" "));
  }

  function collectPdfStringMatches(content, regex, chunks) {
    let match;
    while ((match = regex.exec(content))) {
      const literal = match[0].match(/^\((?:\\.|[^\\)])*\)/)?.[0] || "";
      const decoded = decodePdfLiteralString(literal);
      if (decoded) chunks.push(decoded);
    }
  }

  function collectPdfArrayMatches(content, regex, chunks) {
    let match;
    while ((match = regex.exec(content))) {
      const arrayText = match[1];
      collectPdfStringMatches(arrayText, /\((?:\\.|[^\\)])*\)/g, chunks);
      collectPdfHexMatches(arrayText, /<([0-9A-Fa-f\s]{4,})>/g, chunks);
    }
  }

  function collectPdfHexMatches(content, regex, chunks) {
    let match;
    while ((match = regex.exec(content))) {
      const decoded = decodePdfHexString(match[1]);
      if (decoded) chunks.push(decoded);
    }
  }

  function decodePdfLiteralString(literal) {
    let value = literal.replace(/^\(/, "").replace(/\)$/, "");
    value = value.replace(/\\([nrtbf()\\])/g, (_, escaped) => ({
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\"
    }[escaped] || escaped));
    value = value.replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    return decodePdfBytes(binaryToBytes(value));
  }

  function decodePdfHexString(hex) {
    const clean = hex.replace(/\s+/g, "");
    if (clean.length < 4) return "";
    const even = clean.length % 2 === 0 ? clean : `${clean}0`;
    const bytes = new Uint8Array(even.length / 2);
    for (let index = 0; index < even.length; index += 2) {
      bytes[index / 2] = parseInt(even.slice(index, index + 2), 16);
    }
    return decodePdfBytes(bytes);
  }

  function decodePdfBytes(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      let output = "";
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        output += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
      }
      return output;
    }
    return new TextDecoder("windows-1252").decode(bytes).replace(/[^\S\r\n]+/g, " ").trim();
  }

  function splitPdfTextIntoBlocks(text) {
    const cleaned = text.replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
    const paragraphs = cleaned.split(/\n{2,}|(?<=[。！？.!?])\s+(?=[A-Z\u4e00-\u9fa5])/).map(normalizeText).filter((item) => item.length >= 40);
    return paragraphs.slice(0, 100).map((paragraph, index) => ({
      page: Math.floor(index / 6) + 1,
      text: paragraph.slice(0, 1400)
    }));
  }

  function bytesToBinary(bytes) {
    let output = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      output += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return output;
  }

  function binaryToBytes(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) & 0xff;
    }
    return bytes;
  }

  function collectKnowledgeBlocks() {
    const selectors = [
      "main h1", "main h2", "main h3", "main p", "main li", "main pre", "main blockquote", "main table",
      "article h1", "article h2", "article h3", "article p", "article li", "article pre", "article blockquote", "article table",
      "[role='main'] h1", "[role='main'] h2", "[role='main'] h3", "[role='main'] p", "[role='main'] li", "[role='main'] pre",
      ".math", ".katex", "mjx-container", "[data-mathml]",
      "h1", "h2", "h3", "p", "pre", "blockquote", "table"
    ];
    const seen = new Set();
    return Array.from(document.querySelectorAll(selectors.join(",")))
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        if (element.closest("#sln-sidebar,.sln-tooltip,nav,header,footer,aside,script,style")) return false;
        const text = normalizeText(element.innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        return text.length >= 24 && rect.width > 120 && rect.height > 12;
      })
      .slice(0, 80);
  }

  function analyzeBlock(block, stage, domain) {
    const text = block.text;
    const lower = text.toLowerCase();
    const role = detectRole(lower, block.tag);
    const trapScore = countMatches(lower, DETAIL_TRAPS);
    const mainline = DOMAIN_MAINLINES[domain] || inferMainlineFromText(lower);
    const mainlineHit = countMatches(lower, mainline.map((item) => item.toLowerCase()));
    const conceptScore = countMatches(lower, ROLE_PATTERNS.find((entry) => entry.role === "核心概念").patterns);
    const structuralScore = block.tag.match(/^h[1-3]$/) ? 2 : 0;
    const codePenalty = block.tag === "pre" ? stage === "engineering" ? 1 : -1 : 0;

    let score = conceptScore * 2 + mainlineHit * 2 + structuralScore + codePenalty;

    if (role === "理论证明") score += proofWeight(stage);
    if (role === "实现细节") score += implementationWeight(stage);
    if (role === "背景知识") score -= 1;
    if (trapScore > 0 && !["math", "research", "engineering"].includes(stage)) score -= trapScore;
    if (mentionsDependency(lower)) score += 2;

    const importance = toImportance(score);
    const canSkipNow = importance === "C" || (importance === "B" && trapScore > 0);
    const minimum = minimumMastery(role, importance, stage);

    return {
      importance,
      role,
      required_depth: requiredDepth(importance, role, stage),
      can_skip_now: canSkipNow,
      future_dependency: dependencyMessage(importance, role, mainline, lower),
      why_it_matters: whyItMatters(importance, role, stage),
      minimum_mastery: minimum,
      check_question: state.settings.mode === "learning" ? makeCheckQuestion(role, importance, domain, text) : "",
      continue_status: continueStatus(importance, canSkipNow),
      detail_trap: trapScore > 0
    };
  }

  async function analyzeBlocks(blocks, stage, domain) {
    const fallback = blocks.map((block) => ({
      ...block,
      analysis: {
        ...analyzeBlock(block, stage, domain),
        source: "local"
      }
    }));

    try {
      const response = await chrome.runtime.sendMessage({
        type: "SLN_ANALYZE_BLOCKS",
        payload: {
          mode: state.settings.mode,
          stage,
          domain,
          pagePrompt: state.pagePrompt,
          pageUrl: `${location.origin}${location.pathname}`,
          blocks: blocks.map((block) => ({
            id: block.id,
            tag: block.tag,
            text: block.text
          }))
        }
      });
      if (!response?.ok || !Array.isArray(response.analyses)) return fallback;
      const llmById = new Map(response.analyses.map((analysis) => [analysis.id, analysis]));
      return fallback.map((block) => ({
        ...block,
        analysis: normalizeLlmAnalysis(llmById.get(block.id), block.analysis, block, domain)
      }));
    } catch {
      return fallback;
    }
  }

  async function analyzeBlocksWithCache(blocks, stage, domain, options = {}) {
    if (!options.forceRefresh) {
      const cached = await loadAnalysisCache(blocks, stage, domain);
      if (cached) return cached;
    }

    const analyses = await analyzeBlocks(blocks, stage, domain);
    await saveAnalysisCache(analyses, stage, domain);
    return analyses;
  }

  async function loadAnalysisCache(blocks, stage, domain) {
    const key = analysisCacheKey(stage, domain);
    const items = await chrome.storage.local.get({ [key]: null });
    const cached = items[key];
    if (!cached || !Array.isArray(cached.analyses)) return null;
    if (cached.fingerprint !== blocksFingerprint(blocks)) return null;

    const cachedById = new Map(cached.analyses.map((item) => [item.id, item.analysis]));
    const restored = blocks.map((block) => {
      const analysis = cachedById.get(block.id);
      if (!analysis) return null;
      return { ...block, analysis };
    });
    return restored.every(Boolean) ? restored : null;
  }

  async function saveAnalysisCache(analyses, stage, domain) {
    const cache = {
      version: 1,
      savedAt: Date.now(),
      url: `${location.origin}${location.pathname}`,
      mode: state.settings.mode,
      stage,
      domain,
      pagePromptHash: stableHash(state.pagePrompt),
      fingerprint: blocksFingerprint(analyses),
      analyses: analyses.map((block) => ({
        id: block.id,
        textHash: stableHash(block.text),
        analysis: block.analysis
      }))
    };
    await chrome.storage.local.set({ [analysisCacheKey(stage, domain)]: cache });
  }

  function analysisCacheKey(stage, domain) {
    const parts = [
      "sln-analysis",
      location.origin,
      location.pathname,
      state.settings.mode,
      stage,
      domain,
      stableHash(state.pagePrompt)
    ];
    return parts.join(":");
  }

  function blocksFingerprint(blocks) {
    return stableHash(blocks.map((block) => `${block.id}|${stableHash(block.text)}`).join(";"));
  }

  function stableHash(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeLlmAnalysis(llmAnalysis, fallback, block, domain) {
    if (!llmAnalysis || typeof llmAnalysis !== "object") return fallback;
    const importance = ["S", "A", "B", "C"].includes(llmAnalysis.importance) ? llmAnalysis.importance : fallback.importance;
    const role = ["核心概念", "实现细节", "理论证明", "背景知识"].includes(llmAnalysis.role) ? llmAnalysis.role : fallback.role;
    const canSkipNow = typeof llmAnalysis.can_skip_now === "boolean" ? llmAnalysis.can_skip_now : fallback.can_skip_now;
    const detailTrap = typeof llmAnalysis.detail_trap === "boolean" ? llmAnalysis.detail_trap : fallback.detail_trap;
    const checkQuestion = state.settings.mode === "learning" && importance === "S"
      ? stringOrFallback(llmAnalysis.check_question, makeCheckQuestion(role, importance, domain, block.text))
      : "";

    return {
      importance,
      role,
      required_depth: stringOrFallback(llmAnalysis.required_depth, fallback.required_depth),
      can_skip_now: canSkipNow,
      future_dependency: stringOrFallback(llmAnalysis.future_dependency, fallback.future_dependency),
      why_it_matters: stringOrFallback(llmAnalysis.why_it_matters, fallback.why_it_matters),
      minimum_mastery: stringOrFallback(llmAnalysis.minimum_mastery, fallback.minimum_mastery),
      check_question: checkQuestion,
      continue_status: stringOrFallback(llmAnalysis.continue_status, continueStatus(importance, canSkipNow)),
      detail_trap: detailTrap,
      source: "llm"
    };
  }

  function stringOrFallback(value, fallback) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  }

  function activeStage() {
    return state.settings.mode === "surfing" ? "course" : state.settings.stage;
  }

  function continueStatus(importance, canSkipNow) {
    if (state.settings.mode === "surfing") {
      if (importance === "S") return "必读：先看这里";
      if (importance === "A") return "可扫读：抓住观点和结论";
      if (importance === "B") return "低投入：知道大意即可";
      return "可略过：不是当前阅读重点";
    }
    return canSkipNow ? "✅ 可以继续下一章" : importance === "S" ? "❌ 必须真正理解" : "✅ 理解最低标准后可以继续";
  }

  function detectDomain(pageText) {
    const lower = pageText.toLowerCase();
    let best = "ml";
    let bestScore = 0;
    Object.entries(DOMAIN_TERMS).forEach(([domain, terms]) => {
      const score = countMatches(lower, terms);
      if (score > bestScore) {
        best = domain;
        bestScore = score;
      }
    });
    return best;
  }

  function detectRole(lower, tag) {
    if (tag === "pre") return "实现细节";
    for (const entry of ROLE_PATTERNS) {
      if (countMatches(lower, entry.patterns) > 0) return entry.role;
    }
    return "背景知识";
  }

  function proofWeight(stage) {
    return {
      beginner: -3,
      course: -1,
      interview: 0,
      engineering: -2,
      math: 3,
      research: 3
    }[stage] || -1;
  }

  function implementationWeight(stage) {
    return {
      beginner: -2,
      course: 0,
      interview: 1,
      engineering: 3,
      math: -2,
      research: 1
    }[stage] || 0;
  }

  function toImportance(score) {
    if (score >= 6) return "S";
    if (score >= 3) return "A";
    if (score >= 1) return "B";
    return "C";
  }

  function requiredDepth(importance, role, stage) {
    if (state.settings.mode === "surfing") {
      if (importance === "S") return "快速读清楚主张、结论和它对全文的作用。";
      if (importance === "A") return "扫读即可，抓住用途、例子或关键转折。";
      if (importance === "B") return "低投入浏览，保留一个印象。";
      return "当前可以跳过，不影响把握文章重点。";
    }
    if (importance === "S") return "必须能复述定义、解释直觉，并说明它如何连接后续知识。";
    if (importance === "A") return "需要理解用途和关键假设，暂时不必掌握所有推导。";
    if (importance === "B") return "知道它解决什么问题、何时会用到即可。";
    if (role === "理论证明" && !["math", "research"].includes(stage)) return "当前只需知道结论，不必进入证明细节。";
    return "当前可以跳过，保留一个用途标签即可。";
  }

  function dependencyMessage(importance, role, mainline, lower) {
    if (importance === "S") return `这是主线节点，后续通常会依赖它进入 ${mainline.slice(1).join(" → ")}。`;
    if (role === "理论证明") return "主要影响严谨性和研究深度，短期通常不阻塞应用层学习。";
    if (role === "实现细节") return "会影响动手实现或性能调优，但通常不阻塞概念主线。";
    if (mentionsDependency(lower)) return "文本显式包含前置或后续关系，建议记录它连接到哪里。";
    return "暂未识别为强依赖节点。";
  }

  function whyItMatters(importance, role, stage) {
    if (state.settings.mode === "surfing") {
      if (importance === "S") return "这是当前页面最值得停留的重点，通常承载主张、结论或关键解释。";
      if (importance === "A") return "它帮助你补齐上下文，但不需要深挖。";
      if (importance === "B") return "它是辅助信息，避免在这里耗费过多注意力。";
      return "它不影响你快速把握页面核心。";
    }
    if (importance === "S") return `在“${STAGES[stage]}”阶段，这是注意力主线，跳过会提高后续卡住概率。`;
    if (importance === "A") return "它会帮助你推进当前章节，但可以先采用用途级理解。";
    if (importance === "B") return "它提供局部上下文，不应消耗过多精力。";
    if (role === "理论证明") return "这是高风险细节陷阱，容易在当前阶段过度消耗注意力。";
    return "它不是当前阶段的主线投入对象。";
  }

  function minimumMastery(role, importance, stage) {
    if (state.settings.mode === "surfing") {
      if (importance === "S") return "读完后能说出：这段想表达什么、为什么值得看。";
      if (importance === "A") return "知道它补充了什么信息即可。";
      return "可以不记，继续看下一个重点。";
    }
    if (importance === "S") return "能用自己的话讲清楚：它是什么、为什么需要、后面哪里会用。";
    if (role === "实现细节" && stage !== "engineering") return "知道这是实现/API/优化问题，先不追细节。";
    if (role === "理论证明" && !["math", "research"].includes(stage)) return "知道结论成立及大致用途即可。";
    if (importance === "A") return "能说出用途和一个典型场景。";
    return "给它贴一个主题标签，继续往下学。";
  }

  function makeCheckQuestion(role, importance, domain, text) {
    if (importance !== "S") return "";
    const topic = extractTopic(text, domain);
    if (role === "理论证明") return `请用自己的话说明：${topic} 的关键假设是什么？证明或推导想保证什么结论？`;
    if (role === "实现细节") return `请说明：${topic} 解决了什么实现问题？如果这里不掌握，代码会卡在哪里？`;
    return `请用自己的话回答：${topic} 是什么？为什么它是当前主线？后面哪一步会依赖它？`;
  }

  function extractTopic(text, domain) {
    const mainline = DOMAIN_MAINLINES[domain] || DOMAIN_MAINLINES.ml;
    const lower = text.toLowerCase();
    const matched = mainline.find((item) => lower.includes(item.toLowerCase()));
    if (matched) return matched;
    const clean = text.replace(/[^\w\u4e00-\u9fa5\s-]/g, " ").replace(/\s+/g, " ").trim();
    return clean.slice(0, 28) || "这个知识点";
  }

  function mentionsDependency(lower) {
    return ["therefore", "depends on", "leads to", "prerequisite", "because", "so that", "因此", "依赖", "导致", "前置", "所以"].some((term) => lower.includes(term));
  }

  function inferMainlineFromText(lower) {
    if (lower.includes("bellman") || lower.includes("policy") || lower.includes("reward")) return DOMAIN_MAINLINES.rl;
    if (lower.includes("transformer") || lower.includes("backprop")) return DOMAIN_MAINLINES.dl;
    return DOMAIN_MAINLINES.ml;
  }

  function renderBlocks(blocks) {
    blocks.forEach((block) => {
      const { element, analysis } = block;
      element.classList.add("sln-block");
      element.dataset.slnImportance = analysis.importance;
      element.dataset.slnId = block.id;
      element.dataset.slnCompleted = isCompleted(block.id) ? "true" : "false";
      element.style.paddingLeft = element.style.paddingLeft || "8px";

      if (analysis.importance === "C" && state.settings.collapseC) {
        element.classList.add("sln-collapsed");
        element.addEventListener("click", expandCollapsed, { once: true });
      }

      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "sln-badge";
      badge.dataset.slnImportance = analysis.importance;
      badge.textContent = analysis.importance;
      badge.title = `${analysis.role} · ${analysis.required_depth}`;
      badge.addEventListener("mouseenter", (event) => showTooltip(event, block));
      badge.addEventListener("mouseleave", hideTooltip);
      badge.addEventListener("click", () => focusSidebarCard(block.id));
      element.appendChild(badge);
    });
  }

  function renderSidebar(blocks, domain) {
    if (!state.settings.showSidebar) return;

    const sidebar = document.createElement("section");
    sidebar.id = "sln-sidebar";
    sidebar.innerHTML = "";

    const header = document.createElement("div");
    header.className = "sln-panel-header";
    header.innerHTML = `
      <h2 class="sln-panel-title">${state.settings.mode === "surfing" ? "冲浪重点导航" : "学习主线导航"}</h2>
      <div class="sln-panel-actions">
        <button class="sln-icon-button" type="button" data-sln-action="rerun" title="重新分析">↻</button>
        <button class="sln-icon-button" type="button" data-sln-action="hide" title="隐藏">×</button>
      </div>
    `;
    sidebar.appendChild(header);

    const body = document.createElement("div");
    body.className = "sln-panel-body";
    body.appendChild(renderMeta(domain, blocks));
    body.appendChild(renderMainline(domain));
    body.appendChild(renderCards(blocks));
    sidebar.appendChild(body);

    document.body.appendChild(sidebar);

    sidebar.querySelector("[data-sln-action='hide']").addEventListener("click", () => sidebar.classList.add("sln-hidden"));
    sidebar.querySelector("[data-sln-action='rerun']").addEventListener("click", () => {
      cleanup();
      run();
    });
  }

  function renderMeta(domain, blocks) {
    const counts = blocks.reduce((acc, block) => {
      acc[block.analysis.importance] = (acc[block.analysis.importance] || 0) + 1;
      return acc;
    }, {});
    const wrapper = document.createElement("div");
    const completed = blocks.filter((block) => isCompleted(block.id)).length;
    wrapper.className = "sln-meta";
    wrapper.innerHTML = `
      <div class="sln-meta-item"><span class="sln-meta-label">模式</span><span class="sln-meta-value">${state.settings.mode === "surfing" ? "冲浪" : "学习"}</span></div>
      <div class="sln-meta-item"><span class="sln-meta-label">提示词</span><span class="sln-meta-value">${state.pagePrompt ? "本页" : "默认"}</span></div>
      <div class="sln-meta-item"><span class="sln-meta-label">${state.settings.mode === "surfing" ? "重点" : "主线块"}</span><span class="sln-meta-value">S ${counts.S || 0} / A ${counts.A || 0}</span></div>
      <div class="sln-meta-item"><span class="sln-meta-label">${state.settings.mode === "surfing" ? "可略过" : "完成"}</span><span class="sln-meta-value">${state.settings.mode === "surfing" ? `C ${counts.C || 0}` : `${completed} / ${blocks.length}`}</span></div>
    `;
    return wrapper;
  }

  function renderMainline(domain) {
    const wrapper = document.createElement("div");
    const nodes = DOMAIN_MAINLINES[domain] || DOMAIN_MAINLINES.ml;
    wrapper.innerHTML = `<div class="sln-section-title">${state.settings.mode === "surfing" ? "阅读主线" : "知识依赖图"}</div>`;
    const line = document.createElement("div");
    line.className = "sln-mainline";
    nodes.forEach((node, index) => {
      const chip = document.createElement("span");
      chip.className = "sln-node";
      chip.textContent = index === nodes.length - 1 ? node : `${node} →`;
      line.appendChild(chip);
    });
    wrapper.appendChild(line);
    return wrapper;
  }

  function renderCards(blocks) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<div class="sln-section-title">${state.settings.mode === "surfing" ? "快速重点" : "注意力分配"}</div>`;
    blocks
      .filter((block) => ["S", "A", "C"].includes(block.analysis.importance))
      .slice(0, 18)
      .forEach((block) => wrapper.appendChild(renderCard(block)));
    return wrapper;
  }

  function renderCard(block) {
    const card = document.createElement("article");
    const title = block.text.slice(0, 48);
    const completed = state.settings.mode === "learning" && isCompleted(block.id);
    card.className = "sln-card";
    if (completed) card.classList.add("sln-card-completed");
    card.dataset.slnCard = block.id;
    card.innerHTML = `
      <div class="sln-card-head">
        ${state.settings.mode === "learning" ? `<input class="sln-check" type="checkbox" ${completed ? "checked" : ""} ${block.analysis.importance === "S" ? "disabled" : ""} aria-label="标记知识块完成">` : ""}
        <span class="sln-pill" data-sln-importance="${block.analysis.importance}">${block.analysis.importance}</span>
        <span class="sln-card-title">${escapeHtml(title)}</span>
      </div>
      <p><strong>${block.analysis.role}</strong> · ${block.analysis.required_depth}</p>
      <p>${block.analysis.why_it_matters}</p>
      <p>${block.analysis.minimum_mastery}</p>
      <p class="${block.analysis.continue_status.startsWith("✅") ? "sln-ok" : "sln-stop"}">${block.analysis.continue_status}</p>
      ${state.settings.mode === "learning" && block.analysis.importance === "S" ? renderQuestionMarkup(block) : ""}
    `;
    card.querySelector(".sln-check")?.addEventListener("click", (event) => {
      event.stopPropagation();
      setCompleted(block.id, event.currentTarget.checked);
    });
    const answerButton = card.querySelector("[data-sln-answer]");
    if (answerButton) {
      answerButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const textarea = card.querySelector(".sln-answer");
        const answer = normalizeText(textarea.value);
        if (answer.length < 12) {
          card.classList.add("sln-needs-answer");
          textarea.focus();
          return;
        }
        state.progress.answers[block.id] = answer;
        setCompleted(block.id, true);
      });
    }
    card.querySelector(".sln-answer")?.addEventListener("click", (event) => event.stopPropagation());
    card.addEventListener("click", () => {
      block.element.scrollIntoView({ behavior: "smooth", block: "center" });
      block.element.animate([{ outline: "3px solid #2563eb" }, { outline: "0 solid transparent" }], { duration: 900 });
    });
    return card;
  }

  function renderQuestionMarkup(block) {
    const answer = state.progress.answers[block.id] || "";
    return `
      <div class="sln-question">
        <label>理解检查</label>
        <p>${escapeHtml(block.analysis.check_question)}</p>
        <textarea class="sln-answer" rows="3" placeholder="用自己的话回答后，才能标记这个 S 级知识已掌握。">${escapeHtml(answer)}</textarea>
        <button class="sln-answer-button" type="button" data-sln-answer="${block.id}">${answer ? "更新并标记掌握" : "标记掌握"}</button>
        <div class="sln-answer-hint">回答至少 12 个字符。这里不自动判分，用于强制主动回忆。</div>
      </div>
    `;
  }

  function showTooltip(event, block) {
    hideTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = "sln-tooltip";
    tooltip.innerHTML = `
      <strong>${block.analysis.importance} · ${block.analysis.role}</strong>
      <div>${block.analysis.required_depth}</div>
      <div>${block.analysis.future_dependency}</div>
      <div>${block.analysis.can_skip_now ? "当前可以跳过。" : "当前不建议跳过。"}</div>
    `;
    document.body.appendChild(tooltip);
    const rect = event.currentTarget.getBoundingClientRect();
    tooltip.style.top = `${window.scrollY + rect.bottom + 8}px`;
    tooltip.style.left = `${Math.max(12, window.scrollX + rect.left)}px`;
    state.tooltip = tooltip;
  }

  function hideTooltip() {
    if (state.tooltip) {
      state.tooltip.remove();
      state.tooltip = null;
    }
  }

  function focusSidebarCard(id) {
    const card = document.querySelector(`[data-sln-card="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card.animate([{ backgroundColor: "#dbeafe" }, { backgroundColor: "#fff" }], { duration: 800 });
  }

  function startActiveBlockTracking() {
    stopActiveBlockTracking();
    if (!state.settings.showSidebar || state.blocks.length === 0) return;
    updateActiveBlock();
    window.addEventListener("scroll", scheduleActiveBlockUpdate, { passive: true });
    window.addEventListener("resize", scheduleActiveBlockUpdate, { passive: true });
  }

  function stopActiveBlockTracking() {
    window.removeEventListener("scroll", scheduleActiveBlockUpdate);
    window.removeEventListener("resize", scheduleActiveBlockUpdate);
    if (state.activeBlockRaf) cancelAnimationFrame(state.activeBlockRaf);
    state.activeBlockRaf = 0;
  }

  function scheduleActiveBlockUpdate() {
    if (state.activeBlockRaf) return;
    state.activeBlockRaf = requestAnimationFrame(() => {
      state.activeBlockRaf = 0;
      updateActiveBlock();
    });
  }

  function updateActiveBlock() {
    const active = findActiveBlock();
    if (!active || active.id === state.activeBlockId) return;
    setActiveBlock(active.id);
  }

  function findActiveBlock() {
    const navigableBlocks = state.blocks.filter((block) => document.querySelector(`[data-sln-card="${block.id}"]`));
    if (navigableBlocks.length === 0) return null;

    const anchorY = Math.min(window.innerHeight * 0.42, 360);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    navigableBlocks.forEach((block) => {
      const rect = block.element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      let distance;
      if (rect.top <= anchorY && rect.bottom >= anchorY) {
        distance = 0;
      } else if (rect.bottom < anchorY) {
        distance = anchorY - rect.bottom + 24;
      } else {
        distance = rect.top - anchorY;
      }

      if (distance < bestDistance) {
        best = block;
        bestDistance = distance;
      }
    });

    return best;
  }

  function setActiveBlock(id) {
    state.activeBlockId = id;
    document.querySelectorAll(".sln-block-active").forEach((element) => element.classList.remove("sln-block-active"));
    document.querySelectorAll(".sln-card-active").forEach((card) => card.classList.remove("sln-card-active"));

    const block = state.blocks.find((item) => item.id === id);
    block?.element.classList.add("sln-block-active");

    const card = document.querySelector(`[data-sln-card="${id}"]`);
    if (!card) return;
    card.classList.add("sln-card-active");
    scrollSidebarCardIntoView(card);
  }

  function scrollSidebarCardIntoView(card) {
    const sidebar = document.querySelector("#sln-sidebar");
    if (!sidebar || sidebar.classList.contains("sln-hidden")) return;

    const sidebarRect = sidebar.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const padding = 14;
    if (cardRect.top >= sidebarRect.top + padding && cardRect.bottom <= sidebarRect.bottom - padding) return;

    const target = card.offsetTop - sidebar.clientHeight * 0.38;
    sidebar.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  function expandCollapsed(event) {
    event.currentTarget.classList.remove("sln-collapsed");
  }

  function cleanup() {
    stopActiveBlockTracking();
    state.activeBlockId = "";
    hideTooltip();
    document.querySelector("#sln-sidebar")?.remove();
    document.querySelectorAll(".sln-badge").forEach((badge) => badge.remove());
    document.querySelectorAll(".sln-block").forEach((element) => {
      element.classList.remove("sln-block", "sln-collapsed", "sln-block-active");
      delete element.dataset.slnImportance;
      delete element.dataset.slnId;
      delete element.dataset.slnCompleted;
    });
  }

  function refreshExistingAnalysis(previousSettings) {
    if (state.blocks.length === 0) return;
    if (previousSettings.stage !== state.settings.stage || previousSettings.domain !== state.settings.domain) return;
    if (!analysisContextMatchesCurrent()) return;
    loadProgress((progress) => {
      state.progress = progress;
      renderBlocks(state.blocks);
      renderSidebar(state.blocks, state.currentDomain || state.blocks[0]?.domain || "ml");
      startActiveBlockTracking();
    });
  }

  function makeAnalysisContext(stage, domain) {
    return {
      stage,
      settingDomain: state.settings.domain,
      domain,
      pagePrompt: state.pagePrompt
    };
  }

  function analysisContextMatchesCurrent() {
    const context = state.analysisContext;
    if (!context) return false;
    return context.stage === activeStage() &&
      context.settingDomain === state.settings.domain &&
      context.domain === state.currentDomain &&
      context.pagePrompt === state.pagePrompt;
  }

  function loadProgress(callback) {
    chrome.storage.local.get({ [progressKey()]: { completed: {}, answers: {} } }, (items) => {
      const progress = items[progressKey()] || { completed: {}, answers: {} };
      callback({
        completed: progress.completed || {},
        answers: progress.answers || {}
      });
    });
  }

  function loadPagePrompt(callback) {
    chrome.storage.local.get({ [pagePromptKey()]: "" }, (items) => {
      state.pagePrompt = items[pagePromptKey()] || "";
      callback();
    });
  }

  function pagePromptKey() {
    return `sln-page-prompt:${location.origin}${location.pathname}`;
  }

  function saveProgress() {
    chrome.storage.local.set({ [progressKey()]: state.progress });
  }

  function progressKey() {
    return `sln-progress:${location.origin}${location.pathname}`;
  }

  function isCompleted(id) {
    return Boolean(state.progress.completed[id]);
  }

  function setCompleted(id, completed) {
    state.progress.completed[id] = completed;
    const block = state.blocks.find((item) => item.id === id);
    if (block) block.element.dataset.slnCompleted = completed ? "true" : "false";
    saveProgress();
    refreshSidebar();
  }

  function refreshSidebar() {
    const domain = state.blocks[0]?.domain || "ml";
    document.querySelector("#sln-sidebar")?.remove();
    renderSidebar(state.blocks, domain);
    setActiveBlock(state.activeBlockId);
  }

  function countMatches(lower, terms) {
    return terms.reduce((count, term) => count + (lower.includes(term.toLowerCase()) ? 1 : 0), 0);
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }
})();
