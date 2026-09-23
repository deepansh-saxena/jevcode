import { loadProject, updateProjectConfig, type Project } from "./registry.js";
import { loginPrompt } from "./terminal.js";
import { readJevKey, saveJevKey, removeJevKey, normalizeJevKey } from "./jev-key.js";
import { JevClient } from "./jev.js";

function confirmed(answer: string): boolean {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

export async function ensureJevSetup(project: Project, explicitOff = false,
  interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY)): Promise<void> {
  if (explicitOff) {
    if (project.config.jev.guardrail !== "off") throw new Error("--jev-off cannot bypass configured guardrails. Review Jev settings explicitly.");
    project.config.jev.mode = "off";
    project.config.jev.setupComplete = true;
    process.stderr.write("Jev routing explicitly off for this session; no Jev setup or requests.\n");
    return;
  }
  const needsSetup = project.config.jev.setupComplete === false;
  const active = project.config.jev.mode !== "off" || project.config.jev.guardrail !== "off";
  if (!needsSetup && !active) return;
  if (!needsSetup && (process.env[project.config.jev.apiKeyEnv] ?? await readJevKey())) return;
  if (!interactive) {
    throw new Error("Jev setup is required before coding. Run jevcode jev setup in a terminal, or choose --jev-off explicitly (only without configured guardrails).");
  }
  const signal = AbortSignal.timeout(600_000);
  process.stderr.write("Jev is the default routing layer: it selects skills and when to delegate. Setup requires your key and explicit data-sharing consent.\n");
  const choice = (await loginPrompt("Jev setup [on/off] (default: on):", false, signal)).trim().toLowerCase();
  if (choice === "off") {
    if (project.config.jev.guardrail !== "off") throw new Error("Configured guardrails require Jev setup; this choice cannot disable them");
    await configureJev(project.workspace.root, "off");
  } else if (choice === "" || choice === "on") {
    await configureJev(project.workspace.root, "setup");
  } else throw new Error("Choose on or off; no settings were changed");
  project.config.jev = (await loadProject(project.workspace.root, project.catalogOptions)).config.jev;
}

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
    await updateProjectConfig(project, (config) => { config.jev.mode = "off"; config.jev.setupComplete = true; });
    process.stdout.write("Jev routing disabled. Required guardrails are unchanged.\n");
    return;
  }
  if (command !== "setup") throw new Error("Usage: jevcode jev <setup|status|off|logout>");
  const signal = AbortSignal.timeout(600_000);
  const consent = await loginPrompt("Jev receives task text, recent user prompts, and capability metadata. Configured guardrails additionally send proposed action arguments, including edit contents. Enable this data sharing? [yes/no]", false, signal);
  if (!confirmed(consent)) throw new Error("Jev setup cancelled; consent was not granted (enter y or yes to confirm)");
  const mode = (await loginPrompt("Routing mode [on/shadow]:", false, signal)).trim().toLowerCase() || "on";
  if (mode !== "on" && mode !== "shadow") throw new Error("Choose on or shadow");
  const environmentKey = process.env[project.config.jev.apiKeyEnv];
  let key = environmentKey ?? await readJevKey();
  const saveKey = key === undefined;
  if (key === undefined) {
    const persist = await loginPrompt("Store a Jev key unencrypted in a private ~/.jev-code/jev-key.json file? [yes/no]", false, signal);
    if (!confirmed(persist)) throw new Error(`Set ${project.config.jev.apiKeyEnv} in your terminal and rerun setup`);
    key = await loginPrompt("Paste the replacement Jev API key (input hidden):", true, signal);
  }
  const source = environmentKey !== undefined ? `environment variable ${project.config.jev.apiKeyEnv}` :
    saveKey ? "newly entered key" : "saved Jev key";
  process.stderr.write(`Checking Jev access using the ${source}...\n`);
  const normalized = normalizeJevKey(key);
  const client = new JevClient({ ...project.config.jev, allowDataSharing: true }, normalized, () => {}, () => {});
  try {
    await client.evaluate({ purpose: "connection test" }, { ready: { type: "noul", instructions: "Is this a connection test?" } }, signal);
  } catch (error) {
    process.stderr.write(saveKey ? "Connection test failed; the entered key was not saved and workspace settings were not changed.\n" :
      `Connection test failed; workspace settings were not changed. ${environmentKey !== undefined ?
        `Update or unset ${project.config.jev.apiKeyEnv} before rerunning setup.` :
        "Run jevcode jev logout to remove a rejected saved key, then rerun setup."}\n`);
    throw error;
  }
  if (saveKey) await saveJevKey(normalized);
  await updateProjectConfig(project, (config) => {
    config.jev.mode = mode; config.jev.allowDataSharing = true; config.jev.setupComplete = true;
  });
  process.stdout.write(`Jev routing ${mode}. Existing guardrail settings and all action approvals are unchanged.\n`);
}
