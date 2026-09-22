import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, requestBody, server } from "./helpers.js";

const exec = promisify(execFile);
const cli = path.resolve("src/cli.ts");
const skip = process.platform !== "darwin" || !existsSync("/usr/bin/python3");

test("bare jevcode starts chat, retains follow-ups, saves only after approval, and resumes", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      const messages = body.messages as { role: string; content: string }[];
      if (requests > 0) assert.ok(messages.some((message) => message.role === "user" && message.content === "Remember cobalt"));
      requests++;
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Remembered cobalt." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }));
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const env = {
    ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([
      ["jevcode> ", "Remember cobalt\n"], ["jevcode> ", "What word?\n"],
      ["jevcode> ", "/save\n"], ["Type yes:", "yes\n"], ["jevcode> ", "/exit\n"],
    ]),
  };
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root,
  ], { env, timeout: 20_000 });
  assert.match(result.stdout, /Remembered cobalt/);
  assert.equal(requests, 2);
  const saved = (await readdir(path.join(project.workspace.root, ".jev/sessions")))[0]!;
  assert.match(await readFile(path.join(project.workspace.root, ".jev/sessions", saved), "utf8"), /Remember cobalt/);
  const resumed = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root,
    "--resume", saved.replace(".json", ""),
  ], { env: { ...env, JEV_PTY_PROMPTS: JSON.stringify([["jevcode> ", "What did I say?\n"], ["jevcode> ", "/exit\n"]]) }, timeout: 20_000 });
  assert.match(resumed.stdout, /Remembered cobalt/);
  assert.equal(requests, 3);
});

test("chat cancellation returns to the prompt and read-only permissions remain unchanged", { skip }, async (t) => {
  const project = await fixture(t);
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.ok(!(body.tools as { function: { name: string } }[]).some((tool) => tool.function.name === "write_file"));
      const messages = body.messages as { role: string; content: string }[];
      if (messages.at(-1)?.content === "Wait") return;
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Recovered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }));
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root,
  ], { env: { ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([["jevcode> ", "Wait\n"], ["thinking: main", "\u0003"], ["jevcode> ", "Continue\n"], ["jevcode> ", "/exit\n"]]),
  }, timeout: 20_000 });
  assert.match(result.stdout, /\[cancelled\]/);
  assert.match(result.stdout, /Recovered/);
});

test("queued input cannot preapprove a mutation and denied chat actions do not write files", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then(() => {
      const first = requests++ === 0;
      const send = (): void => {
        response.end(JSON.stringify({
          choices: [{ message: first ? { role: "assistant", content: null, tool_calls: [{
            id: "write-1", type: "function", function: { name: "write_file",
              arguments: '{"path":"no.txt","content":"no","expectedHash":null}' },
          }] } : { role: "assistant", content: "Handled queued message" }, finish_reason: first ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }));
      };
      if (first) setTimeout(send, 250);
      else send();
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--write",
  ], { env: { ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([["jevcode> ", "Create no.txt\n"], ["thinking: main", "yes\n"],
      ["Type yes to execute this exact action:", "no\n"], ["jevcode> ", "/exit\n"]]),
  }, timeout: 20_000 });
  assert.match(result.stdout, /message queued/);
  assert.match(result.stdout, /\[blocked\]/);
  assert.match(result.stdout, /Handled queued message/);
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});

test("chat executes exactly approved writes and returns to the conversation", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      const first = requests++ === 0;
      if (!first) assert.match(JSON.stringify(body.messages), /bytesWritten/);
      response.end(JSON.stringify({
        choices: [{ message: first ? { role: "assistant", content: null, tool_calls: [{
          id: "write-1", type: "function", function: { name: "write_file",
            arguments: '{"path":"approved.txt","content":"approved","expectedHash":null}' },
        }] } : { role: "assistant", content: "Write completed" }, finish_reason: first ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }));
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--write",
  ], { env: { ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([["jevcode> ", "Create approved.txt\n"],
      ["Type yes to execute this exact action:", "yes\n"], ["jevcode> ", "/exit\n"]]),
  }, timeout: 20_000 });
  assert.match(result.stdout, /Write completed/);
  assert.equal(await project.workspace.read("approved.txt"), "approved");
});

test("interactive capability authoring, skill slash invocation, and planning work without restarting", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      const index = requests++;
      const tools = (body.tools as { function: { name: string } }[]).map((item) => item.function.name);
      const messages = body.messages as { role: string; content: string }[];
      if (index === 0) {
        assert.ok(tools.includes("create_skill"));
        assert.match(messages.at(-1)!.content, /Create one reusable project skill/);
      }
      if (index === 2) assert.match(messages[0]!.content, /Use the local style guide/);
      if (index === 3) {
        assert.match(messages[0]!.content, /PLAN MODE/);
        assert.ok(!tools.some((name) => ["write_file", "run_command", "create_skill", "create_specialist"].includes(name)));
      }
      response.end(JSON.stringify({
        choices: [{ message: index === 0 ? { role: "assistant", content: null, tool_calls: [{
          id: "create-1", type: "function", function: { name: "create_skill", arguments: JSON.stringify({
            id: "style-guide", description: "Local style guidance", instructions: "Use the local style guide.",
          }) },
        }] } : { role: "assistant", content: ["", "Saved the workflow.", "Invoked the skill.", "Plan ready."][index] },
        finish_reason: index === 0 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }));
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root,
  ], { env: { ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([
      ["jevcode> ", "/permissions edit\n"], ["Type yes:", "yes\n"],
      ["jevcode> ", "/skills create Local style guidance\n"], ["Type yes to execute this exact action:", "yes\n"],
      ["jevcode> ", "/style-guide Explain the conventions\n"], ["jevcode> ", "/plan on\n"],
      ["jevcode> ", "Propose a change\n"], ["jevcode> ", "/plan off\n"], ["Type yes:", "yes\n"],
      ["jevcode> ", "/usage\n"], ["jevcode> ", "/exit\n"],
    ]),
  }, timeout: 20_000 });
  assert.equal(requests, 4);
  assert.match(result.stdout, /Invoked the skill/);
  assert.match(result.stdout, /Plan ready/);
  assert.match(result.stdout, /"runs": 3/);
  assert.match(await readFile(path.join(project.workspace.root, ".jev/skills/style-guide.json"), "utf8"), /style-guide/);
});

test("queued slash commands and queued yes cannot elevate permissions", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.ok(!(body.tools as { function: { name: string } }[]).some((tool) =>
        ["write_file", "create_skill", "run_command"].includes(tool.function.name)));
      const first = requests++ === 0;
      const send = (): void => {
        response.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Read-only response." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }));
      };
      if (first) setTimeout(send, 300);
      else send();
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root,
  ], { env: { ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([
      ["jevcode> ", "Inspect\n"], ["thinking: main", "/permissions all\nyes\n"],
      ["Type yes:", "no\n"], ["jevcode> ", "/exit\n"],
    ]),
  }, timeout: 20_000 });
  assert.equal(requests, 2);
  assert.match(result.stdout, /Permissions unchanged/);
});
