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

test("full-screen multiline editor submits with Ctrl-S, sanitizes model escapes, and restores the terminal", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      requests++;
      const messages = body.messages as { content: string }[];
      assert.equal(messages.at(-1)!.content, "Line one\nLine two");
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "SCREEN_RESPONSE \u001b]52;c;POISON\u0007" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }));
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--fullscreen",
  ], { env: { ...process.env, TERM: "xterm-256color", OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_RESIZE: "[30,100]",
    JEV_PTY_PROMPTS: JSON.stringify([["jevcode>", "Line one\rLine two\u0013"], ["SCREEN_RESPONSE", "\u0003"]]),
  }, timeout: 20_000 });
  assert.equal(requests, 1);
  assert.match(result.stdout, /\u001b\[\?1049h/);
  assert.match(result.stdout, /\u001b\[\?1049l/);
  assert.doesNotMatch(result.stdout, /\u001b]52;c;POISON/);
});

test("partial pretyped yes and a queued Enter cannot approve a new plain-terminal action", { skip }, async (t) => {
  const project = await fixture(t);
  const url = await server(t, (request, response) => {
    void requestBody(request).then(() => setTimeout(() => response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{
        id: "write-1", type: "function", function: { name: "write_file",
          arguments: '{"path":"no.txt","content":"no","expectedHash":null}' },
      }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    })), 250));
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--write", "--plain",
  ], { env: { ...process.env, OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([["jevcode> ", "Write\n"], ["thinking: main", "yes"],
      ["Type yes to execute this exact action:", "\n"], ["jevcode> ", "/exit\n"]]),
  }, timeout: 20_000 });
  assert.match(result.stdout, /\[blocked\]/);
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});

for (const fullscreen of [false, true]) {
  test(`external editor previews and confirms before sending (${fullscreen ? "full-screen" : "plain"})`, { skip }, async (t) => {
    const project = await fixture(t);
    let requests = 0;
    project.config.llm.baseUrl = await server(t, (request, response) => {
      void requestBody(request).then((body) => {
        requests++;
        assert.equal((body.messages as { content: string }[]).at(-1)!.content, "Editor composed\nmultiline prompt");
        response.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "EDITOR_ACCEPTED" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }));
      });
    });
    await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
    const submit = fullscreen ? "\u0013" : "\n";
    const result = await exec("/usr/bin/python3", [
      path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root,
      fullscreen ? "--fullscreen" : "--plain",
    ], { env: { ...process.env, TERM: "xterm-256color", OPENAI_API_KEY: "fake", HOME: project.workspace.root,
      JEV_EDITOR: process.execPath,
      JEV_EDITOR_ARGS: JSON.stringify(["--eval", "require('node:fs').writeFileSync(process.argv[1], 'Editor composed\\nmultiline prompt')"]),
      JEV_PTY_PROMPTS: JSON.stringify([["jevcode>", `/editor${submit}`], [fullscreen ? "yes:" : "Type yes:", `yes${submit}`],
        fullscreen ? ["EDITOR_ACCEPTED", "\u0003"] : ["jevcode>", "/exit\n"]]),
    }, timeout: 20_000 }).catch((error: { stdout?: string }) => { t.diagnostic(error.stdout ?? "No terminal output"); throw error; });
    assert.equal(requests, 1);
    assert.match(result.stdout, /preview:/);
    if (fullscreen) assert.match(result.stdout, /\u001b\[\?1049l/);
  });
}

test("full-screen queued yes and a fresh empty submit cannot elevate permissions", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  project.config.llm.baseUrl = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      requests++;
      assert.ok(!(body.tools as { function: { name: string } }[]).some((tool) => tool.function.name === "write_file"));
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "QUEUE_SAFE" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }));
    });
  });
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--fullscreen",
  ], { env: { ...process.env, TERM: "xterm-256color", OPENAI_API_KEY: "fake", HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([["jevcode>", "/permissions all\u0013yes\u0013"], ["yes:", "\u0013"], ["QUEUE_SAFE", "\u0003"]]),
  }, timeout: 20_000 });
  assert.equal(requests, 1);
});
