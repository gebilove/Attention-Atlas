# Attention Atlas

[中文说明](README.zh-CN.md)

![Attention Atlas promotional image](assets/attention-atlas-hero-en.png)

Attention Atlas is a browser extension for academic and technical reading. It does not try to summarize everything on a page. Its core job is learning attention allocation: mapping which knowledge blocks deserve deep study, which can be skimmed, which can wait, and which are safe to skip for your current goal.

The extension is designed for high-intensity learners working through courses, papers, textbooks, PDFs, documentation, proofs, and implementation-heavy material. It marks page-level knowledge blocks, ranks them with S/A/B/C attention levels, and explains the minimum mastery needed to keep moving.

## Why this exists

Long learning materials are full of traps: interesting details that do not matter yet, proofs that only matter after the main idea is stable, examples that are essential for intuition, and definitions that block every later chapter. Attention Atlas helps decide where attention is worth spending now.

## Attention levels

- `S`: must understand now. In learning mode, S-level blocks require an active recall answer before they can be marked as mastered.
- `A`: important for the current goal and worth careful reading.
- `B`: useful context, but not the main bottleneck.
- `C`: low priority now. These blocks can be collapsed automatically.

Each analyzed block can include its semantic role, required depth, skip recommendation, future dependency, minimum mastery standard, and continue-or-stop guidance.

## Modes

- Learning mode: for courses, textbooks, papers, PDFs, docs, and systematic study. It keeps a per-page checklist and uses active recall for S-level blocks.
- Surfing mode: for news, blogs, public articles, and background browsing. It highlights what deserves attention without asking mastery questions.

![Attention Atlas feature workflow](assets/attention-atlas-flow-en.png)

## Current MVP

- Segments DOM pages into knowledge blocks such as paragraphs, lists, code, formulas, tables, headings, blockquotes, and proof-like regions.
- Supports directly reachable text PDFs through a local MVP parser and renders them into readable learning blocks.
- Uses a user-configured LLM for S/A/B/C attention allocation.
- Supports OpenAI Chat Completions and Anthropic Messages.
- Lets users define global prompts and website-level prompts.
- Can auto-generate a website prompt from the current page title, headings, domain, and salient terms.
- Caches page analysis by URL, mode, stage, prompt, detected domain, and block fingerprint.
- Shows an LLM-returned page mainline and dependency graph in the sidebar.

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose `Load unpacked`.
4. Select this repository folder.

## Configure the LLM

Open the extension settings and choose a provider:

- OpenAI: uses Chat Completions with `Authorization: Bearer`.
- Anthropic: uses Messages API with `x-api-key` and `anthropic-version`.

The API key stays in extension storage and requests are sent from the background service worker, not injected into the page.

## Development

```bash
npm run debug:loop
```

The debug loop checks the MV3 manifest, runs syntax checks, launches a browser with the unpacked extension, opens a test page, verifies content-script rendering, and reports runtime errors.

See [docs/architecture.md](docs/architecture.md) and [docs/debug-workflow.md](docs/debug-workflow.md) for implementation details.

## Notes

This version always uses the configured LLM for attention allocation. If the model request fails or returns invalid JSON, the extension shows an error instead of falling back to local heuristics.

PDF support is an MVP. It works best for text PDFs with extractable embedded text. Scanned PDFs, heavily encoded academic PDFs, and PDFs blocked by site permissions will need a future pdf.js-based parser.
