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
  correctness: JudgeScore | null;
  faithfulness: JudgeScore | null;
  searchAppropriateness: JudgeScore;
  answerQuality: JudgeScore;
}

// Structured output tool — the model is forced to call this, eliminating parse failures.
const SUBMIT_SCORE_TOOL: Anthropic.Tool = {
  name: "submit_score",
  description: "Submit your evaluation score and reasoning.",
  input_schema: {
    type: "object" as const,
    properties: {
      score: {
        description:
          "0 = fails, 1 = adequate, 2 = excellent. Set to null if you cannot meaningfully evaluate this dimension due to insufficient information.",
        anyOf: [{ type: "integer", minimum: 0, maximum: 2 }, { type: "null" }],
      } as unknown as { type: "string" },
      reasoning: {
        type: "string" as const,
        description: "One sentence explaining the score.",
      },
    },
    required: ["score", "reasoning"],
  },
};

async function judge(prompt: string): Promise<JudgeScore> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    tools: [SUBMIT_SCORE_TOOL],
    tool_choice: { type: "tool", name: "submit_score" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) return { score: null, reasoning: "No tool call in response" };

  const result = JudgeScoreSchema.safeParse(toolUse.input);
  if (!result.success)
    return {
      score: null,
      reasoning: `Schema validation failed: ${result.error.issues[0]?.message}`,
    };
  return result.data;
}

export async function scoreCorrectness(
  question: string,
  expectedAnswer: string | null,
  actualAnswer: string
): Promise<JudgeScore> {
  if (expectedAnswer === null) {
    return judge(`Evaluate whether this answer is accurate and addresses the full complexity of the question.

Question: ${question}
Answer: ${actualAnswer}

Score:
- 0: Clearly wrong, harmful, or off-topic
- 1: Directionally correct but leaves out important context, presents false certainty about uncertain things, or gives a surface-level answer that could mislead
- 2: Accurate and genuinely useful — addresses the full complexity of what was asked, including any important caveats, unknowns, or competing perspectives`);
  }

  return judge(`Evaluate whether this answer is correct relative to the expected answer.

Question: ${question}
Expected answer: ${expectedAnswer}
Actual answer: ${actualAnswer}

Score:
- 0: Wrong, misleading, or directly contradicts the expected answer
- 1: Gets the core fact right but misses important nuance, caveats, or secondary facts that the expected answer specifies
- 2: Correct on all key facts AND captures the nuances specified in the expected answer`);
}

export async function scoreFaithfulness(
  question: string,
  toolCalls: ToolCall[],
  actualAnswer: string,
  citations: Citation[]
): Promise<JudgeScore | null> {
  if (toolCalls.length === 0) return null;

  if (citations.length > 0) {
    const citedPassages = citations
      .map((c) => `"${c.cited_text}" (from: ${c.document_title})`)
      .join("\n");

    return judge(`Evaluate whether the answer's claims are grounded in the cited passages.

Question: ${question}

Cited passages:
${citedPassages}

Answer: ${actualAnswer}

Score:
- 0: Key claims in the answer are absent from or contradicted by the cited passages
- 1: Core claims are supported, but the answer adds context, numbers, or elaborations not present in the cited passages
- 2: Every significant claim maps directly to content in the cited passages — the answer does not go beyond what was cited`);
  }

  const retrieved = toolCalls
    .filter((tc) => tc.article !== null)
    .map(
      (tc) =>
        `[Query: "${tc.query}"]\n**${tc.article!.title}**\n${tc.article!.content}`
    )
    .join("\n\n---\n\n");

  if (!retrieved) {
    return {
      score: null,
      reasoning:
        "All Wikipedia requests failed; faithfulness cannot be assessed.",
    };
  }

  return judge(`Evaluate whether the answer's claims are grounded in the retrieved Wikipedia content.

Question: ${question}

Retrieved content:
${retrieved}

Answer: ${actualAnswer}

Score:
- 0: Answer makes significant claims not found in or contradicted by the retrieved content
- 1: Core claims are supported, but the answer adds details or context that go beyond the retrieved content
- 2: All key claims are directly supported by the retrieved content — no significant extrapolation`);
}

export async function scoreSearchAppropriateness(
  question: string,
  toolCalls: ToolCall[]
): Promise<JudgeScore> {
  const queriesUsed =
    toolCalls.length === 0
      ? "None — no searches were performed."
      : toolCalls.map((tc) => `"${tc.query}"`).join(", ");

  return judge(`Evaluate whether the model used the Wikipedia search tool appropriately.

Question: ${question}
Queries used: ${queriesUsed}

The model has latitude for factual questions — answering from training data is acceptable if the answer is well within common knowledge. Penalise only clear misjudgements or poor query execution.

Score:
- 0: Clearly wrong — searched for something that needs no lookup (arithmetic, creative tasks), OR refused to search when current or verifiable information was clearly required
- 1: Right call on whether to search, but queries were redundant, vague, or required multiple near-identical reformulations to find the right article
- 2: Right call AND efficient — queries were specific, well-targeted, and found the needed information without unnecessary repetition`);
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

  return judge(`Evaluate this answer across two aspects:

1. Clarity and detail: Well-structured and appropriately detailed? Simple factual questions warrant 1–2 sentences. Questions involving uncertainty, competing views, or synthesis warrant fuller answers — detail is appropriate here, not a flaw.

2. Calibration:
   - For well-established facts: states them confidently without unnecessary hedging.
   - For contested or measurement-dependent claims: acknowledges the dispute or ambiguity.
   - For genuinely uncertain or unknowable answers: explains WHY certainty is elusive, what competing accounts or estimates exist, and corrects common misconceptions where relevant. "We don't know" is a 1; "here is what we do and don't know, and why" is a 2.

Question: ${question}
Wikipedia queries used: ${queriesUsed}
Answer: ${actualAnswer}

Score:
- 0: Clearly fails — unclear or off-topic; OR states genuinely uncertain facts with false confidence; OR answers a falsely-premised question without correcting the premise
- 1: Adequate — correct and clear, but calibration is shallow (e.g. says "this is disputed" without explaining the dispute, or "we don't know" without explaining why or what IS known)
- 2: Well-calibrated — presents certain facts confidently; for uncertain or contested questions, explains the epistemic situation rather than just asserting a conclusion; structured appropriately for the complexity of the question`);
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
