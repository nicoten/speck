import { Markdown } from "./Markdown";

/** Files that are not markdown — config.yaml above all — shown as source.
 *  Running YAML through a prose renderer flattens its structure and loses the
 *  indentation that carries the meaning. */
export function CodeView({ markdown, language }: { markdown: string; language: string }) {
  return (
    <div className="source">
      <Markdown>{`\`\`\`${language}\n${markdown.replace(/\n+$/, "")}\n\`\`\``}</Markdown>
    </div>
  );
}

/** Fenced-code language for a path, or null when the file is markdown. */
export function nonMarkdownLanguage(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
    case "mdx":
      return null;
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
      return "json";
    case "toml":
      return "toml";
    default:
      return "";
  }
}
