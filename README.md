# wiki-questions

A CLI that uses Claude and Wikipedia to answer questions, with an evaluation suite measuring answer quality across multiple dimensions.

## Setup

**Prerequisites:** Node.js 20.6+

```bash
npm install
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
```

## Usage

### Demo

```bash
npm run demo
```

Runs two pre-defined example queries to show the system working end-to-end.

### Ask a question

```bash
npm run ask -- "What year was the Eiffel Tower completed?"
npm run ask -- "What country was the inventor of the telephone born in?"
npm run ask -- "Which is taller, the Eiffel Tower or the Statue of Liberty?"
```

### Run the eval suite

```bash
npm run eval
```

## How it works

Claude receives a `search_wikipedia(query: str)` tool and decides when to use it. The agent loop runs until Claude produces a final answer, executing any Wikipedia searches along the way.

**Retrieval:** MediaWiki REST API — no local data required. Each search fetches up to 3 article candidates and returns the first non-disambiguation result (up to 4,000 characters of plain text). Requests are spaced 1.5s apart with automatic retry to stay within Wikipedia's rate limits.

**Citations:** Wikipedia content is passed to Claude as a `document` block with `citations: { enabled: true }`. When Claude cites a passage, the response includes structured citation metadata (exact quoted text + character offsets into the source article). Cited article URLs are shown in the CLI output.

**Models:** `claude-sonnet-4-6` for the Q&A agent, `claude-haiku-4-5-20251001` for eval judges.

**Prompt caching:** The system prompt is marked with `cache_control: { type: "ephemeral" }`, enabling Anthropic's prompt caching. This avoids re-processing the system prompt on repeated requests within the 5-minute cache window.

## Eval suite

32 test cases across 11 categories: `simple_factual`, `multi_hop`, `comparative`, `no_search_needed`, `calibration`, `edge_case`, `retrieval_probe`, `false_premise`, `misleading`, `synthesis`, `epistemic_limits`.

Each case is scored by a Claude Haiku judge on 4 dimensions (0–2 each):

| Dimension | What it measures |
|---|---|
| **Correctness** | Does the answer match the expected fact? |
| **Faithfulness** | Are claims grounded in cited passages or retrieved content? (N/A when no search) |
| **Search Appropriateness** | Did the agent search when needed, skip when not, and use targeted queries? |
| **Answer Quality** | Is the answer clear, concise, attributed, and appropriately hedged on contested claims? |

Scores of `null` indicate the judge couldn't evaluate the dimension (e.g. faithfulness when all Wikipedia requests failed). A case **passes** if it scores ≥ 75% of its maximum possible points.

Judge output is validated with [Zod](https://zod.dev) to catch malformed responses. Results are printed live as they complete, with a pass-rate summary at the end. Full results saved to `eval/results/<timestamp>.json`.
