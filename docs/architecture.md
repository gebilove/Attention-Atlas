# Semantic Learning Navigator Architecture

## Product Boundary

The extension is a learning attention allocation system. It should not optimize for summarizing a page. Its central output is a decision about how much attention a learner should spend on each knowledge block at the current learning stage.

The primary users are undergraduates, master's students, PhD students, and adjacent high-intensity learners. The product is still usable by others, but the design center is academic and technical learning: courses, papers, PDFs, textbooks, proofs, implementation details, and research reading.

## Modes

Semantic Learning Navigator has two product modes:

- Learning mode: systematic study for courses, papers, PDFs, textbooks, and technical docs. The output is about mastery, dependencies, minimum understanding, and whether the learner can continue. S-level blocks require active recall before they can be checked off.
- Surfing mode: everyday reading and research-adjacent browsing. The output is about quickly locating the main point of a news article, blog, public post, or background material. It does not ask questions and does not enforce mastery.

## Pipeline

```text
Browser Extension
  -> DOM knowledge block segmentation
  -> PDF text extraction when the current document is a PDF
  -> Knowledge structure positioning via user-configured LLM
  -> Stage-aware learning priority
  -> Dependency graph construction
  -> Page rendering and sidebar guidance
```

## Block Schema

Each analyzed block should produce:

```json
{
  "mainline": ["page-level reading line from the LLM"],
  "analyses": [
    {
      "importance": "S/A/B/C",
      "role": "核心概念/实现细节/理论证明/背景知识",
      "required_depth": "The understanding depth needed now.",
      "can_skip_now": true,
      "future_dependency": "Where the learner will get blocked later if this is missing.",
      "why_it_matters": "Why this block deserves the recommended attention.",
      "minimum_mastery": "Lowest standard needed to continue.",
      "continue_status": "✅ 可以继续下一章 / ❌ 必须真正理解"
    }
  ]
}
```

## Analyzer Contract

The current MVP uses one analyzer path:

- LLM path: `src/content.js` sends knowledge blocks to `src/background.js`; the background service worker calls the user's configured endpoint and returns structured JSON. Supported providers are OpenAI Chat Completions and Anthropic Messages. OpenAI requests use `Authorization: Bearer`; Anthropic requests use `x-api-key`, `anthropic-version`, and the Messages API body (`model`, `max_tokens`, `messages`).
- Failure behavior: if the LLM request fails or the JSON does not satisfy the schema, the content script shows an error panel and does not generate local heuristic results.

Custom prompts exist at two levels:

- Global default prompt: stored in LLM settings and applied to all pages.
- Website-level prompt: stored in `slnPromptLibrary` and associated with one or more website origins.

Website-level prompt has higher priority. Prompts can guide how the model splits attention, ranks importance, and decides what to skip, but they cannot change the required JSON schema. If a website has no prompt, the content script shows a small confirmation dialog; clicking the primary action generates a prompt from the current page, stores it against the current origin, and then starts analysis.

## Persistence

The extension persists two kinds of page state in `chrome.storage.local`:

- Progress state: checklist completion and S-level active recall answers.
- Analysis cache: structured S/A/B/C analysis results for a page.

Analysis cache is keyed by URL path, product mode, stage, auto-detected domain, and website-level prompt hash. It also stores a block fingerprint and cache schema version, so stale or pre-LLM-only results are ignored when the page content changes. The popup's "reanalyze" action forces a fresh model analysis and overwrites the cache.

The model prompt should ask for knowledge structure positioning, not summary:

- Where is this block in the knowledge system?
- Is it part of the main line for the selected stage?
- Will misunderstanding it block later learning?
- Is it a detail trap for the selected stage?
- What is the minimum mastery standard now?

## Stage Model

Supported stages:

- `beginner`: skip proofs and implementation details unless they are core definitions.
- `course`: prioritize concepts needed to keep moving through course material.
- `interview`: prioritize definitions, tradeoffs, and common mechanisms.
- `engineering`: prioritize implementation, APIs, performance, and failure modes.
- `math`: prioritize definitions, theorem conditions, derivations, and proofs.
- `research`: prioritize proofs, assumptions, limitations, and dependency structure.

## Page Mainline

The sidebar mainline is returned by the configured LLM for the current page. The content script does not display a built-in domain mainline, so generic site pages are not forced into a compiler, ML, math, or other local template.

## Rendering Rules

- S: strong highlight and pinned sidebar entry.
- A: medium emphasis.
- B: weak emphasis.
- C: collapsible and visually de-emphasized.

The UI marks knowledge blocks, not words. Blocks include paragraphs, headings, list items, code blocks, formula regions, tables, blockquotes, and proof-like areas.

## PDF Support

The current PDF path is local and dependency-free:

```text
PDF URL/embed
  -> fetch ArrayBuffer
  -> extract PDF content streams
  -> inflate FlateDecode streams when supported by the browser
  -> extract Tj/TJ text operators
  -> split text into learning blocks
  -> render a readable PDF learning page
```

This is an MVP parser. It works best on text PDFs with simple encodings. A production version should replace this with pdf.js so page geometry, font maps, formulas, and scanned/OCR workflows are handled reliably.
