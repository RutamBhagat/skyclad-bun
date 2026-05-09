import { $ } from "bun";
import { embeddingDimensions } from "@skyclad-bun/db/schema/index";
import { env } from "@skyclad-bun/env/server";
import { marked } from "marked";
import slugify from "slugify";

type IngestPaperSourceInput = {
  arxivId: string;
  paperId: string;
  title: string;
  authors: string[];
  summary: string;
  sourceUrl: string;
};

type SectionDoc = {
  docIndex: number;
  sectionTitle: string;
  sectionPath: string[];
  sectionLevel: number;
  sectionKind: "main" | "abstract" | "references" | "appendix";
  markdown: string;
  sourceFile: string;
};

type SectionDraft = Omit<SectionDoc, "docIndex" | "sourceFile"> & {
  parts: string[];
};

const mainTexNames = new Set(["main.tex", "paper.tex", "ms.tex", "article.tex", "arxiv.tex"]);
const ingestTools = ["tar", "latexpand", "pandoc"];
const embeddingModel = "gemini-embedding-2";
const minSectionBodyCharacters = 120;

export async function ensureIngestTools() {
  const missing: string[] = [];

  for (const tool of ingestTools) {
    const resolved = Bun.which(tool);
    if (!resolved) {
      missing.push(tool);
    }
  }

  return missing;
}

export async function findMainTexFile(sourceDir: string) {
  const texFiles = (await $`find ${sourceDir} -type f -name "*.tex"`.text())
    .trim()
    .split("\n")
    .filter(Boolean);
  const documentFiles: Array<{ file: string; size: number }> = [];

  for (const file of texFiles) {
    const content = await Bun.file(file).text();
    if (content.includes("\\begin{document}")) {
      documentFiles.push({ file, size: content.length });
    }
  }

  if (documentFiles.length === 0) {
    throw new Error("source_not_latex");
  }

  if (documentFiles.length === 1) {
    return documentFiles[0]!.file;
  }

  // common arxiv projects name the root document with one of these boring filenames
  const namedMain = documentFiles.find((item) =>
    mainTexNames.has(item.file.split("/").at(-1)?.toLowerCase() ?? ""),
  );
  if (namedMain) {
    return namedMain.file;
  }

  // ambiguous sources usually put the real paper body in the largest document file
  return documentFiles.sort((left, right) => right.size - left.size)[0]!.file;
}

export function splitMarkdown(markdown: string): SectionDoc[] {
  // marked keeps heading text/depth/raw available without a full ast pipeline
  const tokens = marked.lexer(markdown, { gfm: true });
  const sections: SectionDoc[] = [];
  // this stack turns nested headings into a citation-ready section path
  const headingStack: Array<{ depth: number; title: string }> = [];
  let current: SectionDraft | null = null;

  const flush = () => {
    if (!current) return;

    // close the previous section exactly as pandoc emitted it
    const sectionMarkdown = current.parts.join("").trim();
    const bodyMarkdown = current.parts.slice(1).join("").trim();
    if (bodyMarkdown.length < minSectionBodyCharacters) return;

    const docIndex = sections.length;
    sections.push({
      ...current,
      docIndex,
      markdown: sectionMarkdown,
      // Keep ordering stable while making generated files readable during debugging.
      sourceFile: `${docIndex.toString().padStart(3, "0")}-${slugify(
        current.sectionTitle.replace(/\{#[^}]+\}/g, ""),
        { lower: true, strict: true },
      )}.md`,
    });
  };

  for (const token of tokens) {
    if (token.type !== "heading") {
      // non-heading tokens belong to the current heading section
      current?.parts.push(token.raw ?? "");
      continue;
    }

    flush();

    // A depth stack handles skipped heading levels without adding undefined path entries.
    while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.depth >= token.depth) {
      headingStack.pop();
    }
    headingStack.push({ depth: token.depth, title: token.text });

    current = {
      sectionTitle: token.text,
      sectionPath: headingStack.map((heading) => heading.title),
      sectionLevel: token.depth,
      sectionKind: getSectionKind(token.text),
      markdown: "",
      parts: [token.raw],
    };
  }

  flush();
  if (sections.length > 0) return sections;

  // some converted papers have no markdown headings; keep them queryable as abstract
  return [buildSection(0, "Abstract", ["Abstract"], 1, `# Abstract\n\n${markdown.trim()}`)];
}

export async function writeSectionFiles(
  input: IngestPaperSourceInput,
  sections: SectionDoc[],
  sectionsDir: string,
) {
  const arxivId = input.arxivId.replace(/v\d+$/i, "");
  const paperId = `/arxiv/${arxivId}`;

  await $`mkdir -p ${sectionsDir}`;

  for (const section of sections) {
    const frontmatter = [
      "---",
      `paper_id: "${paperId}"`,
      `arxiv_id: "${arxivId}"`,
      `section: "${section.sectionTitle}"`,
      "section_path:",
      ...section.sectionPath.map((item) => `  - "${item}"`),
      `source_file: "${section.sourceFile}"`,
      "---",
      "",
    ].join("\n");

    await Bun.write(`${sectionsDir}/${section.sourceFile}`, `${frontmatter}${section.markdown}\n`);
  }
}

export async function embed(input: string) {
  // gemini embeddings keep ingestion free while still fitting pgvector search
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        model: `models/${embeddingModel}`,
        // the db schema fixes the vector size, so request that size directly from gemini
        output_dimensionality: embeddingDimensions,
        content: { parts: [{ text: input }] },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Gemini embedding failed: ${response.status} ${await response.text()}`);
  }

  // gemini returns the vector under embedding.values for single embedContent calls
  const body = (await response.json()) as { embedding: { values: number[] } };
  return body.embedding.values;
}

function buildSection(
  docIndex: number,
  title: string,
  path: string[],
  level: number,
  markdown: string,
): SectionDoc {
  return {
    docIndex,
    sectionTitle: title,
    sectionPath: path,
    sectionLevel: level,
    sectionKind: getSectionKind(title),
    markdown,
    // Keep the fallback filename shape consistent with normal section documents.
    sourceFile: `${docIndex.toString().padStart(3, "0")}-${slugify(
      title.replace(/\{#[^}]+\}/g, ""),
      { lower: true, strict: true },
    )}.md`,
  };
}

function getSectionKind(title: string): SectionDoc["sectionKind"] {
  const normalized = title.toLowerCase();
  if (normalized === "abstract") return "abstract";
  if (normalized === "references" || normalized === "bibliography") return "references";
  if (normalized.startsWith("appendix")) return "appendix";
  return "main";
}
