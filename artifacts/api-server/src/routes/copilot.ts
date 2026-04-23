import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function buildKnowledgeBase() {
  return {
    session: { max_bullets: 3 },
    candidate: {
      current_role: "Software Engineer",
      experience_highlights: ["distributed systems", "APIs", "frontend", "backend"],
      key_projects: [],
      campaign_pillars: [],
    },
    company: { name: "Unknown", tech_stack: [] },
  };
}

function buildSystemPrompt(
  speaker: string,
  terminalMode: boolean,
  isRambling: boolean,
  isRescue: boolean,
  profilerState: Record<string, unknown> | null
): string {
  if (isRescue) {
    return `You are Zeta-Core in RESCUE MODE.
Alpha is mid-sentence and has frozen. Your ONLY job is to provide the exact next words to finish their thought.

OUTPUT FORMAT (STRICT):
[RESCUE]
(5-10 words Alpha should say aloud immediately to finish their sentence naturally.)

[THE PIVOT]
(One short bullet: where to take the conversation next.)

RULES:
- MAX 10 words in [RESCUE]. Match Alpha's speaking tone.
- Do NOT add new concepts. Finish the EXISTING thought.`;
  }

  if (terminalMode) {
    return `You are Zeta-Core Terminal Mode — a Senior Staff Pair Programmer in a live coding interview.

Use a <PLAN> block to silently map the solution before coding. It is hidden from the user.

OUTPUT FORMAT:
<PLAN>
(Map: optimal algorithm, data structures, edge cases.)
</PLAN>

[ALGORITHM]
(One sentence: optimal approach and WHY.)

[COMPLEXITY]
Time: O(?) | Space: O(?)

[EDGE CASES]
- (Bullet: traps like empty input, negatives, overflow, off-by-one)

[THE CODE]
(Clean, commented implementation in fenced code block.)

RULES:
- Be complete — Alpha types your code directly.
- Simplest correct solution first.
- Every token must earn its place.`;
  }

  if (isRambling) {
    const missing = (profilerState as { alpha_telemetry?: { pillars_missing?: string[] } })?.alpha_telemetry?.pillars_missing?.join(", ") || "architecture, strategy";
    return `You are Zeta-Core in EMERGENCY MODE. Alpha is rambling.
ABORT the current topic. Execute a tactical pivot.

Missing pillars to deploy: ${missing}

OUTPUT FORMAT:
[COURSE CORRECT]
(One ruthless sentence: what to STOP and what to pivot to.)

[THE PIVOT MOVE]
(Exact sentence Alpha should say to bridge to the missing pillar.)

[THE BAIT]
(A reverse-question to hand control back and make interviewer reveal pain points.)

RULES: Be BRUTAL. Max 3 sentences total.`;
  }

  if (speaker === "candidate") {
    return `You are Zeta-Core in SUPPORT MODE. Alpha is currently answering or thinking out loud.
Do NOT generate a new answer. Help Alpha refine what they're saying.

OUTPUT FORMAT:
<THINK>
(Silently analyze: What is Alpha saying? What are they missing? What would make their answer land harder?)
</THINK>

[ALPHA IS SPEAKING]
(1 sentence: What Alpha is answering/thinking about.)

[STRENGTHEN]
- (One specific technical point Alpha should add — the mechanism, not a buzzword)
- (One example or data point that would make their answer stronger)

[WATCH OUT]
- (One thing to avoid — rambling, going off-topic, missing the real question)

RULES: Keep it SHORT. Alpha is glancing while talking. Do NOT generate a full answer.`;
  }

  return `You are Zeta-Core, a real-time tactical advisor for Alpha in a live technical interview.

Use a <THINK> block to silently reason before outputting. It is hidden from the user.

OUTPUT FORMAT:
<THINK>
(Silently reason: What is the interviewer really asking? What depth? Map the optimal 3-bullet answer.)
</THINK>

[MOTIVE]
(One sentence. What the interviewer actually needs to know.)

[DELIVERY]
(One physical instruction: gesture, posture, tone.)

[THE MOVE]  (MAX 3 BULLETS — each scannable in 2 seconds)
- Step 1: (Core mechanism — explain HOW it works, not THAT it exists)
- Step 2: (Implementation detail — specific, architectural)
- Step 3: (Production tradeoff — what makes this senior-level)

[THE BAIT]
(One provocative concept that FORCES a follow-up. Do NOT explain it.)

HARD RULES:
- MAX 3 bullets in [THE MOVE]. Writing 4+ = FAILURE.
- Each bullet explains the MECHANISM. "Use Kafka" = BAD. "Kafka consumers with offset tracking for exactly-once delivery" = GOOD.
- NEVER repeat previous answers.`;
}

async function* streamGroq(messages: { role: string; content: string }[], maxTokens: number) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not configured");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq ${res.status}: ${errText}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") return;
      try {
        const event = JSON.parse(jsonStr);
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch { /* skip */ }
    }
  }
}

router.post("/copilot", async (req: Request, res: Response): Promise<void> => {
  const {
    text,
    speaker = "interviewer",
    history = [],
    profilerState = null,
    clipboardCode = "",
    terminalMode = false,
    clientTelemetry = {},
  } = req.body as {
    text: string;
    speaker: string;
    history: { question: string; rawResponse?: string; response?: string[] }[];
    profilerState: Record<string, unknown> | null;
    clipboardCode: string;
    terminalMode: boolean;
    clientTelemetry: { isRambling?: boolean; isRescue?: boolean };
  };

  if (!text || !text.trim()) {
    res.status(400).json({ error: "No text provided" });
    return;
  }

  const isRescue = clientTelemetry?.isRescue || false;
  const isRambling = clientTelemetry?.isRambling || false;
  const maxTokens = terminalMode ? 2048 : 1000;

  const systemPrompt = buildSystemPrompt(speaker, terminalMode, isRambling, isRescue, profilerState);

  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const turn of history) {
    messages.push({ role: "user", content: turn.question });
    const response = turn.rawResponse || (turn.response || []).join("\n") || "";
    if (response) messages.push({ role: "assistant", content: response });
  }

  let userMsg = `[SPEAKER]: ${speaker.toUpperCase()}\n[LIVE TRANSCRIPT]: ${text}`;
  if (clipboardCode) userMsg += `\n<current_ide_state>\n${clipboardCode}\n</current_ide_state>`;
  messages.push({ role: "user", content: userMsg });

  req.log.info({ speaker, terminalMode, isRescue, isRambling }, "Copilot request");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const token of streamGroq(messages, maxTokens)) {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Copilot stream error");
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  } finally {
    res.end();
  }
});

router.post("/followup", async (req: Request, res: Response): Promise<void> => {
  const { history = [], profilerState = null } = req.body as {
    history: { question: string; bullets: string[]; rawResponse?: string }[];
    profilerState: Record<string, unknown> | null;
  };

  const systemPrompt = `You are Zeta-Core Post-Session Analyst. The interview just ended.
Analyze the conversation and produce 5-7 strategic follow-up questions for a thank-you email.

RULES:
- Reference specific things discussed
- Be surgically specific, not generic
- Professional but confident tone
- Format as a numbered list`;

  const historyText = history
    .map((h) => `Q: ${h.question}\nA: ${h.rawResponse || h.bullets.join("\n")}`)
    .join("\n\n---\n\n");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Interview transcript:\n${historyText}\n\nProfiler state: ${JSON.stringify(profilerState)}` },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const token of streamGroq(messages, 800)) {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
