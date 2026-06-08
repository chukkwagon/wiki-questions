import { Command } from "commander";
import { ask, type AgentResult } from "./src/agent.js";

const DEMO_QUESTIONS = [
  "Who won the 2022 FIFA World Cup?",
  "Who invented the telephone?",
];

const program = new Command();

program
  .name("wiki-qa")
  .description("Answer questions using Claude + Wikipedia")
  .version("1.0.0");

function printResult(result: AgentResult): void {
  if (result.toolCalls.length > 0) {
    console.log("Wikipedia searches:");
    for (const tc of result.toolCalls) {
      console.log(`  🔍 "${tc.query}"`);
    }
    console.log();
  } else {
    console.log("(No Wikipedia search used)\n");
  }

  console.log(`A: ${result.answer}`);

  if (result.citations.length > 0) {
    const citedTitles = new Set(
      result.citations.map((c) => c.document_title).filter(Boolean)
    );
    const sources = result.toolCalls
      .filter((tc) => tc.article && citedTitles.has(tc.article.title))
      .map((tc) => tc.article!)
      .filter((a, i, arr) => arr.findIndex((x) => x.title === a.title) === i);

    if (sources.length > 0) {
      const label = sources.length === 1 ? "Source" : "Sources";
      console.log(`\n${label}:`);
      for (const s of sources) {
        console.log(`  ${s.title} <${s.url}>`);
      }
    }
  }
}

program
  .command("ask <question>")
  .description("Ask a question and get an answer")
  .action(async (question: string) => {
    console.log(`\nQ: ${question}\n`);
    const result = await ask(question);
    printResult(result);
  });

program
  .command("demo")
  .description("Run two pre-defined example queries")
  .action(async () => {
    console.log("wiki-qa demo\n");
    for (let i = 0; i < DEMO_QUESTIONS.length; i++) {
      const question = DEMO_QUESTIONS[i];
      console.log(`${"─".repeat(50)}`);
      console.log(`Q: ${question}\n`);
      const result = await ask(question);
      printResult(result);
      if (i < DEMO_QUESTIONS.length - 1) console.log();
    }
    console.log("─".repeat(50));
  });

program.parseAsync(process.argv).catch(console.error);
