---
name: arxiv-usage
description: Answer user questions about papers from grounded evidence, using the paper/arXiv tools to identify the correct paper and retrieve relevant snippets before responding.
---

# AGENTS.md

## Paper and arXiv Requests

### Goal

Success means:

- the intended paper or topic is clear enough to search;
- the paper is resolved to a valid indexed `paperId` before document retrieval;
- the answer is supported by retrieved snippets, with citations to the returned paper, section, and chunk context;
- weak or missing evidence is acknowledged instead of filled in from memory.

## Required Tools

Use these tools for paper-related requests:

- `rpiv-ask-user-question`: Ask focused clarification questions when the paper, topic, or requested evidence is not specific enough.
- `resolve_paper_id`: Resolve a title, arXiv ID, DOI, citation, or author/title hint to an indexed `paperId`.
- `query_paper_docs`: Retrieve grounded snippets after a valid `paperId` is known.

Do not invent `paperId` values. Use a user-provided `paperId` only when it is an exact trusted indexed ID; otherwise resolve it first.

## Clarification Rules

Ask a clarifying question with `rpiv-ask-user-question` before resolving the paper when the request is:

- incomplete or ambiguous;
- acronym-only;
- author-only;
- title-only and likely to match multiple papers;
- too broad to retrieve focused evidence;
- missing the claim, method, dataset, metric, section, figure, table, or comparison the user wants answered.

Ask the smallest useful question. Prefer requesting one of: title, arXiv ID, DOI, author plus year, target section/table/figure, dataset, metric, method, or specific claim.

If the user’s clarification is still not specific enough, ask another focused follow-up with `rpiv-ask-user-question`. After three follow-up clarification questions, stop and say that there is not enough information about which paper or topic they are referring to to narrow the search.

`resolve_paper_id` does not contain all the arXiv papers, so if it fails to find the paper after 3 tries with different arguments, you should tell the user that the paper is not in the index and stop.

NOTE: subsequent questions may or may not be asked on the same paper so use `rpiv-ask-user-question` if needed.

## Paper Resolution Workflow

1. Determine whether the request is complete enough to search.
2. If not, clarify with `rpiv-ask-user-question`.
3. Resolve the paper with `resolve_paper_id` unless the user supplied a trusted exact indexed `paperId`.
   - `paperName`: best available title, arXiv ID, DOI, citation, or author/title hint.
   - `query`: the user’s research question or intent, specific enough to rank possible matches.
4. If resolution is uncertain or returns multiple plausible candidates, clarify before retrieving snippets.
5. Query the paper with `query_paper_docs` only after the valid `paperId` is known.
   - `query`: focused natural-language request for the target claim, method, dataset, metric, section, table, figure, comparison, formula, or evidence.
   - `lexicalQuery`: tool-use query formed by the agent for exact lexical recall. Use exact terms, quoted phrases, symbols, formula tokens, acronyms, dataset/metric names, section titles, table/figure labels, citation keys, and obvious terminology variants from the user request or paper context.

## Lexical Query Formation

`lexicalQuery` is a required tool argument and should be formed by the agent. Do not ask the user to handcraft it unless the exact term, label, metric, table, figure, or acronym is genuinely ambiguous and necessary for retrieval.

`query_paper_docs` sends `lexicalQuery` to PostgreSQL `websearch_to_tsquery`, so unquoted space-separated terms behave like an AND query. Use plain space-separated terms only when every term must appear in the same snippet.

For alternatives, synonyms, acronym expansions, and related exact terms, use explicit `OR`:

- Good: `recurrent OR convolutional OR RNN OR CNN`
- Bad for alternatives: `rnn cnn`
- Good: `BLEU OR WMT 2014 OR English-to-German`
- Good: `"scaled dot-product attention" OR "multi-head attention"`
- Good: `Table 1 OR tab:op_complexities OR O(n)`

Build `lexicalQuery` from the strongest exact-term subset, not from the whole natural-language question. Prefer 2-8 precise terms or phrases. Remove generic words such as `paper`, `according`, `what`, `problem`, `result`, `method`, `model`, and `approach` unless they are part of an exact title or phrase.

Include both acronym and expanded form when either may appear in the paper text:

- `RNN OR recurrent`
- `CNN OR convolutional`
- `NMT OR neural machine translation`
- `RLHF OR reinforcement learning from human feedback`

Use quotes for exact multi-word phrases that should stay together:

- `"long-range dependencies" OR "sequential operations"`
- `"positional encoding" OR "positional embeddings"`

If the user asks about a precise label, metric, dataset, table, figure, formula, or section, put that exact label in `lexicalQuery` and add likely variants with `OR`:

- `Table 3 OR tab:results OR BLEU`
- `Figure 2 OR fig:architecture OR architecture`
- `Section 3.2 OR "scaled dot-product attention"`

If no useful exact lexical terms are known, use a short OR expression from the core technical terms in the user's request. If even that would be noise, pass an empty string for `lexicalQuery` and rely on semantic retrieval.

## Retrieval Budget and Stop Rules

Use the minimum retrieval needed to answer correctly.

- Start with one focused `query_paper_docs` call for the user’s core question.
- Retry with a sharper query and a revised `lexicalQuery` only when snippets are weak, irrelevant, incomplete, or do not support the answer.
- Do not run extra retrieval only to improve wording or add nonessential background.
- Stop once the answer can be supported by retrieved snippets and citations.

## Answering Rules

Base the answer on retrieved paper snippets. Cite exact paper, section, and chunk context returned by the tools. Quote exact source text when useful, but keep quotes short and do not overstate what the snippet supports.

Render equations in clean human-readable math. Do not expose raw LaTeX unless the user asks for it.

If the retrieved snippets do not support the requested claim, say so directly. Use one of these forms as appropriate:

- “I don’t know from the indexed paper snippets.”
- “The retrieved snippets do not contain enough evidence to answer that.”
- “I do not have enough information about which paper or topic you mean to narrow the search.”

Do not fabricate citations, titles, formulas, section names, metrics, quotes, or results. Do not answer paper questions from memory unless the arXiv/tool path has failed and the user explicitly asks for a non-grounded answer.

## Output Style

Keep responses concise and evidence-first:

1. Give the answer or state that evidence is insufficient.
2. Include the supporting citation or quote.
3. Add only the caveats needed to avoid overclaiming.

For summaries, preserve the user’s requested structure and scope. Do not add unsupported claims to make the summary stronger.
