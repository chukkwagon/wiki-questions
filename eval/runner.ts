import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { ask } from "../src/agent.js";
import { scoreAll, type Scores } from "./judges.js";

interface TestCase {
  id: string;
  category: string;
  question: string;
  expected_answer: string | null;
  notes?: string;
}

interface CaseResult {
  id: string;
  category: string;
  question: string;
  answer: string;
  toolCalls: { query: string }[];
  scores: Scores;
}

function totalScore(scores: Scores): { earned: number; max: number } {
  let earned = 0;
  let max = 0;

  if (scores.correctness !== null && scores.correctness.score !== null) {
    earned += scores.correctness.score;
    max += 2;
  }
  if (scores.faithfulness !== null && scores.faithfulness.score !== null) {
    earned += scores.faithfulness.score;
    max += 2;
  }
  if (scores.searchAppropriateness.score !== null) {
    earned += scores.searchAppropriateness.score;
    max += 2;
  }
  if (scores.answerQuality.score !== null) {
    earned += scores.answerQuality.score;
    max += 2;
  }

  return { earned, max };
}

// null judgeResult = N/A (dimension doesn't apply)
// judgeResult with null score = Unknown (judge couldn't evaluate)
function fmtScore(judgeResult: import("./judges.js").JudgeScore | null): string {
  if (judgeResult === null) return " N/A";
  if (judgeResult.score === null) return "  ?/2";
  return `${judgeResult.score}/2`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function printCaseResult(i: number, total: number, tc: TestCase, result: CaseResult): void {
  const { earned, max } = totalScore(result.scores);
  const searches =
    result.toolCalls.length === 0
      ? "  No searches"
      : result.toolCalls.map((tc) => `  🔍 "${tc.query}"`).join("\n");

  console.log(`\n[${i}/${total}] ${tc.id} | ${tc.category}`);
  console.log(`  Q: ${tc.question}`);
  console.log(`  A: ${result.answer.slice(0, 120)}${result.answer.length > 120 ? "…" : ""}`);
  console.log(searches);
  console.log(
    `  Scores: Correct ${fmtScore(result.scores.correctness)} · ` +
    `Faithful ${fmtScore(result.scores.faithfulness)} · ` +
    `Search ${fmtScore(result.scores.searchAppropriateness)} · ` +
    `Quality ${fmtScore(result.scores.answerQuality)} → ${earned}/${max}`
  );

  const flags: string[] = [];
  const c = result.scores.correctness;
  const f = result.scores.faithfulness;
  const s = result.scores.searchAppropriateness;
  const q = result.scores.answerQuality;
  if (c && c.score !== 2) flags.push(`    Correct: ${c.score === null ? "[Unknown] " : ""}${c.reasoning}`);
  if (f && f.score !== 2) flags.push(`    Faithful: ${f.score === null ? "[Unknown] " : ""}${f.reasoning}`);
  if (s.score !== 2) flags.push(`    Search: ${s.score === null ? "[Unknown] " : ""}${s.reasoning}`);
  if (q.score !== 2) flags.push(`    Quality: ${q.score === null ? "[Unknown] " : ""}${q.reasoning}`);
  if (flags.length > 0) console.log(flags.join("\n"));
}

const PASS_THRESHOLD = 0.75;

function isPassing(scores: Scores): boolean {
  const { earned, max } = totalScore(scores);
  return max > 0 && earned / max >= PASS_THRESHOLD;
}

function printSummary(results: CaseResult[]): void {
  const categories = [...new Set(results.map((r) => r.category))];
  const passing = results.filter((r) => isPassing(r.scores));

  console.log("\n" + "═".repeat(50));
  console.log("RESULTS");
  console.log("═".repeat(50));

  const overallPct = ((passing.length / results.length) * 100).toFixed(1);
  console.log(`\nPass rate:  ${passing.length}/${results.length} (${overallPct}%)  [threshold: ≥${PASS_THRESHOLD * 100}% of max score]\n`);

  console.log("By category:");
  console.log("─".repeat(50));
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPassing = catResults.filter((r) => isPassing(r.scores));
    const pct = ((catPassing.length / catResults.length) * 100).toFixed(0);
    const bar = "█".repeat(catPassing.length) + "░".repeat(catResults.length - catPassing.length);
    console.log(`  ${pad(cat, 22)} ${pad(`${catPassing.length}/${catResults.length}`, 6)} (${pad(pct + "%", 5)})  ${bar}`);
  }
  console.log("─".repeat(50));
  console.log(`  ${pad("OVERALL", 22)} ${pad(`${passing.length}/${results.length}`, 6)} (${overallPct}%)`);
  console.log("═".repeat(50));
}

function parseArgs(): { ids: Set<string>; categories: Set<string> } {
  const args = process.argv.slice(2);
  const ids = new Set<string>();
  const categories = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--case" && args[i + 1]) {
      args[++i].split(",").forEach((v) => ids.add(v.trim()));
    } else if (args[i] === "--category" && args[i + 1]) {
      args[++i].split(",").forEach((v) => categories.add(v.trim()));
    } else if (args[i].startsWith("--case=")) {
      args[i].slice("--case=".length).split(",").forEach((v) => ids.add(v.trim()));
    } else if (args[i].startsWith("--category=")) {
      args[i].slice("--category=".length).split(",").forEach((v) => categories.add(v.trim()));
    }
  }

  return { ids, categories };
}

async function main() {
  const allCases: TestCase[] = JSON.parse(
    readFileSync(new URL("./cases.json", import.meta.url), "utf-8")
  );

  const { ids, categories } = parseArgs();
  const cases =
    ids.size === 0 && categories.size === 0
      ? allCases
      : allCases.filter(
          (tc) => ids.has(tc.id) || categories.has(tc.category)
        );

  if (cases.length === 0) {
    console.error("No cases matched the provided --case / --category filters.");
    process.exit(1);
  }

  const filterDesc =
    ids.size > 0 || categories.size > 0
      ? ` (filtered: ${[...ids, ...categories].join(", ")})`
      : "";
  console.log(`\nWIKI-QA EVAL SUITE — ${cases.length}/${allCases.length} cases${filterDesc}`);

  const results: CaseResult[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < cases.length; i++) {
    if (i > 0) await sleep(1200 + Math.random() * 600); // 1.2–1.8s jitter, stays under Haiku 50 RPM
    const tc = cases[i];
    const agentResult = await ask(tc.question);
    const scores = await scoreAll(
      tc.question,
      tc.expected_answer,
      agentResult.answer,
      agentResult.toolCalls,
      agentResult.citations
    );

    const result: CaseResult = {
      id: tc.id,
      category: tc.category,
      question: tc.question,
      answer: agentResult.answer,
      toolCalls: agentResult.toolCalls.map((tc) => ({ query: tc.query })),
      scores,
    };

    results.push(result);
    printCaseResult(i + 1, cases.length, tc, result);
  }

  printSummary(results);

  mkdirSync("eval/results", { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `eval/results/${timestamp}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved: ${outPath}`);
}

main().catch(console.error);
