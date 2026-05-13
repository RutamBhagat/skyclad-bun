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
const embeddingModel = "qwen3-embedding:8b";
const ollamaEmbedUrl = `${env.OLLAMA_BASE_URL}/api/embed`;
const minSectionBodyCharacters = 120;
const maxSectionSlugLength = 96;
const maxSectionCharacters = 10000;

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

export function buildSectionEmbeddingText(title: string, markdown: string) {
  const tokens = marked.lexer(markdown, { gfm: true });
  const chunks: string[] = [];
  for (const token of tokens) {
    if (token.type === "table") continue;
    if ("text" in token && typeof token.text === "string") chunks.push(token.text);
    if ("raw" in token && typeof token.raw === "string" && token.type === "code")
      chunks.push(token.raw);
  }
  const plainText = chunks.join(" ").replace(/\s+/g, " ").trim();
  return `title: ${title} | text: ${plainText}`;
}

// required because the generaed markdown will still contain latex commands that pandoc can't parse
export function normalizeExpandedTexForPandoc(tex: string) {
  const resolvedToggleTex = tex
    .replace(/\\iftoggle\{[^{}]+\}\{([^{}]*)\}\{([^{}]*)\}/g, "$1")
    .replace(/\\iftoggle\{[^{}]+\}\{([^{}]*)\}/g, "$1");

  const sanitizedTex = resolvedToggleTex
    .replaceAll("\0", "")
    .replace(/^\s*\(\)\s*$/gm, "")
    .replace(/\\begin\{figure\*?\}[\s\S]*?\\end\{figure\*?\}/g, "")
    .replace(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g, "")
    .replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, "")
    .replace(/\\begin\{(?:lstlisting|minted)\}[\s\S]*?\\end\{(?:lstlisting|minted)\}/g, "")
    .replace(/^\s*\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}\s*$/gm, "")
    .replace(/^\s*\\end\{figure\*?\}\s*$/gm, "")
    .replace(/^\s*\\end\{table\*?\}\s*$/gm, "")
    .replace(/^\s*\\end\{tikzpicture\}\s*$/gm, "")
    .replace(/^\s*\\end\{(?:lstlisting|minted)\}\s*$/gm, "");

  const toggleNames = Array.from(
    sanitizedTex.matchAll(/\\(?:if|not)toggle\{([^{}]+)\}/g),
    (match) => match[1]?.trim() ?? "",
  ).filter(Boolean);
  if (toggleNames.length === 0) return sanitizedTex;

  const uniqueToggleNames = Array.from(new Set(toggleNames));
  const togglePreamble = uniqueToggleNames
    .map((name) => `\\newtoggle{${name}}\n\\togglefalse{${name}}`)
    .join("\n");

  return `${togglePreamble}\n${sanitizedTex}`;
}

function getSectionKind(title: string): SectionDoc["sectionKind"] {
  const normalized = title.toLowerCase();
  if (normalized === "abstract") return "abstract";
  if (normalized === "references" || normalized === "bibliography") return "references";
  if (normalized.startsWith("appendix")) return "appendix";
  return "main";
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

    const markdownChunks = splitOversizedMarkdown(sectionMarkdown, maxSectionCharacters);
    for (const markdownChunk of markdownChunks) {
      const docIndex = sections.length;
      sections.push({
        ...current,
        docIndex,
        markdown: markdownChunk,
        // keep ordering stable while making generated files readable during debugging
        sourceFile: `${docIndex.toString().padStart(3, "0")}-${
          slugify(current.sectionTitle.replace(/\{#[^}]+\}/g, ""), {
            lower: true,
            strict: true,
          })
            .slice(0, maxSectionSlugLength)
            .replace(/-+$/g, "") || "section"
        }.md`,
      });
    }
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

function splitOversizedMarkdown(markdown: string, maxChars: number) {
  if (markdown.length <= maxChars) return [markdown];
  const paragraphs = markdown.split("\n\n");
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const block = current.length === 0 ? paragraph : `\n\n${paragraph}`;
    if (current.length + block.length <= maxChars) {
      current += block;
      continue;
    }
    if (current.length > 0) chunks.push(current.trim());
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    for (let i = 0; i < paragraph.length; i += maxChars) {
      chunks.push(paragraph.slice(i, i + maxChars).trim());
    }
    current = "";
  }
  if (current.length > 0) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [markdown.slice(0, maxChars).trim()];
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
  const normalizedInput = input.replace(/\s+/g, " ").trim();
  const response = await fetch(ollamaEmbedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: embeddingModel,
      input: normalizedInput,
      dimensions: embeddingDimensions,
      truncate: true,
    }),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ollama embedding request failed at ${ollamaEmbedUrl}. Ensure Ollama is running and OLLAMA_BASE_URL is correct. Original error: ${message}`,
    );
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { embeddings: number[][] };
  const embedding = body.embeddings[0];
  if (!embedding) throw new Error("Ollama embedding response missing embeddings[0]");
  return embedding;
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
    sourceFile: `${docIndex.toString().padStart(3, "0")}-${
      slugify(title.replace(/\{#[^}]+\}/g, ""), {
        lower: true,
        strict: true,
      })
        .slice(0, maxSectionSlugLength)
        .replace(/-+$/g, "") || "section"
    }.md`,
  };
}
