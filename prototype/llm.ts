// THROWAWAY PROTOTYPE — I/O boundary only. OpenAI-compatible client.
// Auto-detects provider from env: OPENROUTER_API_KEY → OpenRouter, else OPENAI_API_KEY
// → OpenAI. Override anything with LLM_BASE_URL / LLM_API_KEY / DISTILL_MODEL / EMBED_MODEL.

type Cfg = { baseUrl: string; apiKey: string; distill: string; embed: string };

function cfg(): Cfg {
  const ork = process.env.OPENROUTER_API_KEY;
  const oak = process.env.OPENAI_API_KEY;
  let baseUrl = process.env.LLM_BASE_URL;
  let apiKey = process.env.LLM_API_KEY;
  let distill = process.env.DISTILL_MODEL;
  let embed = process.env.EMBED_MODEL;
  if (!apiKey) {
    if (ork) { baseUrl ||= 'https://openrouter.ai/api/v1'; apiKey = ork; distill ||= 'openai/gpt-4o'; embed ||= 'openai/text-embedding-3-small'; }
    else if (oak) { baseUrl ||= 'https://api.openai.com/v1'; apiKey = oak; distill ||= 'gpt-4o'; embed ||= 'text-embedding-3-small'; }
  }
  if (!apiKey || !baseUrl) throw new Error('No API key. Export OPENAI_API_KEY or OPENROUTER_API_KEY.');
  return { baseUrl, apiKey, distill: distill || 'gpt-4o', embed: embed || 'text-embedding-3-small' };
}

export function modelInfo() { const c = cfg(); return { baseUrl: c.baseUrl, distill: c.distill, embed: c.embed }; }

async function post(path: string, body: unknown): Promise<any> {
  const c = cfg();
  const res = await fetch(c.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function chatJSON(system: string, user: string): Promise<any> {
  const c = cfg();
  const data = await post('/chat/completions', {
    model: c.distill,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const c = cfg();
  const data = await post('/embeddings', { model: c.embed, input: texts });
  return data.data.map((d: any) => d.embedding as number[]);
}
