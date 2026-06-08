import Anthropic from "@anthropic-ai/sdk";
import { searchWikipedia, type WikiArticle } from "./wikipedia.js";
import { SYSTEM_PROMPT, SEARCH_TOOL } from "./prompts.js";

const client = new Anthropic();

const MAX_ITERATIONS = 10;
const MAX_SEARCHES = 10;

// Matches the CitationCharLocation shape the API returns for plain-text documents.
export interface Citation {
  type: string;
  cited_text: string;
  document_title: string | null;
  document_index: number;
  start_char_index: number;
  end_char_index: number;
}

export interface ToolCall {
  query: string;
  article: WikiArticle | null;
  error: string | null;
}

export interface AgentResult {
  question: string;
  answer: string;
  citations: Citation[];
  toolCalls: ToolCall[];
}

function extractCitations(content: Anthropic.ContentBlock[]): Citation[] {
  return content.flatMap((b) => {
    if (b.type !== "text") return [];
    const citations = (b.citations ?? []) as unknown as Citation[];
    return citations;
  });
}

export async function ask(question: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  const toolCalls: ToolCall[] = [];
  let citations: Citation[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [SEARCH_TOOL],
      messages,
    });

    citations = extractCitations(response.content);

    if (response.stop_reason === "end_turn") {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      return { question, answer, citations, toolCalls };
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use" && block.name === "search_wikipedia") {
          const query = (block.input as { query: string }).query;

          // Hard cap — tell the model to synthesize from what it has
          if (toolCalls.length >= MAX_SEARCHES) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Search limit reached. Please answer using the information already retrieved.",
            });
            continue;
          }

          const result = await searchWikipedia(query);

          if (typeof result === "string") {
            toolCalls.push({ query, article: null, error: result });
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          } else {
            toolCalls.push({ query, article: result, error: null });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: [
                {
                  type: "document",
                  source: { type: "text", media_type: "text/plain", data: result.content },
                  title: result.title,
                  citations: { enabled: true },
                },
              ] as any,
            });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  return {
    question,
    answer: "Error: agent exceeded maximum iterations without a final answer.",
    citations: [],
    toolCalls,
  };
}
