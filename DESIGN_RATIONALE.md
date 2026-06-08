# Design Rationale

## Overview

This project is a Wikipedia Q&A CLI built with Claude and the Anthropic API. The system accepts natural language questions, decides whether to search Wikipedia, retrieves relevant content, and returns a grounded answer with source attribution. An LLM-as-judge eval suite measures answer quality across four dimensions.

**Time spent:** approximately 90 minutes.

**Model used:** `claude-sonnet-4-6` for the Q&A agent, `claude-haiku-4-5-20251001` for eval judges.

---

## Scope Decisions

Several scoping calls shaped the entire project before a line of code was written.

**CLI over notebook.** The assignment allows a CLI, notebook, or script. A CLI was chosen for simplicity and reviewability — it produces clean, repeatable output without notebook state management.

**MediaWiki API over a local dump.** The assignment explicitly allows a live API. The Wikipedia MediaWiki API requires no setup beyond HTTP and returns structured plain text, making it the right call for a time-boxed project. The retrieval implementation was intentionally kept thin; the eval suite was the primary investment.

**Eval suite as the priority.** Given the stated goal of demonstrating prompt engineering and evaluation judgment, the decision was made early to invest in eval design depth rather than retrieval sophistication. This shaped every subsequent trade-off.

**TypeScript over Python.** The initial scaffolding was redirected to TypeScript to match personal preference and toolchain comfort. The Anthropic SDK has strong TypeScript support.

---

## System Design

### Agent Loop

Claude receives a `search_wikipedia(query: str)` tool and decides when to use it. The agent loop runs until `stop_reason === "end_turn"`, executing any Wikipedia searches along the way. The tool description includes explicit guidance:

- Use at most 3 searches per question
- Avoid repeating similar queries
- Answer from what's been retrieved if searches aren't converging

A **hard cap of 3 searches** is enforced in code: if the model attempts a 4th search, it receives "Search limit reached. Please answer using the information already retrieved." This was added after evals revealed the model sometimes issued 7–8 near-identical queries when Wikipedia was slow to respond — a redundant loop rather than a genuine reasoning chain.

**Design constraint:** The cap of 3 is appropriate for simple-to-moderate questions but would limit genuinely complex multi-hop reasoning chains (e.g., questions requiring 3+ distinct lookup steps with no room for a retry). For a production system, a higher cap or dynamic search budget would be preferable.

### Wikipedia Retrieval

The MediaWiki API is called in two steps: a full-text search returns up to 3 candidate article titles, then the top non-disambiguation article is fetched as plain text (up to 4,000 characters). Requests are spaced 1.5 seconds apart with 2 retries and exponential backoff to manage Wikipedia's rate limits.

Wikipedia content is passed to Claude as a `document` block with `citations: { enabled: true }`, enabling the Anthropic citations API. When Claude draws from the retrieved content, the response includes structured citation metadata — exact quoted text and character offsets into the source article. The CLI displays the cited article's URL when structured citations are present.

### Prompt Caching

The system prompt is marked with `cache_control: { type: "ephemeral" }`, enabling Anthropic's server-side prompt caching. This avoids re-processing the system prompt on repeated requests within the 5-minute cache window, reducing both latency and input token costs on multi-turn conversations.

---

## Prompt Engineering

### System Prompt Iterations

The system prompt went through several iterations driven by eval results.

**v1 (initial):** A minimal prompt with no explicit citation or conciseness guidance. Evals showed the model consistently scored 1/2 on Answer Quality because it answered correctly but never named the Wikipedia source.

**v2 (citation instruction added):** Added explicit instruction to cite by article name ("According to the Wikipedia article on X..."). Answer Quality scores improved across simple factual cases.

**v3 (conciseness added, citations accidentally nerfed):** Added "quote only the passages directly relevant to the question" to address verbose answers. Eval smoke test showed structured citation count dropped to zero — the instruction to minimize quoting suppressed the citations API's natural behavior. The phrase was removed immediately after the regression was caught.

