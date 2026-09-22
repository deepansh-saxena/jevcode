import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { configSchema } from "./config.js";
import { resolvePath, Workspace } from "./workspace.js";

export async function initialize(root: string): Promise<void> {
  const workspace = await Workspace.create(root);
  const directory = await resolvePath(workspace.root, ".jev", true);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, "skills"), { mode: 0o700 });
  await mkdir(path.join(directory, "specialists"), { mode: 0o700 });
  const config = configSchema.parse({
    version: 1,
    llm: { model: "gpt-4.1-mini" },
    commands: {
      test: { description: "Run this project's npm test script (executes project code)", executable: "npm", args: ["test"] },
    },
  });
  const files: Record<string, string> = {
    "config.json": JSON.stringify(config, null, 2),
    "skills/coding.json": JSON.stringify({
      id: "coding", version: "1", description: "Small, maintainable code changes with explicit verification.",
      instructions: ".jev/skills/coding.md", mandatory: true,
    }, null, 2),
    "skills/coding.md": [
      "# Coding",
      "Read the relevant code before editing. Preserve unrelated changes.",
      "Keep changes focused on the user's request and follow local conventions.",
      "Use available checks when permitted. Distinguish checks actually run from suggestions.",
      "Report blocked or incomplete work honestly.",
    ].join("\n"),
    "skills/testing.json": JSON.stringify({
      id: "testing", version: "1", description: "Design regression tests and investigate test failures.",
      instructions: ".jev/skills/testing.md", mandatory: false,
    }, null, 2),
    "skills/testing.md": [
      "# Testing",
      "Find the existing test framework and nearby tests before introducing a new pattern.",
      "Cover the reported behavior, a representative failure, and relevant boundaries.",
      "Do not claim a test passed without observing its result.",
    ].join("\n"),
    "specialists/investigator.json": JSON.stringify({
      id: "investigator", description: "Read-only investigation of a concrete bug or failing test.",
      role: "Investigate the requested problem without changing files. Return findings with file paths, evidence, and a suggested fix. Explicitly identify unknowns.",
      skills: ["testing"], tools: ["list_files", "read_file", "search_files"],
      maxTurns: 5, maxToolCalls: 10,
      resultFormat: "structured",
    }, null, 2),
  };
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(path.join(directory, relative), `${content}\n`, { flag: "wx", mode: 0o600 });
  }
}
