import assert from "node:assert/strict";
import { loginPrompt } from "../../src/terminal.js";

const signal = AbortSignal.timeout(6000);
const answer = await loginPrompt(
  "This is a deliberately long explanation that wraps across a normal terminal before the question. Confirm long prompt? [yes/no]",
  false, signal,
);
assert.equal(answer, "yes");
const secret = await loginPrompt("Paste the test login value (input hidden):", true, signal);
assert.equal(secret, "SYNTHETIC_HIDDEN_INPUT");
console.log("Terminal input verified");