**v4 (final):** Retains the citation attribution style and adds conciseness guidance ("Answer only what was asked. Do not volunteer background context or historical trivia unless necessary. Keep answers to 1–3 sentences for simple questions").

### Tool Description

The tool description instructs the model on search strategy, not just capability. Adding "use at most 3 searches" and "avoid repeating similar queries" to the description reduced redundant search loops before the hard cap was even needed — the model internalized the constraint as a behavioral expectation rather than waiting to hit a wall.

---

## Eval Suite Design

### Test Cases

26 cases across 6 categories:

| Category | Count | What it tests |
|---|---|---|
| `simple_factual` | 6 | Basic date/name/place lookups |
| `multi_hop` | 3 | Two-step reasoning (identify entity, then look up attribute) |
| `comparative` | 3 | Questions requiring two searches and synthesis |
| `no_search_needed` | 3 | Math, definitions, creative tasks — model should not search |
| `calibration` | 3 | Contested or measurement-dependent facts requiring hedging |
| `edge_case` | 5 | Ambiguous queries, fictional entities, time-sensitive facts |
| `retrieval_probe` | 3 | Disambiguation risks (Python, Mercury, Jaguar) where the obvious query returns the wrong article |
| `false_premise` | 3 | Questions containing incorrect assumptions — model should correct rather than answer at face value |
| `misleading` | 2 | Questions that presuppose a common myth — model should push back with sourced evidence |
| `synthesis` | 3 | Questions requiring information from two distinct Wikipedia articles to be combined in non-obvious ways |
| `epistemic_limits` | 5 | Questions where the answer is genuinely unknown, historically uncertain, or where precision is impossible — model should hedge or admit ignorance rather than confabulate |

The `retrieval_probe` category was added mid-session after identifying the main limitation of our retrieval approach: keyword search doesn't always return the right article for ambiguous terms. These cases have concrete ground truth and documented failure modes, so the correctness and faithfulness judges catch retrieval failures cleanly.

The `calibration` category was added to test a dimension identified as a gap: does the model hedge appropriately on contested or measurement-dependent questions? Cases include the telephone invention (Bell vs. Meucci), the tallest mountain (Everest vs. Mauna Kea vs. Chimborazo by different measurements), and Pluto's planetary status.

### Judging Dimensions

Each case is scored by Claude Haiku on four dimensions (0–2 each):

**Correctness** — Does the answer match the expected fact? For cases with no single correct answer (open-ended, ambiguous, or edge cases), the judge evaluates reasonableness instead.

