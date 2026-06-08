# Design Rationale

**Time spent:** approximately 2.5 hours.
**Models:** `claude-sonnet-4-6` (Q&A agent), `claude-haiku-4-5-20251001` (eval judges).

---

## Scope

- **CLI over notebook** — clean, repeatable output without notebook state management.
- **MediaWiki API over a local dump** — no setup beyond HTTP; sufficient for a PoC where retrieval sophistication isn't the focus.
- **TypeScript** — personal preference; Anthropic SDK has strong TypeScript support. (Initial Python scaffolding was redirected.)
- **Eval depth over retrieval depth** — given the stated goal, eval design was the primary investment. Retrieval was kept intentionally thin.

---

## System Design

Claude runs in an agentic loop with a `search_wikipedia(query: str)` tool until it produces a final answer. Wikipedia content is passed as a `document` block with `citations: { enabled: true }`, enabling the Anthropic citations API — the model produces structured citation metadata (exact quoted passages and character offsets) rather than relying on text-level attribution alone. The CLI shows the cited article URL when structured citations are present.

Retrieval calls the MediaWiki API in two steps: a full-text search for candidate titles, then a fetch of the first non-disambiguation result (up to 4,000 characters). The system prompt is marked with `cache_control: { type: "ephemeral" }` for Anthropic's server-side prompt caching.

---

## Iterations

### Round 1: Citation gap → system prompt update

The first eval run used a minimal system prompt with no citation or conciseness guidance. The model answered correctly but almost never named the Wikipedia source, scoring 1/2 on Answer Quality in nearly every search-using case. Added explicit attribution instruction: "cite the Wikipedia article by name — e.g. 'According to the Wikipedia article on X...'". Quality scores improved across the board.

### Round 2: Conciseness prompt → citation regression → immediate fix

Added "quote only the passages directly relevant to the question" to address verbose answers. A smoke test immediately showed structured citation counts dropped to zero: the "minimize quoting" instruction was suppressing the citations API, which works by the model naturally drawing from document blocks. The phrase was removed before any eval was run. This was a clear example of a prompt change with an unintended semantic conflict — a quick regression test caught it before it contaminated results.

The citation instruction was also made conditional: "when you search and find relevant content, cite by name; if you answer from your own knowledge without searching, do not attribute your answer to Wikipedia." Without this, the model applied the citation style unconditionally and fabricated "According to the Wikipedia article on X..." even when no search had occurred.

### Round 3: Wikipedia rate limiting → delays and retry logic

Running cases back-to-back triggered Wikipedia's rate limiter, causing cascading search failures and answers like "I'm having trouble reaching Wikipedia." Increased inter-request delay from 500ms to 1500ms and added 2-retry exponential backoff. Also added 1.2–1.8s jitter between eval cases to stay under Haiku's 50 RPM judge limit. Both fixes were mechanical responses to observable eval infrastructure failures, not prompt engineering work.

### Round 4: Redundant search loops → search cap and tool description guidance

Evals showed the model sometimes issued 7–8 near-identical queries when Wikipedia was slow — a polling loop rather than a genuine reasoning chain. Two changes: added "use at most 3 searches; avoid repeating similar queries" to the tool description (soft nudge), and enforced a hard cap in code — on a 4th search attempt, the model receives "Search limit reached — answer using what you have." Both were needed: the description reduced loops before they hit the cap; the cap provided a guaranteed ceiling.

**Design constraint noted:** the cap of 3 is appropriate for my eval set but limits genuinely complex multi-hop chains. Noted in "What I'd Do Next."

### Round 5: Local cache → removed

An agent-response cache was added to `.cache/` (keyed by a hash of question + system prompt) for development convenience. On review, this was identified as the wrong layer for two reasons: (1) the original request was for Anthropic API prompt caching, not filesystem response caching, and (2) eval results mixing cached and fresh responses give a misleading pass rate — you're measuring a blend of old and current system behavior. The cache was removed entirely. Anthropic-side prompt caching via `cache_control` was already in place.

A related bug was also fixed: when Wikipedia requests failed, the agent's "Based on my knowledge..." fallback was being cached and served indefinitely, preventing retries. The cache was updated to skip any result with a Wikipedia failure before it was removed entirely.

### Round 6: `requires_search` → removed

Every test case had a `requires_search: boolean` field that told the judge whether a search was expected. This caused the Search Appropriateness judge to penalize the model for correctly answering a factual question from training data without searching — which is often a perfectly reasonable decision. The field was encoding a pre-baked judgment that belongs to the judge, not the test case. It was removed; the judge now reasons from the question itself, with latitude for factual questions and strict expectations only for clearly non-encyclopedic ones.

