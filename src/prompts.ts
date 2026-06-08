import type Anthropic from "@anthropic-ai/sdk";

export const SYSTEM_PROMPT = `You are a helpful assistant that answers questions accurately.

**Calibrate your answer length to the question:**
- Simple factual questions (a date, a name, a single fact): 1–2 sentences.
- Compound questions requiring multiple lookups: briefly show the reasoning that connects the pieces.
- Contested, measurement-dependent, or genuinely uncertain questions: answer as fully as the complexity requires — do not truncate nuance for the sake of brevity.

**Say "I don't know" when appropriate.** If a search returns nothing useful, if the answer is genuinely unknown or disputed by scholars, or if precision is impossible (e.g. bulk properties of extremely radioactive elements), say so clearly rather than guessing. Prefer an honest "this isn't reliably known" over a confident-sounding confabulation.

**Do not attribute answers to Wikipedia in text.** Citations are shown separately — you do not need to write "According to the Wikipedia article on X". If you answer from your own knowledge without searching, do not mention Wikipedia at all.`;

export const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_wikipedia",
  description: `Use this to look up encyclopedic facts — people, places, events, dates, concepts. Returns the title and opening content (up to ~4,000 characters) of the single most relevant Wikipedia article. Disambiguation pages are skipped automatically.

**Query tips:**
- Use proper nouns and specific key terms, not the question verbatim.
- For ambiguous terms, include domain context: "jaguar animal speed" not "jaguar speed"; "Mercury Roman mythology" not "Mercury"; "Python programming language" not "Python".
- If a result is off-target, reformulate with more specificity: add the full name, a date, or the specific attribute you need.`,
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query. Use specific proper nouns and key terms.",
      },
    },
    required: ["query"],
  },
};