**Faithfulness** — Are the answer's claims grounded in what was actually retrieved? When structured citations are available, the judge evaluates whether cited passages support the claims made. When citations weren't produced but article content was retrieved, the judge compares claims against the full article text. This dimension is `N/A` when no search was performed, and `Unknown` when all Wikipedia requests failed (a network failure shouldn't penalize the model).

**Search Appropriateness** — Was the search decision sound, and were queries well-targeted? The judge reasons from the question itself rather than a pre-baked label. For clearly non-encyclopedic questions (arithmetic, creative tasks), searching scores 0. For factual questions, the model has latitude — answering correctly from training data is acceptable; the judge only penalises clear misjudgements or poor query construction.

**Answer Quality** — Three sub-dimensions bundled together: clarity/conciseness, citation attribution (text-level or structured), and calibration (appropriate hedging on contested or measurement-dependent claims). These were identified as related enough to bundle rather than score separately.

Judge output is validated with Zod (`z.number().int().min(0).max(2).nullable()`) so malformed LLM responses are caught explicitly rather than silently coerced.

Judges include an escape hatch: "If you cannot meaningfully evaluate this due to insufficient information, return `{"score": null, ...}`." This was added after the blog post ["Demystifying Evals for AI Agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) highlighted that LLM judges should have a way out rather than being forced to score when context is insufficient. In practice this fires on faithfulness when Wikipedia was unreachable — returning `null` is more honest than scoring 0 or 1 on a dimension that genuinely can't be evaluated.

A case **passes** if it scores ≥ 75% of its maximum possible points. The maximum varies per case (8 for search-using cases, 6 for no-search cases where faithfulness is N/A).

---

## What We Learned from Evals

### Citation behavior without explicit instruction

The first eval run (with a minimal system prompt) showed that the model consistently answered correctly but almost never named the Wikipedia source. The quality judge scored most cases 1/2 with reasoning like "fails to cite the Wikipedia article by name despite a search being conducted." This was a reliable, repeatable signal — not noise — and directly prompted the system prompt update.

### The model handles no-search cases correctly without being told

All three `no_search_needed` cases (math, photosynthesis explanation, HTTP acronym) scored 2/2 on Search Appropriateness without any explicit instruction not to search. This was a useful baseline: the model's default behavior is already calibrated for obvious no-search cases. Explicit instruction in the system prompt was reserved for improving citation behavior, where the default was clearly insufficient.

### Calibration is hit-or-miss without prompting

`calibration-002` (tallest mountain) consistently scored 1/2 on Correctness because the model stated "Mount Everest is the tallest mountain" without acknowledging that "tallest" is measurement-dependent. The calibration cases were specifically designed to catch this, and they did. The answer quality rubric also penalizes overconfident claims on contested topics, creating a second signal.

### Wikipedia rate limiting is a real operational constraint

Running 26 cases back-to-back without a delay triggered Wikipedia's rate limiter, causing cascading search failures. This appeared in evals as many `[Unknown] All Wikipedia requests failed` faithfulness scores and answers that said "I'm having trouble reaching Wikipedia." The fix was increasing inter-request delay to 1.5 seconds with retry logic — but the underlying fragility of depending on a public API with no authentication is a genuine production concern.

### The quality judge was confused by citation metadata vs. text attribution

After integrating the citations API, the judge prompt passed "The model produced N inline citation(s)" as context. The judge interpreted this as a claim about the answer text and looked for citation markers that weren't visually present — scoring 0/2 for "no citations visible" even when the answer had clear text attribution. The fix was replacing the citation count with the actual cited passages, letting the judge verify grounding directly.

### The citations API is inconsistent in multi-turn tool-use conversations

Structured citation objects (with character offsets into the source document) are reliably produced for single-search responses but inconsistently produced when multiple tool calls occur across several conversation turns. The Anthropic docs confirm documents in tool results are citable (document indices span all messages), but the model's behavior varies. The faithfulness judge handles this by falling back to full article content comparison when no structured citations are present. This is noted as a behavioral quirk rather than an API limitation.

---

## What We'd Do Next

**Human calibration of judges.** The eval blog post stresses that LLM judges should be calibrated against human graders before their scores are trusted. We haven't done this. In practice it would mean hand-labeling 20–30 cases across all four dimensions and measuring agreement with Haiku's scores.

**pass@k metrics.** Running each question once doesn't distinguish "reliably correct" from "got lucky." Pass@k (at least one success in k runs) and pass^k (all k runs succeed) would give a better picture of consistency — especially important for the calibration cases where hedging behavior is stochastic.

**Higher search cap or dynamic search budgeting.** The cap of 3 handles our eval set but would limit genuinely complex multi-hop reasoning. A production system would want either a higher cap (4–5) or a mechanism where the model signals "I need another search to complete this chain" rather than hitting a blunt limit.

**Disambiguation handling.** Our retrieval currently skips disambiguation pages and tries the next candidate. For the `retrieval_probe` cases, this worked — "Python" skipped the disambiguation page and landed on the programming language article. But a more robust approach would detect when the returned article doesn't match the intent and retry with a more specific query.

**Citation reliability in multi-turn conversations.** Investigate whether document position in conversation history (earlier vs. later tool results) affects citation production, and whether restructuring the conversation (e.g., collecting all documents before the final turn) improves consistency.

**Cached Wikipedia content.** The current implementation fetches Wikipedia on every question (modulo our agent cache). A production system would maintain a local index or use a mirror API with authentication to avoid rate limits and improve latency.
