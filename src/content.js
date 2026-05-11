(function semanticLearningNavigator() {
  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "learning",
    stage: "beginner",
    domain: "auto",
    collapseC: true,
    showSidebar: true
  };

  const PROMPT_LIBRARY_KEY = "slnPromptLibrary";
  const SITE_SETTINGS_KEY = "slnSiteSettings";
  const ANALYSIS_CACHE_VERSION = 2;
  const CONTENT_ANALYSIS_BATCH_SIZE = 10;
  const CONTENT_ANALYSIS_BATCH_TIMEOUT_MS = 75000;

  const STAGES = {
    beginner: "入门",
    course: "能推进课程",
    interview: "面试导向",
    engineering: "工程导向",
    math: "数学导向",
    research: "研究导向"
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
    currentMainline: [],
    promptId: "",
    analysisContext: null
  };

  init();

  function init() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      state.settings = settings;
      loadPagePrompt(() => {
        if (!state.settings.enabled) return;
        if (state.pagePrompt) {
          loadSiteAutoAnalyze((autoAnalyze) => {
            if (autoAnalyze) run();
          });
          return;
        }
        notifyNoPrompt();
      });
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "SLN_GENERATE_PAGE_PROMPT") {
        sendResponse({
          ok: true,
          prompt: generatePagePrompt(message.payload || {})
        });
        return false;
      }

      if (message.type === "SLN_SETTINGS_UPDATED") {
        const previousSettings = state.settings;
        cleanup();
        state.settings = { ...DEFAULT_SETTINGS, ...message.settings };
        loadPagePrompt(() => {
          if (!state.settings.enabled) return;
          if (!state.pagePrompt) {
            notifyNoPrompt();
            return;
          }
          if (message.forceRefresh) {
            run({ forceRefresh: true });
            return;
          }
          loadSiteAutoAnalyze((autoAnalyze) => {
            if (autoAnalyze) refreshExistingAnalysis(previousSettings);
          });
        });
      }

      if (message.type === "SLN_SITE_AUTO_ANALYZE_UPDATED") {
        if (message.autoAnalyze && state.pagePrompt && state.settings.enabled) {
          run({ forceRefresh: true });
        } else if (!message.autoAnalyze) {
          cleanup();
        }
        return false;
      }

      return false;
    });
  }

  async function run(options = {}) {
    chrome.runtime.sendMessage({ type: "SLN_SET_BADGE", text: "" });
    if (isPdfLikePage()) {
      await runPdfMode(options);
      return;
    }

    try {
      renderAnalysisLoading("正在准备页面分析", "正在抽取当前页面的知识块。");
      const domain = state.settings.domain === "auto" ? detectDomain(document.body.innerText) : state.settings.domain;
      state.currentDomain = domain;
      const stage = activeStage();
      const elements = await waitForKnowledgeBlocks();
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
      if (blocks.length === 0) throw new Error("没有抽取到可分析的页面内容块。");
      state.currentMainline = [];
      updateAnalysisLoading(
        state.settings.mode === "surfing" ? "正在定位页面重点" : "正在分析学习主线",
        `已抽取 ${blocks.length} 个内容块，正在等待 LLM 返回结果。`
      );
      const analyses = await analyzeBlocksWithCache(blocks, stage, domain, options);
      state.analysisContext = makeAnalysisContext(stage, domain);

      loadProgress((progress) => {
        removeAnalysisLoading();
        state.progress = progress;
        state.blocks = analyses;
        renderBlocks(analyses);
        renderSidebar(analyses, domain);
        startActiveBlockTracking();
      });
    } catch (error) {
      renderAnalysisError(error);
    }
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
      state.currentMainline = [];
      renderAnalysisLoading(
        state.settings.mode === "surfing" ? "正在定位 PDF 重点" : "正在分析 PDF 主线",
        `已提取 ${blocks.length} 个 PDF 内容块，正在等待 LLM 返回结果。`
      );
      const analyses = await analyzeBlocksWithCache(blocks, stage, domain, options);
      state.analysisContext = makeAnalysisContext(stage, domain);

      loadProgress((progress) => {
        removeAnalysisLoading();
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
          ${renderLoadingMarkup("读取中")}
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

  function renderAnalysisError(error) {
    cleanup();
    const message = error.message || "请检查 LLM 设置、网络连接或模型返回的 JSON schema。";
    const panel = document.createElement("section");
    panel.id = "sln-sidebar";
    panel.innerHTML = `
      <div class="sln-panel-header">
        <h2 class="sln-panel-title">LLM 分析失败</h2>
        <div class="sln-panel-actions">
          <button class="sln-icon-button" type="button" data-sln-action="rerun" title="重新分析">↻</button>
          <button class="sln-icon-button" type="button" data-sln-action="hide" title="隐藏">×</button>
        </div>
      </div>
      <div class="sln-panel-body">
        <article class="sln-card">
          <p><strong>当前已启用 LLM-only 分析。</strong></p>
          <p>${escapeHtml(message)}</p>
          <p>不会再使用本地启发式算法生成替代结果。</p>
          <button class="sln-settings-button" type="button" data-sln-action="settings">打开 LLM 设置</button>
        </article>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector("[data-sln-action='hide']").addEventListener("click", () => panel.classList.add("sln-hidden"));
    panel.querySelector("[data-sln-action='rerun']").addEventListener("click", () => {
      cleanup();
      run({ forceRefresh: true });
    });
    panel.querySelector("[data-sln-action='settings']")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "SLN_OPEN_OPTIONS" });
    });
  }

  function renderAnalysisLoading(title, message) {
    cleanup();
    const panel = document.createElement("section");
    panel.id = "sln-sidebar";
    panel.dataset.slnLoading = "true";
    panel.innerHTML = `
      <div class="sln-panel-header">
        <h2 class="sln-panel-title">${escapeHtml(title)}</h2>
        <div class="sln-panel-actions">
          <button class="sln-icon-button" type="button" data-sln-action="hide" title="隐藏">×</button>
        </div>
      </div>
      <div class="sln-panel-body">
        <article class="sln-card sln-loading-card">
          ${renderLoadingMarkup("分析中")}
          <p data-sln-loading-message>${escapeHtml(message)}</p>
        </article>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector("[data-sln-action='hide']").addEventListener("click", () => panel.classList.add("sln-hidden"));
  }

  function updateAnalysisLoading(title, message) {
    const panel = document.querySelector("#sln-sidebar[data-sln-loading='true']");
    if (!panel) return;
    const heading = panel.querySelector(".sln-panel-title");
    const body = panel.querySelector("[data-sln-loading-message]");
    if (heading) heading.textContent = title;
    if (body) body.textContent = message;
  }

  function removeAnalysisLoading() {
    document.querySelector("#sln-sidebar[data-sln-loading='true']")?.remove();
  }

  function renderLoadingMarkup(label) {
    return `
      <div class="sln-loading" role="status" aria-live="polite">
        <span class="sln-spinner" aria-hidden="true"></span>
        <span>${escapeHtml(label)}</span>
      </div>
      <div class="sln-progress" aria-hidden="true"><span></span></div>
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
      "h1", "h2", "h3", "h4", "p", "li", "pre", "blockquote", "table",
      ".math", ".katex", "mjx-container", "[data-mathml]",
      "section", "article", "div"
    ];
    const seen = new Set();
    return collectContentRoots()
      .flatMap((root) => Array.from(root.querySelectorAll(selectors.join(","))))
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return isKnowledgeBlockCandidate(element);
      })
      .slice(0, 80);
  }

  async function waitForKnowledgeBlocks() {
    let blocks = collectKnowledgeBlocks();
    if (blocks.length > 0) return blocks;

    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        blocks = collectKnowledgeBlocks();
        if (blocks.length > 0) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 5000);
    });

    return blocks.length > 0 ? blocks : collectKnowledgeBlocks();
  }

  function collectContentRoots() {
    const selectors = [
      "main",
      "article",
      "[role='main']",
      ".markdown-body",
      ".prose",
      ".content",
      ".chapter",
      ".chapter-content",
      ".article-content",
      ".doc-content",
      ".post-content"
    ];
    const roots = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter((element) => !isExcludedContentElement(element));
    return roots.length > 0 ? roots : [document.body];
  }

  function isKnowledgeBlockCandidate(element) {
    if (isExcludedContentElement(element)) return false;
    if (element.matches("button,input,select,textarea,label,svg,canvas,iframe,video,audio")) return false;

    const text = normalizeText(element.innerText || element.textContent || "");
    if (text.length < 24) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 120 || rect.height <= 12) return false;
    if (isMostlyInteractive(element)) return false;
    if (isContainerWithoutDirectText(element, text)) return false;

    return true;
  }

  function isExcludedContentElement(element) {
    return Boolean(element.closest([
      "#sln-sidebar",
      "#sln-prompt-start",
      ".sln-tooltip",
      "nav",
      "header",
      "footer",
      "aside",
      "script",
      "style",
      "noscript",
      "[aria-hidden='true']",
      "[hidden]"
    ].join(",")));
  }

  function isMostlyInteractive(element) {
    const interactiveText = Array.from(element.querySelectorAll("a,button,input,select,textarea"))
      .map((item) => normalizeText(item.innerText || item.textContent || item.value || ""))
      .join(" ");
    const text = normalizeText(element.innerText || element.textContent || "");
    return interactiveText.length > 0 && interactiveText.length / Math.max(text.length, 1) > 0.6;
  }

  function isContainerWithoutDirectText(element, text) {
    if (!element.matches("div,section,article")) return false;
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => normalizeText(node.textContent || ""))
      .join(" ");
    if (directText.length >= 24) return false;

    const childBlocks = Array.from(element.children).filter((child) => {
      if (isExcludedContentElement(child)) return false;
      if (!child.matches("h1,h2,h3,h4,p,li,pre,blockquote,table,section,article,div")) return false;
      const childText = normalizeText(child.innerText || child.textContent || "");
      return childText.length >= 24;
    });

    if (childBlocks.length >= 2) return true;
    if (childBlocks.length === 1) {
      const childText = normalizeText(childBlocks[0].innerText || childBlocks[0].textContent || "");
      return childText.length / Math.max(text.length, 1) > 0.75;
    }
    return false;
  }

  async function analyzeBlocks(blocks, stage, domain) {
    try {
      const analyses = [];
      state.currentMainline = [];

      for (let index = 0; index < blocks.length; index += CONTENT_ANALYSIS_BATCH_SIZE) {
        const batch = blocks.slice(index, index + CONTENT_ANALYSIS_BATCH_SIZE);
        updateAnalysisLoading(
          state.settings.mode === "surfing" ? "正在定位页面重点" : "正在分析学习主线",
          `正在分析第 ${index + 1}-${index + batch.length} / ${blocks.length} 个内容块。`
        );
        const response = await sendRuntimeMessageWithTimeout({
          type: "SLN_ANALYZE_BLOCKS",
          payload: {
            mode: state.settings.mode,
            stage,
            domain: state.settings.domain === "auto" ? "" : domain,
            pagePrompt: state.pagePrompt,
            pageUrl: `${location.origin}${location.pathname}`,
            blocks: batch.map((block) => ({
              id: block.id,
              tag: block.tag,
              text: block.text
            }))
          }
        });
        if (!response?.ok) throw new Error(response?.error || "LLM 分析失败。");
        if (!Array.isArray(response.analyses)) throw new Error("LLM 没有返回 analyses 数组。");
        mergeLlmMainline(response.mainline);
        analyses.push(...response.analyses);
      }

      const llmById = new Map(analyses.map((analysis) => [analysis.id, analysis]));
      return blocks.map((block) => {
        const llmAnalysis = llmById.get(block.id);
        if (!llmAnalysis) throw new Error(`LLM 结果缺少内容块 ${block.id}。`);
        return {
          ...block,
          analysis: normalizeLlmAnalysis(llmAnalysis)
        };
      });
    } catch (error) {
      throw new Error(error.message || "LLM 分析失败。");
    }
  }

  function sendRuntimeMessageWithTimeout(message, timeoutMs = CONTENT_ANALYSIS_BATCH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = window.setTimeout(() => {
        if (finished) return;
        finished = true;
        reject(new Error(`LLM 分析请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回。请检查模型端点、网络或降低 max tokens。`));
      }, timeoutMs);

      chrome.runtime.sendMessage(message, (response) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "扩展后台没有返回 LLM 分析结果。"));
          return;
        }
        resolve(response);
      });
    });
  }

  function mergeLlmMainline(value) {
    normalizeLlmMainline(value).forEach((item) => {
      if (!state.currentMainline.includes(item) && state.currentMainline.length < 6) {
        state.currentMainline.push(item);
      }
    });
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
    if (cached.version !== ANALYSIS_CACHE_VERSION) return null;
    if (cached.fingerprint !== blocksFingerprint(blocks)) return null;
    if (cached.analyses.some((item) => item.analysis?.source !== "llm")) return null;
    state.currentMainline = normalizeLlmMainline(cached.mainline);

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
      version: ANALYSIS_CACHE_VERSION,
      savedAt: Date.now(),
      url: `${location.origin}${location.pathname}`,
      mode: state.settings.mode,
      stage,
      domain,
      mainline: normalizeLlmMainline(state.currentMainline),
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

  function normalizeLlmAnalysis(llmAnalysis) {
    if (!llmAnalysis || typeof llmAnalysis !== "object") throw new Error("LLM 返回了无效的分析对象。");
    const importance = String(llmAnalysis.importance || "").trim();
    const role = String(llmAnalysis.role || "").trim();
    if (!["S", "A", "B", "C"].includes(importance)) throw new Error("LLM 返回了无效的 importance。");
    if (!["核心概念", "实现细节", "理论证明", "背景知识"].includes(role)) throw new Error("LLM 返回了无效的 role。");
    if (typeof llmAnalysis.can_skip_now !== "boolean") throw new Error("LLM 返回的 can_skip_now 不是布尔值。");
    if (typeof llmAnalysis.detail_trap !== "boolean") throw new Error("LLM 返回的 detail_trap 不是布尔值。");
    const checkQuestion = state.settings.mode === "learning" && importance === "S"
      ? requiredLlmString(llmAnalysis.check_question, "check_question")
      : "";

    return {
      importance,
      role,
      required_depth: requiredLlmString(llmAnalysis.required_depth, "required_depth"),
      can_skip_now: llmAnalysis.can_skip_now,
      future_dependency: requiredLlmString(llmAnalysis.future_dependency, "future_dependency"),
      why_it_matters: requiredLlmString(llmAnalysis.why_it_matters, "why_it_matters"),
      minimum_mastery: requiredLlmString(llmAnalysis.minimum_mastery, "minimum_mastery"),
      check_question: checkQuestion,
      continue_status: requiredLlmString(llmAnalysis.continue_status, "continue_status"),
      detail_trap: llmAnalysis.detail_trap,
      source: "llm"
    };
  }

  function requiredLlmString(value, field) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    throw new Error(`LLM 结果缺少 ${field}。`);
  }

  function normalizeLlmMainline(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => normalizeText(String(item || "")))
      .filter((item) => item.length > 0 && item.length <= 30)
      .slice(0, 6);
  }

  function activeStage() {
    return state.settings.mode === "surfing" ? "course" : state.settings.stage;
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

  function generatePagePrompt(payload = {}) {
    const mode = payload.mode || state.settings.mode;
    const stage = mode === "surfing" ? "course" : payload.stage || activeStage();
    const title = normalizeText(document.title || document.querySelector("h1")?.innerText || "");
    const headings = collectPromptHeadings();
    const terms = extractPromptTerms();
    const target = mode === "surfing"
      ? "我在快速判断这页是否值得投入时间"
      : `我当前处于「${STAGES[stage] || stage}」阶段学习这页内容`;
    const priority = headings.length > 0
      ? `优先围绕这些页面主线判断注意力：${headings.join(" / ")}。`
      : `优先围绕页面标题「${title || "当前网页"}」和正文高频概念判断注意力。`;
    const focus = terms.length > 0
      ? `重点关注这些概念是否构成后续依赖：${terms.join("、")}。`
      : `重点关注页面标题「${title || "当前网页"}」中的核心概念是否构成后续依赖。`;
    const skipRule = mode === "surfing"
      ? "把背景铺垫、营销性描述、重复例子和低信息密度段落标为可扫读或可略过。"
      : "把暂时不阻塞理解的背景、例子、实现枝节和符号细节降级，避免把注意力花在细节陷阱上。";
    const outputBias = mode === "surfing"
      ? "请直接区分必读、可扫读、低投入、可略过。"
      : "S 级内容需要给出能检验我是否真正理解的主动回忆问题。";

    return [
      `${target}。`,
      priority,
      focus,
      skipRule,
      outputBias
    ].join("\n");
  }

  function notifyNoPrompt() {
    chrome.runtime.sendMessage({ type: "SLN_SET_BADGE", text: "!" });
  }

  function renderPromptStartDialog() {
    if (document.querySelector("#sln-prompt-start")) return;
    if (document.querySelector("#sln-sidebar")) return;

    const dialog = document.createElement("section");
    dialog.id = "sln-prompt-start";
    dialog.innerHTML = `
      <div class="sln-prompt-start-head">
        <h2>当前网站还没有提示词</h2>
        <button type="button" data-sln-prompt-close aria-label="关闭">×</button>
      </div>
      <p>是否根据这个网站自动生成提示词，并开始分析当前页面？生成后会记录到 ${escapeHtml(siteKey())}，同一个提示词也可以在 popup 中关联到其他网站。</p>
      <div class="sln-prompt-start-actions">
        <button class="sln-prompt-secondary" type="button" data-sln-prompt-close>暂不分析</button>
        <button class="sln-prompt-primary" type="button" data-sln-prompt-generate>自动生成并分析</button>
      </div>
    `;
    document.body.appendChild(dialog);

    dialog.querySelectorAll("[data-sln-prompt-close]").forEach((button) => {
      button.addEventListener("click", () => dialog.remove());
    });
    dialog.querySelector("[data-sln-prompt-generate]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.innerHTML = `<span class="sln-button-spinner" aria-hidden="true"></span><span>生成中</span>`;
      dialog.querySelector("p").insertAdjacentHTML("afterend", renderLoadingMarkup("生成提示词"));
      const prompt = generatePagePrompt({
        mode: state.settings.mode,
        stage: activeStage()
      });
      await saveGeneratedPromptForCurrentSite(prompt);
      dialog.remove();
      cleanup();
      run({ forceRefresh: true });
    });
  }

  function collectPromptHeadings() {
    const headings = Array.from(document.querySelectorAll("main h1, main h2, article h1, article h2, [role='main'] h1, [role='main'] h2, h1, h2"))
      .filter((element) => !element.closest("#sln-sidebar,#sln-prompt-start,.sln-tooltip"))
      .map((element) => normalizeText(element.innerText || element.textContent || ""))
      .filter((text) => text.length >= 3 && text.length <= 80);
    return uniqueValues(headings).slice(0, 6);
  }

  function extractPromptTerms() {
    const headingTerms = collectPromptHeadings()
      .flatMap((heading) => heading.split(/[\s,，:：/｜|()（）\-]+/))
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && term.length <= 24)
      .slice(0, 8);
    return uniqueValues(headingTerms).slice(0, 8);
  }

  function uniqueValues(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
    body.appendChild(renderMainline());
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

  function renderMainline() {
    const wrapper = document.createElement("div");
    const nodes = state.currentMainline.length > 0 ? state.currentMainline : ["等待 LLM 主线"];
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
    document.querySelector("#sln-prompt-start")?.remove();
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
    if (previousSettings.mode !== state.settings.mode || previousSettings.stage !== state.settings.stage) return;
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
      mode: state.settings.mode,
      stage,
      settingDomain: state.settings.domain,
      domain,
      pagePrompt: state.pagePrompt
    };
  }

  function analysisContextMatchesCurrent() {
    const context = state.analysisContext;
    if (!context) return false;
    return context.mode === state.settings.mode &&
      context.stage === activeStage() &&
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
    loadSitePrompt().then((prompt) => {
      state.pagePrompt = prompt.text || "";
      state.promptId = prompt.id || "";
      callback();
    });
  }

  async function loadSitePrompt() {
    const library = await loadPromptLibrary();
    const assigned = library.prompts.find((prompt) => (prompt.sites || []).includes(siteKey()));
    if (assigned) return { id: assigned.id, text: assigned.text || "" };

    const legacyPrompt = await loadLegacyPagePrompt();
    if (!legacyPrompt) return { id: "", text: "" };

    const prompt = makePromptRecord(legacyPrompt, siteKey());
    library.prompts.unshift(prompt);
    await savePromptLibrary(library);
    return { id: prompt.id, text: prompt.text };
  }

  async function saveGeneratedPromptForCurrentSite(text) {
    const library = await loadPromptLibrary();
    let prompt = state.promptId ? library.prompts.find((item) => item.id === state.promptId) : null;
    if (!prompt) prompt = library.prompts.find((item) => (item.sites || []).includes(siteKey()));

    if (prompt) {
      prompt.text = text;
      prompt.name = prompt.name || makePromptName(text);
      prompt.sites = uniqueValues([...(prompt.sites || []), siteKey()]);
      prompt.updatedAt = Date.now();
      state.promptId = prompt.id;
    } else {
      prompt = makePromptRecord(text, siteKey());
      library.prompts.unshift(prompt);
      state.promptId = prompt.id;
    }

    state.pagePrompt = text;
    await savePromptLibrary(library);
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

  async function loadLegacyPagePrompt() {
    const key = legacyPagePromptKey();
    const items = await chrome.storage.local.get({ [key]: "" });
    return items[key] || "";
  }

  function legacyPagePromptKey() {
    return `sln-page-prompt:${location.origin}${location.pathname}`;
  }

  function siteKey() {
    return location.origin;
  }

  function loadSiteAutoAnalyze(callback) {
    chrome.storage.local.get({ [SITE_SETTINGS_KEY]: {} }, (items) => {
      const siteSettings = items[SITE_SETTINGS_KEY] || {};
      const setting = siteSettings[siteKey()];
      // Default is false (auto-analyze disabled) unless explicitly enabled
      const autoAnalyze = setting ? setting.autoAnalyze === true : false;
      callback(autoAnalyze);
    });
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
