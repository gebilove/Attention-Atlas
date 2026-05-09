# Semantic Learning Navigator

Semantic Learning Navigator is a browser extension MVP for learning attention allocation. It marks page-level knowledge blocks, ranks them by learning importance, and explains whether a learner should deeply understand, skim, defer, or skip a block for the current stage.

## Load locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select this folder.

## Current MVP

- DOM knowledge block segmentation for paragraphs, lists, code, formulas, tables, headings, blockquotes, and proof-like regions.
- Stage-aware scoring for beginner, course, interview, engineering, math, and research modes.
- Domain-aware mainline hints for math, machine learning, operating systems, compilers, deep learning, economics, physics, and auto mode.
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

This version runs fully locally with a deterministic semantic heuristic engine. The analyzer is intentionally structured so a model-backed "knowledge structure positioning" service can later replace `analyzeBlock` without changing the renderer.
