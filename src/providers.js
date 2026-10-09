// Minimal client for OpenAI-compatible /chat/completions endpoints.
async function postChatCompletion(provider, body, { label, timeoutMs }) {
  const res = await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model: provider.model, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} http ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

module.exports = { postChatCompletion };