### Round 7: Judge improvements

Several judge-level improvements were made in response to observable failures:

- **Zod validation** on judge output — Haiku occasionally returned malformed or non-JSON responses that were silently coerced to `score: 1`. Zod catches bad output explicitly with a descriptive error.
- **Unknown escape hatch** — judges were forced to score even when context was insufficient (e.g., faithfulness when all Wikipedia requests failed). Added `{"score": null}` as a valid return, applied after reading Anthropic's eval blog post which specifically recommends giving LLM judges a way out.
- **Citation count → cited passages** — the quality judge was told "the model produced N citations" but couldn't see them, causing it to score 0 for "no visible citations" even when attribution was clear in the answer text. Changed to passing the actual quoted passages so the judge can verify grounding directly.
- **Quality judge sub-dimensions made explicit** — clarity, citation attribution, and calibration are now called out separately in the rubric. Previously bundled without names, which led to inconsistent scoring.

### Round 8: Test case evolution

The initial suite of 26 cases (simple_factual, multi_hop, comparative, no_search_needed, calibration, edge_case, retrieval_probe) was skewed toward cases the system handled easily. After several eval runs, it was clear the cases weren't surfacing interesting failures — I was iterating on infrastructure and judge plumbing rather than learning anything about model behavior.

Four new categories were added:

