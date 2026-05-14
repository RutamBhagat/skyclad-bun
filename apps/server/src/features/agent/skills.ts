import { readFileSync } from "node:fs";

type ServerSkill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
};

function loadSkill(path: URL): ServerSkill {
  const raw = readFileSync(path, "utf8");
  const parsed = parseSkillMarkdown(raw);

  return {
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    filePath: path.pathname,
  };
}

function parseSkillMarkdown(raw: string) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error("Server skill is missing frontmatter.");
  }

  const name = matchFrontmatterValue(match[1], "name");
  const description = matchFrontmatterValue(match[1], "description");

  if (!name || !description) {
    throw new Error("Server skill frontmatter must include name and description.");
  }

  return {
    name,
    description,
    content: match[2].trim(),
  };
}

function matchFrontmatterValue(frontmatter: string, key: string) {
  const line = frontmatter
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${key}:`));

  return line?.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
}

function formatSkillsForSystemPrompt(skills: ServerSkill[]) {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the full skill instructions below when the task matches a skill description.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const arxivUsageSkill = loadSkill(new URL("./skills/arxiv-usage/SKILL.md", import.meta.url));

export const serverSkills = [arxivUsageSkill];

export function formatServerSkillsPrompt() {
  const skillList = formatSkillsForSystemPrompt(serverSkills);
  const skillInstructions = serverSkills
    .filter((skill) => !skill.disableModelInvocation)
    .map(
      (skill) =>
        `<skill_instructions name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\n${skill.content}\n</skill_instructions>`,
    )
    .join("\n\n");

  return [skillList, skillInstructions].filter(Boolean).join("\n\n");
}
