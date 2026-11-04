// One place that talks to Gemini, shared by nl-to-sql and project-info.
//
// Tried in order. Google retires older models for new keys and the newest one
// often returns 503 "high demand" on the free tier, so fall through on
// 404/429/503/timeouts/unparseable replies rather than failing the request.
// gemini-3.8-flash is left out: on the free tier it often hangs 40s+ before
// failing. Free tier allows only ~20 requests/day PER MODEL, and each model
// has its own allowance — so a longer chain = more free questions per day
// (an exhausted model 429s in <1s). 3.5-flash-lite goes first: on a casual
// Hinglish/typo test set it matched 3.5-flash quality at ~1.4s (Nov 2026).
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
const PER_MODEL_TIMEOUT_MS = 15_000;

export interface GeminiTurn {
  role: 'user' | 'model';
  text: string;
}

/** Pulls the JSON object out of the model text, tolerating fences or stray prose around it. */
function parseJsonObject<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

/**
 * Asks Gemini for a JSON object matching `responseSchema` (structured output,
 * so replies always parse). `turns` is the conversation, last one = the new
 * request from the user.
 */
export async function geminiJson<T>(
  apiKey: string,
  system: string,
  turns: GeminiTurn[],
  responseSchema: Record<string, unknown>,
  temperature = 0.1,
): Promise<T> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature,
      // Low thinking: short structured answers don't need deep reasoning, and
      // the default level roughly triples latency.
      thinkingConfig: { thinkingLevel: 'low' },
    },
  });
  let lastStatus = 0;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS),
      });
    } catch (e) {
      console.error('Gemini timeout/network', model, e);
      lastStatus = 503;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text ?? '')
        .join('')
        .trim();
      const parsed = parseJsonObject<T>(text);
      if (parsed) return parsed;
      // Unparseable (empty, cut off, blocked…) — log what came back, try the next model.
      console.error('Gemini unparseable', model, cand?.finishReason, text.slice(0, 500));
      lastStatus = 422;
      continue;
    }
    lastStatus = res.status;
    const detail = await res.json().then((d) => d?.error?.message as string | undefined).catch(() => undefined);
    console.error('Gemini error', model, res.status, detail);
    if (/api key/i.test(detail ?? '')) throw new Error('The AI key on the server is not valid — reset GEMINI_API_KEY.');
    if (![404, 429, 503].includes(res.status)) {
      throw new Error(`AI request failed (${res.status})${detail ? `: ${detail.slice(0, 100)}` : ''}`);
    }
  }
  if (lastStatus === 429) throw new Error("Today's free AI limit is used up — it resets daily. Try again later.");
  if (lastStatus === 422) throw new Error('Could not understand that as a query — try rephrasing.');
  throw new Error('The AI service is busy right now — try again in a minute.');
}
