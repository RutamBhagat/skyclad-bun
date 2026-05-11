# Evaluation Questions for Agentic Paper-RAG

This benchmark evaluates whether an agent can answer questions over a technical-paper corpus with the right combination of retrieval, grounding, clarification, refusal, and external-tool use.

## Scoring Rubric

| Score | Criteria |
|---|---|
| Pass | Chooses the expected action, retrieves relevant paper context when needed, cites or quotes evidence where possible, and avoids unsupported claims. |
| Partial | Uses a mostly reasonable action but is vague, weakly grounded, incomplete, or misses an important comparison or limitation. |
| Fail | Answers from general knowledge when retrieval is required, retrieves irrelevant papers, hallucinates support, skips needed clarification, or fails to refuse unsupported corpus claims. |

## Action Taxonomy

Use these action labels when scoring:

- **Retrieve → Answer**: Resolve the target paper or papers, retrieve relevant snippets, then answer with grounded citations.
- **Retrieve Multiple → Compare/Synthesize**: Retrieve all named or relevant papers before comparing claims across them.
- **Clarify**: Ask a focused question when the paper, method, metric, corpus scope, or comparison target is underspecified.
- **Refuse / Insufficient Corpus Evidence**: Say the corpus does not support the request, especially for out-of-domain or high-stakes claims.
- **Calculate / Use External Tool**: Use arithmetic, code, or calculator support when the task is computational and does not require paper retrieval.

## Global Expectations

- Retrieval is required for paper-specific questions unless the expected action says otherwise.
- Answers should identify which paper supports each substantive claim.
- Use quotes or tight paraphrases when the retrieved text contains decisive wording.
- Do not infer that absence of evidence in the corpus proves a factual negative.
- Do not guess ambiguous titles, acronym-only references, or underspecified comparisons.
- Keep caveats proportional: name uncertainty when evidence is mixed, incomplete, or outside the corpus.

## Evaluation Set

| # | Category | User Question | Expected Action | Evidence Targets / Pass Criteria |
|---:|---|---|---|---|
| 1 | Transformer architecture basics | According to *Attention Is All You Need*, what problem does self-attention solve compared with recurrent sequence models? | Retrieve → Answer | Ground the answer in the paper. Explain that self-attention models dependencies without recurrence, improves parallelization, and reduces path length between positions. |
| 2 | Scaling laws | What do *Scaling Laws for Neural Language Models* say about the relationship between model size, dataset size, compute, and language modeling loss? | Retrieve → Answer | Summarize predictable power-law loss trends with scale and the importance of compute-optimal allocation. Avoid claims beyond the paper. |
| 3 | RAG motivation | Why did *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks* combine parametric generation with non-parametric memory? | Retrieve → Answer | Explain that retrieval provides explicit external knowledge, improves knowledge-intensive/factual tasks, and makes knowledge easier to update than purely parametric memory. |
| 4 | Agent/tool-use comparison | Compare *ReAct*, *Toolformer*, and *MRKL Systems* in how they connect language models to tools or external knowledge. | Retrieve Multiple → Compare/Synthesize | Retrieve all three. Distinguish ReAct’s interleaved reasoning/actions, Toolformer’s self-supervised API-call training, and MRKL’s modular neuro-symbolic routing across LMs, tools, and knowledge sources. |
| 5 | Ambiguous title | What are the main findings of the R1 paper? | Clarify | Ask which R1-related paper the user means. Do not guess among candidates such as *DeepSeek-R1*, *Understanding R1-Zero-Like Training*, or *Vision-R1*. |
| 6 | Outside corpus/domain | What does this corpus say about the best treatment for hypertension in elderly patients? | Refuse / Insufficient Corpus Evidence | State that the corpus does not provide sufficient medical evidence. Do not fabricate paper support. A general medical answer may be offered only outside the corpus framing. |
| 7 | Underspecified comparison | Which method is better? | Clarify | Ask which methods, papers, task, dataset, and metric should be compared. Do not retrieve randomly or answer generically. |
| 8 | Long-context failure modes | What failure mode is discussed by *Lost in the Middle*, and how is it relevant to long-context agents? | Retrieve → Answer | Explain that models may underuse information located in the middle of long contexts. Connect this to agents accumulating long conversation, tool, and retrieval histories; optionally cite related context-management papers. |
| 9 | Preference optimization | In *Direct Preference Optimization*, why can preference learning be done without explicitly training a reward model? | Retrieve → Answer | Explain that DPO reformulates the RLHF objective into a direct supervised objective over preference pairs using the relationship between the optimal policy and reward, avoiding separate reward-model training and RL optimization. |
| 10 | Arithmetic check |  If an eval set has 123456789 questions and the agent gets 12333411 fully correct and 10101 partially correct worth half credit, what is the precise exact percentage score? | Do not retrieve. Show the calculation using bash + python. |

## Common Failure Patterns to Penalize

- Treating a named paper question as answerable from memory alone.
- Citing one paper while making claims about another.
- Collapsing distinct methods into generic “tool use.”
- Overstating corpus evidence, especially for medical or security questions.
- Answering ambiguous prompts without narrowing the target.
- Performing retrieval for pure arithmetic tasks.
