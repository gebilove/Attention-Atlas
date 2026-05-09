# Semantic Learning Navigator

Semantic Learning Navigator is a browser extension MVP for learning attention allocation. Its primary users are undergraduates, master's students, PhD students, and other high-intensity learners who repeatedly face courses, papers, textbooks, PDFs, and technical material. It marks page-level knowledge blocks, ranks them by learning importance, and explains whether the user should deeply understand, skim, defer, or skip a block for the current stage.

The product is not limited to university users, but the core design assumes a real study workload: long materials, dependency-heavy concepts, proofs, implementation details, and the need to decide where attention is worth spending.

## Product Modes

The product is built around attention allocation, with two modes:

- Learning mode: for courses, textbooks, papers, PDFs, docs, and systematic study. It keeps a per-page checklist. S-level knowledge requires an active recall answer before it can be marked as mastered.
- Surfing mode: for daily reading such as news, blogs, public articles, and research-adjacent browsing. It quickly points out what deserves attention, what can be skimmed, and what can be skipped. It never asks questions.

## Load locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select this folder.

## Current MVP

- DOM knowledge block segmentation for paragraphs, lists, code, formulas, tables, headings, blockquotes, and proof-like regions.
- PDF learning mode for directly reachable text PDFs. The extension fetches the PDF locally, extracts text streams, renders a readable block view, then applies the same learning attention system.
- User-configurable LLM analysis through OpenAI Chat Completions or Anthropic Messages. The extension sends page blocks to the background service worker, which calls the user's configured model and returns structured S/A/B/C analysis.
- Provider-specific request handling: OpenAI uses `Authorization: Bearer` with Chat Completions; Anthropic uses `x-api-key`, `anthropic-version`, and the Messages API request shape.
- Custom prompts at two levels:
  - global default prompt in the LLM settings page
  - website-level prompt records in the popup/settings page, with website-level priority
- Prompt library management: one prompt can be associated with multiple website origins.
- Website-level prompt auto-generation from the current webpage's title, headings, detected domain, and salient terms. When a website has no prompt, the content script asks whether to generate one before analyzing.
- Page-level analysis cache. Parsed S/A/B/C results are saved locally and restored when the user returns to the same page with the same mode, stage, page prompt, auto-detected domain, and block fingerprint.
- Stage-aware scoring for beginner, course, interview, engineering, math, and research modes.
- Auto-detected mainline hints for math, machine learning, operating systems, compilers, deep learning, economics, and physics. Users guide emphasis through page-level prompts rather than a domain selector.
- S/A/B/C visual treatment:
  - S: strong highlight and pinned sidebar entry.
  - A: medium emphasis.
  - B: weak emphasis.
  - C: collapsed by default when enabled.
- Per-block guidance:
  - semantic role
  - required depth
  - whether it can be skipped now
  - future dependency
  - minimum mastery standard
  - continue-or-stop recommendation
- On-page dependency graph in the sidebar.

## Notes

This version supports a real LLM when configured in the extension settings. If no model is configured, or the model request fails, it falls back to the deterministic local heuristic engine.

PDF support is a local MVP. It works best for text PDFs with extractable embedded text. Scanned PDFs, heavily encoded academic PDFs, and PDFs blocked by site permissions may need a future pdf.js-based parser.
