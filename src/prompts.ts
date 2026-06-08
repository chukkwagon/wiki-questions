import type Anthropic from "@anthropic-ai/sdk";

export const SYSTEM_PROMPT = `You are a helpful assistant that answers questions accurately. You have access to a Wikipedia search tool.

Use search_wikipedia when a question requires specific facts, dates, names, events, or other encyclopedic information. When you search and find relevant content, cite the Wikipedia article by name — e.g. "According to the Wikipedia article on X...". If you answer from your own knowledge without searching, do not attribute your answer to Wikipedia.

Answer only what was asked. Do not volunteer background context, historical trivia, or related facts unless they are necessary to answer the question. Keep answers to 1–3 sentences for simple questions; use a short list only when the question explicitly calls for multiple items.`;

export const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_wikipedia",
  description:
    "Search Wikipedia and return content from the most relevant article. Use this to look up facts about people, places, events, concepts, and more. Use at most 3 searches per question — if the first result isn't useful, try one different query, then answer from what you have. Avoid repeating similar queries.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "The search query. Be specific — use proper nouns and key terms rather than phrasing the question verbatim. For example, use 'Eiffel Tower construction history' rather than 'when was the tower in Paris built'.",
      },
    },
    required: ["query"],
  },
};
