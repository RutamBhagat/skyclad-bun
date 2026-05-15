import {
  createAgent,
  deleteAgent,
  streamPrompt,
  toPersistableState,
  type PersistableAgentState,
} from "./session-manager";

type AgentEvalExpectedAction = "retrieve" | "multi_retrieve" | "clarify" | "refuse" | "calculate";

export type AgentEvalCase = {
  id: string;
  prompt: string;
  expectedAction: AgentEvalExpectedAction;
  expectedBehavior: string;
};

export const agentEvalCases: AgentEvalCase[] = [
  {
    id: "self-attention-retrieval",
    prompt:
      "Use your arXiv papers to answer grounded in retrieved resources: According to Attention Is All You Need, what problem does self-attention solve compared with recurrent sequence models?",
    expectedAction: "retrieve",
    expectedBehavior: "Resolve the paper, retrieve relevant chunks, then answer from them.",
  },
  {
    id: "scaling-laws-retrieval",
    prompt:
      "What do scaling laws for neural language models say about the relationship between model size, dataset size, compute, and language modeling loss?",
    expectedAction: "retrieve",
    expectedBehavior: "Retrieve paper context before answering the technical claim.",
  },
  {
    id: "rag-retrieval",
    prompt:
      "Why did retrieval-augmented generation for knowledge-intensive NLP tasks combine parametric generation with non-parametric memory?",
    expectedAction: "retrieve",
    expectedBehavior: "Use paper retrieval because this is a corpus-grounded question.",
  },
  {
    id: "react-toolformer-mrkl-multi-retrieval",
    prompt:
      "Compare ReAct, Toolformer, and MRKL systems in how they connect language models to tools or external knowledge.",
    expectedAction: "multi_retrieve",
    expectedBehavior: "Retrieve more than once because the comparison spans multiple papers or concepts.",
  },
  {
    id: "ambiguous-method-clarify",
    prompt: "Which method is better?",
    expectedAction: "clarify",
    expectedBehavior: "Ask what methods, task, metric, or paper the user means instead of guessing.",
  },
  {
    id: "ambiguous-r1-clarify",
    prompt: "What are the main findings of the R1 paper?",
    expectedAction: "clarify",
    expectedBehavior: "Ask which R1 paper or arXiv entry the user means before retrieval.",
  },
  {
    id: "medical-out-of-domain-refuse",
    prompt:
      "What is the best treatment for hypertension in elderly patients based on your research papers?",
    expectedAction: "refuse",
    expectedBehavior: "Refuse or say the indexed arXiv AI corpus cannot support medical treatment advice.",
  },
  {
    id: "lost-in-the-middle-retrieval",
    prompt:
      "What failure mode is discussed by Lost in the Middle, and how is it relevant to long-context agents?",
    expectedAction: "retrieve",
    expectedBehavior: "Retrieve the relevant paper chunks before answering.",
  },
  {
    id: "dpo-retrieval",
    prompt:
      "In Direct Preference Optimization, why can preference learning be done without explicitly training a reward model?",
    expectedAction: "retrieve",
    expectedBehavior: "Retrieve paper evidence before answering the DPO mechanism question.",
  },
  {
    id: "exact-score-calculation",
    prompt:
      "If an eval set has 123456789 questions and the agent gets 12333411 fully correct and 10101 partially correct worth half credit, what is the precise exact percentage score?",
    expectedAction: "calculate",
    expectedBehavior: "Use the calculator tool or produce the exact arithmetic result, not a rough estimate.",
  },
];

function stringifyForEval(value: unknown) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function contentTextForEval(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";

      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return contentTextForEval(record.content);
    })
    .filter(Boolean)
    .join("\n");
}

function finalAssistantAnswer(state: PersistableAgentState) {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index] as { role?: unknown; content?: unknown };
    if (message.role === "assistant") return contentTextForEval(message.content).trim();
  }

  return "";
}

function countEvalMentions(text: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(escaped, "g"))?.length ?? 0;
}

function evalTextIncludes(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

export async function runAgentEvalCase(evalCase: AgentEvalCase, includeEvents: boolean) {
  const sessionId = `eval-${crypto.randomUUID()}`;
  const agent = createAgent(sessionId);
  const events: unknown[] = [];
  const startedAt = Date.now();

  try {
    await streamPrompt(agent, evalCase.prompt, async (event) => {
      events.push(event);
    });

    const state = toPersistableState(agent);
    const finalAnswer = finalAssistantAnswer(state);
    const evidenceText = `${stringifyForEval(events)}\n${stringifyForEval(state.messages)}\n${finalAnswer}`.toLowerCase();
    const answerText = finalAnswer.toLowerCase();

    const resolvePaperIdCalls = countEvalMentions(evidenceText, "resolve_paper_id");
    const queryPaperDocsCalls = countEvalMentions(evidenceText, "query_paper_docs");
    const calculateCalls = countEvalMentions(evidenceText, "calculate");

    const observed = {
      resolvePaperIdCalls,
      queryPaperDocsCalls,
      calculateCalls,
      finalAnswer,
    };

    let passed = false;
    let reason = "";

    if (evalCase.expectedAction === "retrieve") {
      passed = resolvePaperIdCalls > 0 || queryPaperDocsCalls > 0;
      reason = passed ? "The agent used a retrieval tool." : "Expected at least one retrieval tool call.";
    }

    if (evalCase.expectedAction === "multi_retrieve") {
      passed = queryPaperDocsCalls >= 2 || resolvePaperIdCalls >= 2;
      reason = passed ? "The agent retrieved more than once." : "Expected multiple retrieval calls.";
    }

    if (evalCase.expectedAction === "clarify") {
      passed = evalTextIncludes(answerText, [
        "clarify",
        "which paper",
        "which method",
        "what method",
        "specific paper",
        "paper title",
        "arxiv id",
        "more specific",
      ]);
      reason = passed ? "The agent asked for missing context." : "Expected a clarifying question.";
    }

    if (evalCase.expectedAction === "refuse") {
      passed = evalTextIncludes(answerText, [
        "cannot",
        "can't",
        "do not have",
        "don't have",
        "not indexed",
        "not in the corpus",
        "outside",
        "medical advice",
        "healthcare professional",
        "doctor",
        "not enough evidence",
      ]);
      reason = passed ? "The agent refused or said the corpus does not support the request." : "Expected refusal.";
    }

    if (evalCase.expectedAction === "calculate") {
      passed =
        calculateCalls > 0 ||
        evalTextIncludes(answerText, ["9.994153905946801", "9.9941539059", "9.994%"]);
      reason = passed ? "The agent calculated the score." : "Expected calculation or exact percentage.";
    }

    return {
      id: evalCase.id,
      prompt: evalCase.prompt,
      expectedBehavior: evalCase.expectedBehavior,
      expectedAction: evalCase.expectedAction,
      durationMs: Date.now() - startedAt,
      eventCount: events.length,
      passed,
      reason,
      observed,
      events: includeEvents ? events : undefined,
    };
  } catch (error) {
    return {
      id: evalCase.id,
      prompt: evalCase.prompt,
      expectedBehavior: evalCase.expectedBehavior,
      expectedAction: evalCase.expectedAction,
      durationMs: Date.now() - startedAt,
      eventCount: events.length,
      passed: false,
      reason: error instanceof Error ? error.message : String(error),
      observed: {
        resolvePaperIdCalls: 0,
        queryPaperDocsCalls: 0,
        calculateCalls: 0,
        finalAnswer: "",
      },
      events: includeEvents ? events : undefined,
    };
  } finally {
    deleteAgent(sessionId);
  }
}
