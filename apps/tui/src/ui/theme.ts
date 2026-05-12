import { Chalk } from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export const chalk = new Chalk({ level: 3 });

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.cyan(text),
  selectedText: (text) => chalk.bold(text),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.dim(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => chalk.dim(text),
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold.cyan(text),
  link: (text) => chalk.cyan(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => chalk.yellow(text),
  codeBlock: (text) => chalk.green(text),
  codeBlockBorder: (text) => chalk.dim(text),
  quote: (text) => chalk.italic(text),
  quoteBorder: (text) => chalk.dim(text),
  hr: (text) => chalk.dim(text),
  listBullet: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};