- **`false_premise`** — questions with incorrect assumptions the model should correct rather than answer at face value (Napoleon "winning" Waterloo; Einstein "failing" math; Venus having moons).
- **`misleading`** — questions presupposing a common myth (Great Wall visible from space; Napoleon's height).
- **`synthesis`** — questions requiring information from two distinct Wikipedia articles combined in a non-obvious way (Darwin and Lincoln sharing a birthday; the Titanic using radio).
- **`epistemic_limits`** — questions where the answer is genuinely uncertain or unknowable, testing whether the model hedges or confabulates (Caesar's last words; the boiling point of astatine).

Additional case hygiene improvements: several cases had `null` expected answers when they had specific, knowable correct answers derivable from Wikipedia — these were filled in. The suite was pruned to ≤3 cases per category to reduce run time and avoid over-indexing on any single failure mode. Cases were renumbered to be sequential within each category.

### Round 9: System prompt restructured + tool description improved

The original system prompt mixed answer quality guidance with tool usage instructions. These were separated: the system prompt now owns only answer quality concerns (length calibration, epistemic honesty, citation attribution), and the tool description owns all tool-specific guidance (what it returns, when to use it, disambiguation strategy).

Key changes to the system prompt:
- **Length calibration split by question type** — simple factual questions get 1–2 sentences; contested or uncertain questions are explicitly allowed to be as long as needed. The previous "1–3 sentences" cap was suppressing nuance on calibration and epistemic cases.
- **Explicit epistemic guidance** — "say 'I don't know' when appropriate" with concrete examples of when precision is impossible. This is distinct from hedging; it tells the model when to stop rather than when to qualify.
- **Conditional citation instruction** — "do not attribute answers to Wikipedia if you didn't search." Removed the text attribution instruction ("According to the Wikipedia article on X...") entirely, since structured citations handle attribution when the API fires.

Key changes to the tool description:
- Added what the tool returns (single article, truncated at ~4,000 characters, disambiguation auto-skipped) so the model understands its retrieval budget.
- Added concrete disambiguation examples ("jaguar animal speed" not "jaguar speed") rather than the abstract "be specific."
- The search cap was raised from 3 to 10 in code, and the prescriptive "try one different query" advice was removed — that's agent behavior, not tool behavior.

### Round 10: Structured outputs + sharpened judge rubrics

All four judges were updated:

**Structured outputs** — replaced JSON prompt instructions with a `submit_score` tool that the model is forced to call via `tool_choice: { type: "tool", name: "submit_score" }`. This eliminated all "Could not parse judge response" failures — the API guarantees the output structure.

**Sharpened rubrics** — the core problem was that 1 and 2 were hard to distinguish. The rubrics were rewritten to make the 1/2 boundary explicit for each dimension:
- *Correctness*: 1 = core fact right but misses nuance the expected answer specifies; 2 = correct on all key facts AND captures the nuances.
- *Faithfulness*: 1 = core claims supported but answer adds context beyond citations; 2 = every significant claim maps directly to the cited passages.
- *Search Appropriateness*: 1 = right call on whether to search, but redundant or vague queries; 2 = right call AND efficient, non-redundant queries.
- *Answer Quality*: 1 = "this is disputed" or "we don't know" without explanation; 2 = explains WHY, enumerates competing views, corrects misconceptions. Citation was removed from this dimension since it's now handled by the structured citations API rather than prompt instruction.

---

## Eval Suite

32 test cases across 11 categories (≤3 per category):

| Category | What it tests |
|---|---|
| `simple_factual` | Basic date/name/place lookups |
| `multi_hop` | Two-step reasoning chains |
| `comparative` | Questions requiring two searches and synthesis |
| `no_search_needed` | Math, definitions — model should not search |
| `calibration` | Contested or measurement-dependent facts requiring hedging |
| `edge_case` | Ambiguous queries, fictional entities, time-sensitive facts |
| `retrieval_probe` | Disambiguation risks where the obvious query returns the wrong article |
| `false_premise` | Questions with incorrect assumptions — model should correct, not answer at face value |
| `misleading` | Questions presupposing a common myth — model should push back with evidence |
| `synthesis` | Requires combining two distinct Wikipedia articles in non-obvious ways |
| `epistemic_limits` | Answers that are genuinely uncertain — model should hedge rather than confabulate |

### Judging Dimensions

Four dimensions, each scored 0–2 by Claude Haiku via forced tool call (`submit_score`):

- **Correctness** — does the answer match the expected fact and capture its nuances? For open-ended cases, evaluates accuracy and completeness of reasoning.
- **Faithfulness** — are claims grounded in retrieved content? Uses cited passages when structured citations are available; falls back to full article text otherwise. `N/A` when no search was performed; `Unknown` when all Wikipedia requests failed.
- **Search Appropriateness** — was the search decision sound AND efficiently executed? Right call with redundant queries scores 1; right call with well-targeted queries scores 2.
- **Answer Quality** — clarity, appropriate detail for the question type, and calibration depth. 1 = adequate hedging; 2 = explains the epistemic situation (why uncertain, what IS known, corrections to misconceptions).

A case **passes** at ≥ 75% of its maximum possible score.

---

## Final Eval Results

**87.5% pass rate (28/32).** The drop from earlier runs (93.8%) reflects more discriminating judges rather than system regression — the sharpened rubrics are catching real gaps that were previously masked by lenient 1/2 distinctions.

Failures:
- **`misleading-001` and `misleading-002`** (Great Wall / Napoleon height): both cases exhausted all 10 searches without producing an answer. The myth debunking doesn't live in the primary article for either subject — the model kept reformulating queries without finding the right page. Retrieval architecture failure, not a reasoning failure.
- **`edge-001`** (Python): the model hallucinated a non-existent Python version ("3.14.5 as of May 2026"), caught by the correctness judge.
- **`calibration-002`** (tallest mountain): persistent — the model always answers Everest without acknowledging the measurement-dependency. The search appropriateness judge also penalised three near-identical queries.

---

## What I'd Do Next

**Improve search efficiency.** The misleading category failures exposed that the model issues redundant queries when Wikipedia doesn't immediately return the right article — 10 near-identical reformulations of the same question rather than strategically different angles. Several approaches worth exploring: feeding back to the model which articles it has already retrieved so it can avoid redundancy; a two-phase approach (search for candidate titles first, then fetch the most relevant one); or exposing article summaries before full content so the model can decide whether to fetch. The current architecture gives the model no signal about what it has already tried.

**Revisit the pass threshold and add harder cases.** At 87.5% with more discriminating judges, there's still room before saturation but less than before. The 75% threshold is somewhat arbitrary and should be validated against human judgment. Harder cases — myth debunking that requires navigating to a specific Wikipedia sub-article, questions requiring synthesis across 3+ articles, adversarial false premises with plausible-sounding supporting context — would increase eval headroom.

**Probe contentious and politically sensitive questions.** I haven't tested questions where the "correct" answer is inherently contested along political or values lines — questions about ongoing conflicts, causal attribution for historical events, policy questions. The key design question is whether the tool should explicitly refuse these or rely on the base model's existing safety training. The base model has good default behavior, but a tool explicitly designed to retrieve and synthesise information from Wikipedia may have different affordances than a general assistant — worth testing explicitly.

**Human calibration of judges.** Haiku's scores are internally consistent but not externally validated. The right approach is to hand-label ~30 cases across all four dimensions and measure agreement. Without this, pass rate is a relative number, not an absolute one.

**pass@k metrics for consistency.** Running each question once doesn't distinguish "reliably correct" from "got lucky." pass@k and pass^k would reveal which categories are robust vs. stochastic — especially relevant for calibration and epistemic_limits where hedging behaviour varies run-to-run.

**Citation reliability in multi-turn conversations.** Structured citations are inconsistently produced when documents span multiple tool call turns. Worth investigating whether document position in conversation history affects citation production, and whether restructuring — collecting all retrieved documents before a final synthesis turn — improves consistency.
