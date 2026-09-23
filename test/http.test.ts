import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { getJson, getText, postJson } from "../src/http.js";
import { server } from "./helpers.js";

test("HTTP timeouts survive garbage collection while stalled headers or bodies are pending", async () => {
  const source = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { postJson } from './src/http.ts';
    const server = createServer((request, response) => {
      if (request.url === '/body') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"pending":');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    const gc = setInterval(() => global.gc(), 5);
    const safety = setTimeout(() => server.closeAllConnections(), 2500);
    try {
      for (const target of ['/headers', '/body']) {
        const started = Date.now();
        const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
          postJson('http://127.0.0.1:' + server.address().port + target, 'fake', {}, controller.signal, 150)));
        assert.ok(Date.now() - started < 2000, 'Request deadline was lost');
        assert.ok(results.every(result => result.status === 'rejected' &&
          ['TimeoutError', 'AbortError'].includes(result.reason.name)));
      }
    } finally {
      clearInterval(gc); clearTimeout(safety); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `;
  await promisify(execFile)(process.execPath,
    ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", source], { timeout: 8000 });
});

test("HTTP caller cancellation rejects promptly and pre-aborted calls never contact the endpoint", async (t) => {
  let contacted!: () => void;
  const request = new Promise<void>((resolve) => { contacted = resolve; });
  let requests = 0;
  const url = await server(t, () => { requests++; contacted(); });
  const controller = new AbortController();
  const work = postJson(url, "fake", {}, controller.signal, 5000);
  const rejected = assert.rejects(work, /explicit cancellation/);
  await request;
  controller.abort(new Error("explicit cancellation"));
  await rejected;
  await assert.rejects(postJson(url, "fake", {}, controller.signal, 5000), /explicit cancellation/);
  assert.equal(requests, 1);
});

test("HTTP rejects redirects and bounds decompressed responses without exposing raw response text", async (t) => {
  let followed = false;
  const url = await server(t, (request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/target" }); response.end(); return;
    }
    if (request.url === "/target") followed = true;
    response.writeHead(200, { "Content-Encoding": "gzip" });
    response.end(gzipSync(request.url === "/overflow" ? "x".repeat(2_000_001) : '{"ok":true}'));
  });

  const signal = new AbortController().signal;
  assert.deepEqual(await postJson(`${url}/gzip`, "fake", {}, signal, 1000), { ok: true });
  await assert.rejects(postJson(`${url}/overflow`, "fake", {}, signal, 1000), /size limit/);
  await assert.rejects(postJson(`${url}/redirect`, "fake", {}, signal, 1000), /HTTP 302/);
  assert.equal(followed, false);
});

test("public GET requests carry no credentials, enforce limits and support cancellation", async (t) => {
  const url = await server(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["user-agent"], "jev-code");
    if (request.url === "/stall") { response.writeHead(200); response.write("pending"); return; }
    if (request.url === "/binary") { response.end(Buffer.from([0xff])); return; }
    response.end('{"ok":true}');
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await getJson(url, signal), { ok: true });
  assert.equal(await getText(url, signal), '{"ok":true}');
  await assert.rejects(getText(`${url}/binary`, signal), /encoded data/);
  await assert.rejects(getText(`${url}/stall`, signal, 50), /timed out/);
});
