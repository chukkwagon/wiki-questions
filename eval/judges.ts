import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolCall, Citation } from "../src/agent.js";

const client = new Anthropic();

const JudgeScoreSchema = z.object({
  score: z.number().int().min(0).max(2).nullable(),
  reasoning: z.string(),
});

export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

export interface Scores {
  correctness: JudgeScore | null;   // null = N/A (no expected answer context)
  faithfulness: JudgeScore | null;  // null = N/A (no search performed)
  searchAppropriateness: JudgeScore;
  answerQuality: JudgeScore;
}

const UNKNOWN_ESCAPE =
  `If you cannot meaningfully evaluate this due to insufficient information, return {"score": null, "reasoning": "<explanation>"}.`;

async function judge(prompt: string): Promise<JudgeScore> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { score: null, reasoning: "Could not parse judge response" };

  try {
    const result = JudgeScoreSchema.safeParse(JSON.parse(match[0]));
    if (!result.success) return { score: null, reasoning: `Schema validation failed: ${result.error.issues[0]?.message}` };
    return result.data;
  } catch {
    return { score: null, reasoning: "Could not parse judge response" };
  }
}

export async function scoreCorrectness(
  question: string,
  expectedAnswer: string | null,
  actualAnswer: string
): Promise<JudgeScore> {
  if (expectedAnswer === null) {
    return judge(`You are evaluating an AI assistant's answer where there is no single correct answer.

Question: ${question}
Answer: ${actualAnswer}

Score whether this answer is reasonable, accurate, and useful:
- 0: Answer is clearly wrong, harmful, or completely off-topic
- 1: Answer is plausible but imprecise, incomplete, or could mislead
- 2: Answer is accurate, reasonable, and genuinely useful
${UNKNOWN_ESCAPE}

Return JSON only: {"score": <0|1|2|null>, "reasoning": "<one sentence>"}`);
  }

  return judge(`You are evaluating whether an AI assistant answered a factual question correctly.

Question: ${question}
Expected answer: ${expectedAnswer}
Actual answer: ${actualAnswer}

Score correctness:
- 0: Answer is wrong or directly contradicts the expected answer
- 1: Answer contains the right information but is incomplete or includes inaccuracies
- 2: Answer is fully correct and captures the key fact(s)
${UNKNOWN_ESCAPE}

Return JSON only: {"score": <0|1|2|null>, "reasoning": "<one sentence>"}`);
}

export async function scoreFaithfulness(
  question: string,
  toolCalls: ToolCall[],
  actualAnswer: string,
  citations: Citation[]
): Promise<JudgeScore | null> {
  if (toolCalls.length === 0) return null;

  // Prefer citations — they're the exact passages the model claimed to use.
  if (citations.length > 0) {
    const citedPassages = citations
      .map((c) => `"${c.cited_text}" (from: ${c.document_title})`)
      .join("\n");

    return judge(`You are evaluating whether an AI assistant's claims are supported by the passages it cited from Wikipedia.

Question: ${question}

Passages cited by the model:
${citedPassages}

Answer given:
${actualAnswer}

Score faithfulness — do the cited passages actually support the claims made?
- 0: Key claims in the answer are not reflected in or are contradicted by the cited passages
- 1: Most claims are supported but some details go beyond what the cited passages say
- 2: The claims in the answer are well-supported by the cited passages
${UNKNOWN_ESCAPE}

Return JSON only: {"score": <0|1|2|null>, "reasoning": "<one sentence>"}`);
  }

  // Fall back to full article content when no structured citations were produced.
  const retrieved = toolCalls
    .filter((tc) => tc.article !== null)
    .map((tc) => `[Query: "${tc.query}"]\n**${tc.article!.title}**\n${tc.article!.content}`)
    .join("\n\n---\n\n");

  if (!retrieved) {
    // Search was attempted but all requests failed — faithfulness genuinely unknown.
    return { score: null, reasoning: "All Wikipedia requests failed; faithfulness cannot be assessed." };
  }

  return judge(`You are evaluating whether an AI assistant's answer is grounded in the Wikipedia content it retrieved.

Question: ${question}

Retrieved Wikipedia content:
${retrieved}

Answer given:
${actualAnswer}

Score faithfulness — are the answer's claims supported by the retrieved content?
- 0: Answer makes significant claims not found in or contradicted by the retrieved content
- 1: Answer is mostly grounded but contains minor extrapolations or details not in the retrieved content
- 2: All key claims in the answer are directly supported by the retrieved content
${UNKNOWN_ESCAPE}

Return JSON only: {"score": <0|1|2|null>, "reasoning": "<one sentence>"}`);
}

