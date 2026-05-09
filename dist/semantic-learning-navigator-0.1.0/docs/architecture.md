# Semantic Learning Navigator Architecture

## Product Boundary

The extension is a learning attention allocation system. It should not optimize for summarizing a page. Its central output is a decision about how much attention a learner should spend on each knowledge block at the current learning stage.

## Pipeline

```text
Browser Extension
  -> DOM knowledge block segmentation
  -> Knowledge structure positioning
  -> Stage-aware learning priority
  -> Dependency graph construction
  -> Page rendering and sidebar guidance
```

## Block Schema

Each analyzed block should produce:

```json
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
```

## Analyzer Contract

The current MVP uses a deterministic local analyzer in `src/content.js`. It is intentionally shaped as a replaceable function:

```js
analyzeBlock(block, stage, domain)
```

A model-backed analyzer should preserve this contract and change only the implementation behind it. The model prompt should ask for knowledge structure positioning, not summary:

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

## Domain Mainlines

The built-in mainlines are deliberately compact:

- Math: 定义 -> 直觉 -> 定理 -> 推导
- Machine learning: 数据 -> 损失 -> 优化 -> 泛化
- Operating systems: 抽象 -> 调度 -> 内存 -> 并发
- Compilers: Token -> AST -> IR -> 优化
- Deep learning: 表示 -> 反向传播 -> 架构
- Economics: 激励 -> 均衡 -> 博弈
- Physics: 守恒 -> 状态 -> 演化
- Reinforcement learning: 状态/动作 -> 价值函数 -> Bellman -> TD -> 策略改进

## Rendering Rules

- S: strong highlight and pinned sidebar entry.
- A: medium emphasis.
- B: weak emphasis.
- C: collapsible and visually de-emphasized.

The UI marks knowledge blocks, not words. Blocks include paragraphs, headings, list items, code blocks, formula regions, tables, blockquotes, and proof-like areas.
