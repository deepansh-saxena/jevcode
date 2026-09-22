import { loadProject, updateProjectConfig } from "./registry.js";
import { loginPrompt } from "./terminal.js";
import { readJevKey, saveJevKey, removeJevKey } from "./jev-key.js";
import { JevClient } from "./jev.js";

export async function configureJev(root: string, command: string): Promise<void> {
  if (command === "logout") { await removeJevKey(); process.stdout.write("Removed locally saved Jev key; environment keys and workspace settings are unchanged.\n"); return; }
  const project = await loadProject(root);
  if (command === "status") {
    process.stdout.write(`${JSON.stringify({
      ...project.config.jev, keyAvailable: Boolean(process.env[project.config.jev.apiKeyEnv] ?? await readJevKey()),
    }, null, 2)}\n`);
    return;
  }
  if (command === "off") {
    await updateProjectConfig(project, (config) => { config.jev.mode = "off"; });
    process.stdout.write("Jev routing disabled. Required guardrails are unchanged.\n");
    return;
  }
  if (command !== "setup") throw new Error("Usage: jevcode jev <setup|status|off|logout>");
  const signal = AbortSignal.timeout(600_000);
  const consent = await loginPrompt("Jev receives task text, recent user prompts, and capability metadata. Configured guardrails additionally send proposed action arguments, including edit contents. Enable this data sharing? [yes/no]", false, signal);
  if (consent.trim().toLowerCase() !== "yes") throw new Error("Jev setup cancelled; consent was not granted");
  const mode = (await loginPrompt("Routing mode [on/shadow]:", false, signal)).trim();
  if (mode !== "on" && mode !== "shadow") throw new Error("Choose on or shadow");
  let key = process.env[project.config.jev.apiKeyEnv] ?? await readJevKey();
  if (!key) {
    const persist = await loginPrompt("Store a Jev key unencrypted in a private ~/.jev-code/jev-key.json file? [yes/no]", false, signal);
    if (persist.trim().toLowerCase() !== "yes") throw new Error(`Set ${project.config.jev.apiKeyEnv} in your terminal and rerun setup`);
    key = await loginPrompt("Paste the replacement Jev API key (input hidden):", true, signal);
    const client = new JevClient({ ...project.config.jev, allowDataSharing: true }, key, () => {}, () => {});
    await client.evaluate({ purpose: "connection test" }, { ready: { type: "noul", instructions: "Is this a connection test?" } }, signal);
    await saveJevKey(key);
  } else {
    const client = new JevClient({ ...project.config.jev, allowDataSharing: true }, key, () => {}, () => {});
    await client.evaluate({ purpose: "connection test" }, { ready: { type: "noul", instructions: "Is this a connection test?" } }, signal);
  }
  await updateProjectConfig(project, (config) => { config.jev.mode = mode; config.jev.allowDataSharing = true; });
  process.stdout.write(`Jev routing ${mode}. Existing guardrail settings and all action approvals are unchanged.\n`);
}
