// Pure parsers for NON-streaming provider responses, used by the Android platform
// layer (CapacitorHttp buffers whole bodies — no SSE in the WebView). Kept separate
// from the Capacitor glue so vitest can cover them in the node environment.
import type { FinishReason } from '../../electron/shared';
import { normalizeFinishReason } from '../../electron/providers';

export interface ParsedAnswer {
 text: string;
 reasoning: string;
 promptTokens: number | null;
 completionTokens: number | null;
 finishReason: FinishReason;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A provider error body surfaced as a short readable message.
export function apiErrorMessage(status: number, body: unknown): string {
 const b = asRec(body);
 const err = asRec(b.error);
 const msg = typeof err.message === 'string' ? err.message : typeof b.message === 'string' ? b.message : '';
 return `HTTP ${status}${msg ? ': ' + msg.slice(0, 300) : ''}`;
}

export function parseOpenAiAnswer(body: unknown): ParsedAnswer {
 const choice = asRec(asArr(asRec(body).choices)[0]);
 const msg = asRec(choice.message);
 const text = typeof msg.content === 'string' ? msg.content
  : asArr(msg.content).map(p => asRec(p).text ?? '').join('');
 // DeepSeek/Groq reasoning models expose the chain-of-thought separately.
 const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
 const usage = asRec(asRec(body).usage);
 return {
  text,
  reasoning,
  promptTokens: num(usage.prompt_tokens),
  completionTokens: num(usage.completion_tokens),
  finishReason: normalizeFinishReason(typeof choice.finish_reason === 'string' ? choice.finish_reason : null),
 };
}

export function parseAnthropicAnswer(body: unknown): ParsedAnswer {
 const b = asRec(body);
 let text = '';
 let reasoning = '';
 for (const block of asArr(b.content)) {
  const blk = asRec(block);
  if (blk.type === 'text' && typeof blk.text === 'string') text += blk.text;
  else if (blk.type === 'thinking' && typeof blk.thinking === 'string') reasoning += blk.thinking;
 }
 const usage = asRec(b.usage);
 return {
  text,
  reasoning,
  promptTokens: num(usage.input_tokens),
  completionTokens: num(usage.output_tokens),
  finishReason: normalizeFinishReason(typeof b.stop_reason === 'string' ? b.stop_reason : null),
 };
}

export function parseGeminiAnswer(body: unknown): ParsedAnswer {
 const cand = asRec(asArr(asRec(body).candidates)[0]);
 let text = '';
 let reasoning = '';
 for (const part of asArr(asRec(cand.content).parts)) {
  const p = asRec(part);
  if (typeof p.text !== 'string') continue;
  if (p.thought === true) reasoning += p.text; else text += p.text;
 }
 const usage = asRec(asRec(body).usageMetadata);
 const prompt = num(usage.promptTokenCount);
 const completion = num(usage.candidatesTokenCount);
 const thoughts = num(usage.thoughtsTokenCount);
 return {
  text,
  reasoning,
  promptTokens: prompt,
  completionTokens: completion !== null || thoughts !== null ? (completion ?? 0) + (thoughts ?? 0) : null,
  finishReason: normalizeFinishReason(typeof cand.finishReason === 'string' ? cand.finishReason : null),
 };
}