export async function scoreSearchAppropriateness(
  question: string,
  toolCalls: ToolCall[]
): Promise<JudgeScore> {
  const queriesUsed =
    toolCalls.length === 0
      ? "None — no searches were performed."
      : toolCalls.map((tc) => `"${tc.query}"`).join(", ");

  return judge(`You are evaluating whether an AI assistant used its Wikipedia search tool appropriately.

Question: ${question}
Search queries used: ${queriesUsed}

Consider: does this question benefit from encyclopedic lookup, or is it something the model should handle from its own knowledge (e.g. math, simple definitions, creative tasks, conversational questions)? For factual questions, the model has latitude — not searching is acceptable if the answer is well within common knowledge; searching is also acceptable. Penalise only clear misjudgements.

Score search appropriateness:
- 0: Clearly wrong — searched for something that obviously needs no lookup (arithmetic, "write me a poem"), OR refused to search for something where current or verifiable information is clearly needed
- 1: Reasonable decision, but queries were vague, redundant, or poorly targeted
- 2: Sound judgment about whether to search; queries (if any) were specific and well-targeted
${UNKNOWN_ESCAPE}

Return JSON only: {"score": <0|1|2|null>, "reasoning": "<one sentence>"}`);
}

export async function scoreAnswerQuality(
  question: string,
  actualAnswer: string,
  toolCalls: ToolCall[],
  citations: Citation[]
): Promise<JudgeScore> {
  const queriesUsed =
    toolCalls.length === 0
      ? "None"
      : toolCalls.map((tc) => `"${tc.query}"`).join(", ");

  const citationSection =
    toolCalls.length === 0
      ? "No Wikipedia search was performed."
      : citations.length > 0
        ? `Passages cited from Wikipedia:\n${citations.map((c) => `  - "${c.cited_text}" (${c.document_title})`).join("\n")}`
        : "Wikipedia was searched but no structured citations were produced. Check if the answer attributes the source in text (e.g. 'According to the Wikipedia article on X...').";

  return judge(`You are evaluating the quality of an AI assistant's answer across three aspects:

1. Clarity and conciseness: Is the answer direct, well-structured, and appropriately brief?
2. Citation: If Wikipedia was searched, does the answer attribute its source — either via structured citations or explicit text attribution (e.g. "According to the Wikipedia article on X...")?
3. Calibration: Does the answer appropriately hedge when the information is contested, uncertain, or depends on how terms are defined?

Question: ${question}
Wikipedia queries used: ${queriesUsed}
${citationSection}
Answer: ${actualAnswer}

Score overall answer quality:
- 0: Fails notably — unclear or off-topic; OR searched Wikipedia but the answer contains no attribution whatsoever; OR states contested/nuanced facts with false confidence
- 1: Adequate but has gaps — attribution is vague or incomplete, hedging is weak, or answer is verbose/imprecise
- 2: Clear and concise; attributes the Wikipedia source (via citations or explicit text attribution); appropriately hedges on contested or measurement-dependent information
${UNKNOWN_ESCAPE}

Return JSON only: {"score": <0|1|2|null>, "reasoning": "<one sentence>"}`);
}

export async function scoreAll(
  question: string,
  expectedAnswer: string | null,
  actualAnswer: string,
  toolCalls: ToolCall[],
  citations: Citation[]
): Promise<Scores> {
  const [correctness, faithfulness, searchAppropriateness, answerQuality] =
    await Promise.all([
      scoreCorrectness(question, expectedAnswer, actualAnswer),
      scoreFaithfulness(question, toolCalls, actualAnswer, citations),
      scoreSearchAppropriateness(question, toolCalls),
      scoreAnswerQuality(question, actualAnswer, toolCalls, citations),
    ]);

  return { correctness, faithfulness, searchAppropriateness, answerQuality };
}
