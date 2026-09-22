const payload = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fake-test-account" },
})).toString("base64url");

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  }));
  if (url === "https://github.com/login/device/code") {
    return json({
      device_code: "fake-device", user_code: "FAKE-CODE",
      verification_uri: "https://github.com/login/device", interval: 1, expires_in: 30,
    });
  }
  if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "fake-github-refresh" });
  if (url === "https://api.github.com/copilot_internal/v2/token") {
    return json({ token: "fake-copilot-access", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.startsWith("https://api.individual.githubcopilot.com/models/") && url.endsWith("/policy")) {
    return json({});
  }
  if (url === "https://auth.openai.com/oauth/token") {
    if (String(init?.body).includes("refresh_token=invalid")) {
      return json({ access_token: "SENSITIVE_PROVIDER_RESPONSE" });
    }
    return json({ access_token: `header.${payload}.signature`, refresh_token: "fake-rotated", expires_in: 3600 });
  }
  throw new Error("Unexpected URL in offline OAuth test; network access is disabled");
};
