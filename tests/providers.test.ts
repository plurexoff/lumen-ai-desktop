import {describe,expect,it} from 'vitest';
import {
 parseSseEvent,parseReasoningEvent,parseUsageEvent,parseAnthropicUsage,
 parseFinishReason,parseAnthropicFinish,normalizeFinishReason,
 validateProviderUrl,isSafeExternalUrl,isLoopbackUrl,
 normalizeModelIds,mergeModelIds,MAX_MODELS_PER_PROVIDER,MAX_MESSAGE_CHARS,
 stripGeminiModelPrefix,trimHistory,normalizeHistory,
 isOpenAiReasoningModel,isGeminiThinkingModel,GEMINI_THINKING_BUDGET,
 isAnthropicThinkingModel,ANTHROPIC_THINKING_BUDGETS,GEMINI_THINKING_BUDGETS,
 isKnownProviderId,validateProviderConfig,validateChatRequest,clampSettings,
 isValidHotkey,normalizeHotkeys,validatePersonas,cleanTitle,
 validatePricing,cleanEnhanced,DEFAULT_PRICING,ENHANCE_PROMPT,
 buildModelsRequest,buildChatRequest,type ResolvedProvider,
 parseToolCallDelta,parseAnthropicToolEvent,parseGeminiToolCall,
} from '../electron/providers';
import type {ProviderId} from '../electron/shared';
import {DEFAULT_HOTKEYS,MAX_ATTACHMENT_BYTES,MAX_IMAGE_ATTACHMENTS} from '../electron/shared';

const openai:ResolvedProvider={id:'openai',name:'OpenAI',url:'https://api.openai.com/v1',key:'sk-test'};
const anthropic:ResolvedProvider={id:'anthropic',name:'Anthropic',url:'https://api.anthropic.com/v1',key:'sk-ant'};
const gemini:ResolvedProvider={id:'gemini',name:'Gemini',url:'https://generativelanguage.googleapis.com/v1beta',key:'SECRET-KEY-XYZ'};
const ollama:ResolvedProvider={id:'ollama',name:'Ollama',url:'http://127.0.0.1:11434/v1',key:''};
const openrouter:ResolvedProvider={id:'openrouter',name:'OpenRouter',url:'https://openrouter.ai/api/v1',key:'sk-or'};

describe('SSE provider events',()=>{
 it('reads OpenAI-compatible delta text',()=>expect(parseSseEvent('data: {"choices":[{"delta":{"content":"hello"}}]}')).toBe('hello'));
 it('reads Anthropic delta text',()=>expect(parseSseEvent('data: {"type":"content_block_delta","delta":{"text":"world"}}')).toBe('world'));
 it('reads Gemini candidate text',()=>expect(parseSseEvent('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}')).toBe('hi'));
 // Gemini splits one turn across several parts; only parts[0] used to be read.
 it('joins every non-thought Gemini part',()=>expect(parseSseEvent('data: {"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"},{"text":"t","thought":true}]}}]}')).toBe('ab'));
 it('does not leak Gemini thought parts into the answer',()=>expect(parseSseEvent('data: {"candidates":[{"content":{"parts":[{"text":"secret","thought":true}]}}]}')).toBeNull());
 it('reads Gemini thought parts as reasoning',()=>expect(parseReasoningEvent('data: {"candidates":[{"content":{"parts":[{"text":"hmm","thought":true}]}}]}')).toBe('hmm'));
 it('ignores terminal and malformed events',()=>{expect(parseSseEvent('data: [DONE]')).toBeNull();expect(parseSseEvent('data: {')).toBeNull();});
});

describe('reasoning deltas',()=>{
 it('surfaces chain-of-thought from reasoning models',()=>expect(parseReasoningEvent('data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}')).toBe('let me think'));
 it('ignores ordinary content deltas',()=>expect(parseReasoningEvent('data: {"choices":[{"delta":{"content":"answer"}}]}')).toBeNull());
 it('ignores malformed events',()=>expect(parseReasoningEvent('data: {')).toBeNull());
});

describe('finish reason',()=>{
 it('reads the OpenAI finish_reason',()=>expect(parseFinishReason('data: {"choices":[{"finish_reason":"length"}]}')).toBe('length'));
 it('reads the Gemini finishReason',()=>expect(parseFinishReason('data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}')).toBe('length'));
 it('reads the Anthropic stop_reason from message_delta',()=>{
  expect(parseAnthropicFinish('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}')).toBe('stop');
  expect(parseAnthropicFinish('data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}')).toBe('length');
 });
 it('ignores Anthropic stop_reason on other envelopes',()=>expect(parseAnthropicFinish('data: {"type":"content_block_delta","delta":{"stop_reason":"end_turn"}}')).toBeNull());
 it('maps provider-specific vocabulary onto one enum',()=>{
  expect(normalizeFinishReason('SAFETY')).toBe('content_filter');
  expect(normalizeFinishReason('RECITATION')).toBe('content_filter');
  expect(normalizeFinishReason('refusal')).toBe('refusal');
  expect(normalizeFinishReason('stop_sequence')).toBe('stop');
 });
 // A missing signal must not be reported as a clean stop, or the truncation warning
 // would be wrong on proxies that never send one.
 it('reports unknown signals as null, not as a clean stop',()=>{
  expect(normalizeFinishReason('weird')).toBeNull();
  expect(normalizeFinishReason(undefined)).toBeNull();
  expect(parseFinishReason('data: {"choices":[{"delta":{"content":"x"}}]}')).toBeNull();
 });
});

describe('token usage',()=>{
 it('reads OpenAI usage',()=>expect(parseUsageEvent('data: {"usage":{"prompt_tokens":11,"completion_tokens":22}}')).toEqual({promptTokens:11,completionTokens:22}));
 it('reads Gemini usageMetadata',()=>expect(parseUsageEvent('data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":7}}')).toEqual({promptTokens:5,completionTokens:7}));
 it('returns null when no usage is present',()=>expect(parseUsageEvent('data: {"choices":[{"delta":{"content":"x"}}]}')).toBeNull());
 it('accumulates Anthropic usage across start and delta',()=>{
  let u=parseAnthropicUsage('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',null);
  expect(u).toEqual({promptTokens:10,completionTokens:1});
  u=parseAnthropicUsage('data: {"type":"message_delta","usage":{"output_tokens":4}}',u);
  expect(u).toEqual({promptTokens:10,completionTokens:4});
 });
});

describe('provider URL validation',()=>{
 it('accepts HTTPS endpoints',()=>expect(validateProviderUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1'));
 it('rejects plain HTTP for remote hosts and embedded credentials',()=>{expect(()=>validateProviderUrl('http://example.com:3000')).toThrow('HTTPS');expect(()=>validateProviderUrl('https://user:pass@example.com')).toThrow('Credentials');});
 it('allows loopback HTTP for local servers (Ollama/LM Studio)',()=>{
  expect(validateProviderUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  expect(validateProviderUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
 });
 it('still forbids credentials on loopback',()=>expect(()=>validateProviderUrl('http://user:pass@localhost:11434')).toThrow('Credentials'));
 it('detects loopback hosts',()=>{
  expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
  expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false);
  expect(isLoopbackUrl('not a url')).toBe(false);
 });
});

describe('external URL allow-list',()=>{
 it('allows web protocols only',()=>{
  expect(isSafeExternalUrl('https://example.com')).toBe(true);
  expect(isSafeExternalUrl('http://example.com')).toBe(true);
  expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true);
 });
 // Without this filter a single click could run an arbitrary Windows protocol handler.
 it('refuses protocol handlers that can execute locally',()=>{
  expect(isSafeExternalUrl('search-ms:query=evil')).toBe(false);
  expect(isSafeExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false);
  expect(isSafeExternalUrl('file:///C:/Windows/system32/cmd.exe')).toBe(false);
 });
 it('refuses malformed values',()=>{expect(isSafeExternalUrl('')).toBe(false);expect(isSafeExternalUrl('https://')).toBe(false);});
});

describe('model list management',()=>{
 it('trims and deduplicates model IDs',()=>expect(normalizeModelIds([' model-a ','','model-a','model-b'])).toEqual(['model-a','model-b']));
 it('rejects unreasonable or malformed IDs',()=>{
  expect(()=>normalizeModelIds(['x'.repeat(201)])).toThrow('under 200');
  expect(()=>normalizeModelIds(Array.from({length:MAX_MODELS_PER_PROVIDER+1},(_,i)=>`m${i}`))).toThrow('at most '+MAX_MODELS_PER_PROVIDER);
 });
 // OpenRouter lists several hundred models, so 200 was too tight and made the whole
 // refresh fail; the ceiling is now high enough for real gateways.
 it('accepts a large gateway model list',()=>{
  const many=Array.from({length:400},(_,i)=>`vendor/model-${i}`);
  expect(normalizeModelIds(many)).toHaveLength(400);
 });
 it('rejects control characters in IDs',()=>expect(()=>normalizeModelIds(['bad\nid'])).toThrow('control characters'));
 it('merges discovered models without dropping manual IDs',()=>expect(mergeModelIds(['manual-id','shared'],['remote-id','shared'])).toEqual(['manual-id','shared','remote-id']));
});

describe('history trimming and normalization',()=>{
 it('keeps everything under the limit',()=>{const h=Array.from({length:5},(_,i)=>({role:'user',content:String(i)}));expect(trimHistory(h,10)).toBe(h);});
 it('keeps the most recent messages when over the limit',()=>{const h=Array.from({length:10},(_,i)=>({role:'user',content:String(i)}));expect(trimHistory(h,4)).toEqual(h.slice(6));});
 // A failed send leaves an orphan user row; two neighbours of the same role are a 400
 // on Anthropic, so they must be merged rather than sent as-is.
 it('merges neighbouring turns of the same role',()=>{
  expect(normalizeHistory([{role:'user',content:'a'},{role:'user',content:'b'}])).toEqual([{role:'user',content:'a\n\nb'}]);
 });
 it('drops blank messages',()=>{
  expect(normalizeHistory([{role:'user',content:'  '},{role:'assistant',content:'x'}])).toEqual([]);
 });
 it('drops a leading assistant turn',()=>{
  expect(normalizeHistory([{role:'assistant',content:'x'},{role:'user',content:'q'}])).toEqual([{role:'user',content:'q'}]);
 });
 it('drops a trailing assistant turn unless prefilling',()=>{
  const h=[{role:'user',content:'q'},{role:'assistant',content:'partial'}];
  expect(normalizeHistory(h)).toEqual([{role:'user',content:'q'}]);
  expect(normalizeHistory(h,{allowTrailingAssistant:true})).toEqual(h);
 });
 it('normalizes after trimming so a trimmed leading assistant cannot survive',()=>{
  const h=[{role:'assistant',content:'old'},...Array.from({length:5},(_,i)=>({role:i%2?'assistant':'user',content:'c'+i}))];
  const trimmed=trimHistory(h,4);
  expect(normalizeHistory(trimmed)[0].role).toBe('user');
 });
});

describe('reasoning model detection',()=>{
 it('recognises OpenAI reasoning models behind a gateway prefix',()=>{
  expect(isOpenAiReasoningModel('o3-mini')).toBe(true);
  expect(isOpenAiReasoningModel('openai/o3-mini')).toBe(true);
  expect(isOpenAiReasoningModel('gpt-5-pro')).toBe(true);
 });
 it('does not mistake ordinary models for reasoning ones',()=>{
  expect(isOpenAiReasoningModel('gpt-4o-mini')).toBe(false);
  expect(isOpenAiReasoningModel('ocean-model')).toBe(false);
 });
 it('recognises Gemini thinking models',()=>{
  expect(isGeminiThinkingModel('gemini-2.5-pro')).toBe(true);
  expect(isGeminiThinkingModel('gemini-2.0-flash')).toBe(false);
 });
});

describe('IPC input validation',()=>{
 it('accepts the known provider ids',()=>{expect(isKnownProviderId('ollama')).toBe(true);expect(isKnownProviderId('nope')).toBe(false);expect(isKnownProviderId(7)).toBe(false);});
 // Multiple custom providers get generated "custom-<slug>" ids; the shape is
 // enforced so nothing weird becomes a DB key.
 it('accepts generated custom provider ids and rejects lookalikes',()=>{
  expect(isKnownProviderId('custom')).toBe(true);
  expect(isKnownProviderId('custom-a1b2c3d4')).toBe(true);
  expect(isKnownProviderId('custom-')).toBe(false);
  expect(isKnownProviderId('custom-A1')).toBe(false);
  expect(isKnownProviderId('custom_1')).toBe(false);
  expect(isKnownProviderId('custom-'+('x'.repeat(39)))).toBe(true);
  expect(isKnownProviderId('custom-'+('x'.repeat(40)))).toBe(false);
 });
 it('accepts a config for a generated custom provider id',()=>{
  const c=validateProviderConfig({id:'custom-a1b2c3d4',name:'Second box',baseUrl:'https://api2.example.com/v1',models:['m']},pinned);
  expect(c.id).toBe('custom-a1b2c3d4');
  expect(c.baseUrl).toBe('https://api2.example.com/v1');
 });

 const pinned=new Map<ProviderId,string>([['openai','https://api.openai.com/v1']]);

 it('accepts a well-formed custom provider',()=>{
  const c=validateProviderConfig({id:'custom',name:'Mine',baseUrl:'https://api.example.com/v1',models:['a','a']},pinned);
  expect(c).toEqual({id:'custom',name:'Mine',baseUrl:'https://api.example.com/v1',models:['a']});
 });
 // Substituting the base URL of a built-in provider would send the real decrypted key
 // to an attacker-controlled host on the next message.
 it('refuses to repoint a built-in provider',()=>{
  expect(()=>validateProviderConfig({id:'openai',name:'OpenAI',baseUrl:'https://evil.example/v1',models:[]},pinned)).toThrow('cannot be changed');
 });
 it('accepts the pinned URL for a built-in provider',()=>{
  expect(validateProviderConfig({id:'openai',name:'OpenAI',baseUrl:'https://api.openai.com/v1',models:[]},pinned).baseUrl).toBe('https://api.openai.com/v1');
 });
 it('rejects malformed provider configs',()=>{
  expect(()=>validateProviderConfig(null,pinned)).toThrow('Invalid provider configuration');
  expect(()=>validateProviderConfig({id:'openai',name:'   ',baseUrl:'https://api.openai.com/v1'},pinned)).toThrow('name is required');
  expect(()=>validateProviderConfig({id:'bogus',name:'x',baseUrl:'https://api.openai.com/v1'},pinned)).toThrow('Unknown provider');
 });
 it('drops non-string entries from the model list',()=>{
  expect(validateProviderConfig({id:'custom',name:'Mine',baseUrl:'https://a.example/v1',models:['ok',null,5]},pinned).models).toEqual(['ok']);
 });

 it('validates a chat request and clamps its numbers',()=>{
  const r=validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'gpt-4o',content:'hi',temperature:99,maxTokens:'x',topP:-1});
  expect(r.temperature).toBe(2);
  expect(r.maxTokens).toBe(2048);
  expect(r.topP).toBe(0);
 });
 it('rejects a chat request with a bad provider or missing text field',()=>{
  expect(()=>validateChatRequest({requestId:'rq',chatId:'c1',providerId:'bogus',model:'m',content:'hi'})).toThrow('Unknown provider');
  expect(()=>validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:7})).toThrow('Message is empty');
 });
 it('keeps only the ids it was given',()=>{
  const r=validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'hi',regenerateMessageId:'x',continueMessageId:5});
  expect(r.regenerateMessageId).toBe('x');
  expect(r.continueMessageId).toBeUndefined();
 });
 // Edit-and-resend deletes the conversation tail as part of the request; the id must
 // survive validation or the truncation would silently not happen.
 it('carries truncateFromMessageId through and drops a malformed one',()=>{
  expect(validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'hi',truncateFromMessageId:'msg9'}).truncateFromMessageId).toBe('msg9');
  expect(validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'hi',truncateFromMessageId:7}).truncateFromMessageId).toBeUndefined();
 });
 // An unbounded message body could OOM the renderer on a large file drop and then make
 // every debounced re-export of the whole DB heavier.
 it('rejects an over-long message body',()=>{
  expect(()=>validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'x'.repeat(MAX_MESSAGE_CHARS+1)})).toThrow('too long');
  expect(validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'x'.repeat(MAX_MESSAGE_CHARS)}).content).toHaveLength(MAX_MESSAGE_CHARS);
 });

 it('clamps stored settings and drops unknown keys',()=>{
  expect(clampSettings({theme:'neon',temperature:'hot',maxTokens:1e9,topP:2,evil:'x'})).toEqual({theme:'dark',temperature:0.7,maxTokens:32000,topP:1});
  expect(clampSettings({theme:'light'})).toEqual({theme:'light'});
 });
});

describe('request building',()=>{
 it('never puts the Gemini key in the URL',()=>{
  const models=buildModelsRequest(gemini);
  expect(models.url).not.toContain('SECRET-KEY-XYZ');
  expect(models.headers['x-goog-api-key']).toBe('SECRET-KEY-XYZ');
  const chat=buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini-2.0-flash'});
  expect(chat.url).not.toContain('key=');
  expect(chat.url).not.toContain('SECRET-KEY-XYZ');
  expect(chat.headers['x-goog-api-key']).toBe('SECRET-KEY-XYZ');
 });
 it('builds an Anthropic streaming request with a system prompt',()=>{
  const r=buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude',systemPrompt:'be kind'});
  expect(r.url).toBe('https://api.anthropic.com/v1/messages');
  const body=r.body as {stream:boolean;system:string;messages:Array<{role:string}>};
  expect(body.stream).toBe(true);expect(body.system).toBe('be kind');
 });
 it('builds an OpenAI-compatible request with system message',()=>{
  const r=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o',systemPrompt:'be brief'});
  expect(r.url).toBe('https://api.openai.com/v1/chat/completions');
  const body=r.body as {stream:boolean;messages:Array<{role:string;content:string}>};
  expect(body.stream).toBe(true);
  expect(body.messages[0]).toEqual({role:'system',content:'be brief'});
 });
 // Without stream_options the whole OpenAI family never reports usage at all, so the
 // token counters stayed empty for five of the seven cloud providers.
 it('asks OpenAI-compatible servers for usage in the stream',()=>{
  const body=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o'}).body as {stream_options?:{include_usage:boolean}};
  expect(body.stream_options).toEqual({include_usage:true});
 });
 // o-series / gpt-5 reject temperature and top_p with HTTP 400.
 it('omits sampling params and uses max_completion_tokens for reasoning models',()=>{
  const body=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'openai/o3-mini',temperature:0.9,maxTokens:4096}).body as Record<string,unknown>;
  expect(body.temperature).toBeUndefined();
  expect(body.top_p).toBeUndefined();
  expect(body.max_completion_tokens).toBe(4096);
  expect(body.max_tokens).toBeUndefined();
 });
 it('keeps sampling params for ordinary models',()=>{
  const body=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o',temperature:0.9}).body as Record<string,unknown>;
  expect(body.temperature).toBe(0.9);
  expect(body.max_tokens).toBe(2048);
 });
 // Thinking budget is deducted from maxOutputTokens, so a 2048 request can end on
 // MAX_TOKENS without a single visible token.
 it('raises the token budget and sets a thinking budget for Gemini thinking models',()=>{
  const body=buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini-2.5-pro',maxTokens:2048}).body as {generationConfig:{maxOutputTokens:number;thinkingConfig?:{thinkingBudget:number}}};
  expect(body.generationConfig.maxOutputTokens).toBe(2048+GEMINI_THINKING_BUDGET);
  expect(body.generationConfig.thinkingConfig).toEqual({thinkingBudget:GEMINI_THINKING_BUDGET});
 });
 it('leaves the token budget alone for non-thinking Gemini models',()=>{
  const body=buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini-2.0-flash',maxTokens:2048}).body as {generationConfig:{maxOutputTokens:number;thinkingConfig?:unknown}};
  expect(body.generationConfig.maxOutputTokens).toBe(2048);
  expect(body.generationConfig.thinkingConfig).toBeUndefined();
 });
 it('encodes the model id in the Gemini URL',()=>{
  expect(buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini/2.5 pro'}).url).toContain('gemini%2F2.5%20pro');
 });
 // Gemini's ListModels returns ids already carrying a "models/" prefix while the
 // generate URL prepends that segment itself, so an unstripped refreshed id 404s as
 // models/models/gemini-2.5-flash and Refresh models breaks the provider entirely.
 it('strips the models/ prefix Gemini returns from ListModels',()=>{
  expect(stripGeminiModelPrefix('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
  expect(stripGeminiModelPrefix('gemini-2.0-flash')).toBe('gemini-2.0-flash');
  expect(buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'models/gemini-2.5-flash'}).url)
   .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
 });
 // A prefixed id must still be recognised as a thinking model, or the thinking budget
 // would be dropped and the answer truncated with no visible tokens.
 it('detects a thinking model behind the models/ prefix',()=>{
  const body=buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'models/gemini-2.5-pro',maxTokens:2048}).body as {generationConfig:{maxOutputTokens:number;thinkingConfig?:{thinkingBudget:number}}};
  expect(body.generationConfig.maxOutputTokens).toBe(2048+GEMINI_THINKING_BUDGET);
  expect(body.generationConfig.thinkingConfig).toEqual({thinkingBudget:GEMINI_THINKING_BUDGET});
 });
 // Anthropic's temperature range is 0.0-1.0 but the shared slider and clamp allow 0-2,
 // so forwarding the OpenAI-range value verbatim is a guaranteed 400.
 it('narrows the temperature into Anthropic 0-1 range',()=>{
  const body=buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude',temperature:1.8}).body as {temperature:number};
  expect(body.temperature).toBe(1);
  expect((buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude',temperature:0.4}).body as {temperature:number}).temperature).toBe(0.4);
 });
 it('leaves the temperature alone for OpenAI-compatible providers',()=>{
  expect((buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o',temperature:1.8}).body as {temperature:number}).temperature).toBe(1.8);
 });
 it('maps roles for Anthropic and Gemini',()=>{
  const a=buildChatRequest(anthropic,[{role:'user',content:'q'},{role:'assistant',content:'a'}],{model:'claude'}).body as {messages:Array<{role:string}>};
  expect(a.messages.map(m=>m.role)).toEqual(['user','assistant']);
  const g=buildChatRequest(gemini,[{role:'user',content:'q'},{role:'assistant',content:'a'}],{model:'gemini-2.0-flash'}).body as {contents:Array<{role:string}>};
  expect(g.contents.map(m=>m.role)).toEqual(['user','model']);
 });
 // Local servers have no key at all; an empty Authorization header makes some of
 // them reject the request.
 it('sends no auth header for a keyless local server',()=>{
  expect(buildModelsRequest(ollama).headers).toEqual({});
  const body=buildChatRequest(ollama,[{role:'user',content:'hi'}],{model:'llama3'}).headers as Record<string,string>;
  expect(body.Authorization).toBeUndefined();
  expect(body['content-type']).toBe('application/json');
 });
 it('reuses the OpenAI-compatible path for local servers',()=>{
  expect(buildModelsRequest(ollama).url).toBe('http://127.0.0.1:11434/v1/models');
  expect(buildChatRequest(ollama,[{role:'user',content:'hi'}],{model:'llama3'}).url).toBe('http://127.0.0.1:11434/v1/chat/completions');
 });
});

describe('reasoning effort',()=>{
 it('detects Anthropic thinking models',()=>{
  expect(isAnthropicThinkingModel('claude-3-7-sonnet-20250219')).toBe(true);
  expect(isAnthropicThinkingModel('claude-sonnet-4-20250514')).toBe(true);
  expect(isAnthropicThinkingModel('anthropic/claude-opus-4')).toBe(true);
  expect(isAnthropicThinkingModel('claude-3-5-haiku-20241022')).toBe(false);
 });
 // 'off' is the default and must not change any request: Gemini keeps its built-in
 // 8k thinking budget, every other provider sends nothing extra.
 it('sends nothing extra when the effort is off',()=>{
  const o=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'o3-mini',reasoningEffort:'off'}).body as Record<string,unknown>;
  expect(o.reasoning_effort).toBeUndefined();
  const a=buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude-sonnet-4-20250514',reasoningEffort:'off'}).body as Record<string,unknown>;
  expect(a.thinking).toBeUndefined();
  expect(a.temperature).toBeDefined();
  const g=buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini-2.5-pro',maxTokens:2048,reasoningEffort:'off'}).body as {generationConfig:{thinkingConfig:{thinkingBudget:number}}};
  expect(g.generationConfig.thinkingConfig.thinkingBudget).toBe(GEMINI_THINKING_BUDGET);
 });
 it('passes reasoning_effort to OpenAI reasoning models only',()=>{
  const o=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'o3-mini',reasoningEffort:'high'}).body as Record<string,unknown>;
  expect(o.reasoning_effort).toBe('high');
  const plain=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o',reasoningEffort:'high'}).body as Record<string,unknown>;
  expect(plain.reasoning_effort).toBeUndefined();
 });
 // Extended thinking forbids temperature/top_p and max_tokens must exceed the budget.
 it('sets a thinking budget and drops sampling params for Anthropic thinking models',()=>{
  const body=buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude-sonnet-4-20250514',reasoningEffort:'medium',maxTokens:2048,temperature:0.7}).body as Record<string,unknown>;
  expect(body.thinking).toEqual({type:'enabled',budget_tokens:ANTHROPIC_THINKING_BUDGETS.medium});
  expect(body.max_tokens).toBe(ANTHROPIC_THINKING_BUDGETS.medium+2048);
  expect(body.temperature).toBeUndefined();
  expect(body.top_p).toBeUndefined();
  const old=buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude-3-5-haiku-20241022',reasoningEffort:'high'}).body as Record<string,unknown>;
  expect(old.thinking).toBeUndefined();
  expect(old.temperature).toBeDefined();
 });
 it('rescales the Gemini thinking budget per level',()=>{
  const body=(eff:'low'|'medium'|'high')=>(buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini-2.5-pro',maxTokens:2048,reasoningEffort:eff}).body as {generationConfig:{maxOutputTokens:number;thinkingConfig:{thinkingBudget:number}}}).generationConfig;
  expect(body('low').thinkingConfig.thinkingBudget).toBe(GEMINI_THINKING_BUDGETS.low);
  expect(body('high').thinkingConfig.thinkingBudget).toBe(GEMINI_THINKING_BUDGETS.high);
  expect(body('high').maxOutputTokens).toBe(2048+GEMINI_THINKING_BUDGETS.high);
 });
 it('maps the effort to reasoning.effort for OpenRouter',()=>{
  const body=buildChatRequest(openrouter,[{role:'user',content:'hi'}],{model:'anthropic/claude-sonnet-4',reasoningEffort:'low'}).body as Record<string,unknown>;
  expect(body.reasoning).toEqual({effort:'low'});
  expect(body.reasoning_effort).toBeUndefined();
 });
 // DeepSeek/Mistral/Ollama/LM Studio have no such knob — nothing may leak to them.
 it('never sends an effort field to providers without support',()=>{
  const body=buildChatRequest(ollama,[{role:'user',content:'hi'}],{model:'llama3',reasoningEffort:'high'}).body as Record<string,unknown>;
  expect(body.reasoning_effort).toBeUndefined();
  expect(body.reasoning).toBeUndefined();
 });
 // Every custom endpoint (legacy 'custom' or generated 'custom-<hex>') is treated
 // as OpenAI-compatible and gets reasoning_effort on opt-in.
 it('sends reasoning_effort to any custom endpoint',()=>{
  const mine:ResolvedProvider={id:'custom-a1b2c3d4',name:'Mine',url:'https://api.example.com/v1',key:'sk'};
  const body=buildChatRequest(mine,[{role:'user',content:'hi'}],{model:'some-model',reasoningEffort:'low'}).body as Record<string,unknown>;
  expect(body.reasoning_effort).toBe('low');
 });
 it('accepts a generated custom provider id in chat requests',()=>{
  const r=validateChatRequest({requestId:'rq',chatId:'c1',providerId:'custom-a1b2c3d4',model:'m',content:'hi'});
  expect(r.providerId).toBe('custom-a1b2c3d4');
 });
 it('accepts a valid effort and rejects junk in chat requests',()=>{
  const ok=validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'hi',reasoningEffort:'medium'});
  expect(ok.reasoningEffort).toBe('medium');
  const junk=validateChatRequest({requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'hi',reasoningEffort:'galaxy-brain'});
  expect(junk.reasoningEffort).toBeUndefined();
 });
 it('clamps the stored setting to the allow-list',()=>{
  expect(clampSettings({reasoningEffort:'high'})).toEqual({reasoningEffort:'high'});
  expect(clampSettings({reasoningEffort:'extreme'})).toEqual({});
 });
});

describe('attachment validation',()=>{
 const base={requestId:'rq',chatId:'c1',providerId:'openai',model:'m',content:'hi'};
 const img=(over?:Record<string,unknown>)=>({name:'pic.png',mime:'image/png',data:'aGVsbG8=',...over});
 it('passes a well-formed attachment through unchanged',()=>{
  const r=validateChatRequest({...base,attachments:[img()]});
  expect(r.attachments).toEqual([{name:'pic.png',mime:'image/png',data:'aGVsbG8='}]);
 });
 // The prompt may BE the image: an empty body with attachments is a valid request.
 it('allows an image-only message',()=>{
  const r=validateChatRequest({...base,content:'',attachments:[img()]});
  expect(r.content).toBe('');
  expect(r.attachments).toHaveLength(1);
 });
 it('caps the number of images per message',()=>{
  const many=Array.from({length:MAX_IMAGE_ATTACHMENTS+1},()=>img());
  expect(()=>validateChatRequest({...base,attachments:many})).toThrow('At most');
  expect(validateChatRequest({...base,attachments:Array.from({length:MAX_IMAGE_ATTACHMENTS},()=>img())}).attachments).toHaveLength(MAX_IMAGE_ATTACHMENTS);
 });
 it('rejects non-image mime types',()=>{
  expect(()=>validateChatRequest({...base,attachments:[img({mime:'application/pdf'})]})).toThrow('Unsupported image type');
 });
 // The cap applies to decoded bytes; the estimate from the base64 length must catch
 // an oversized payload without decoding it first.
 it('rejects an oversized image',()=>{
  const tooBig='a'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES*4/3)+8);
  expect(()=>validateChatRequest({...base,attachments:[img({data:tooBig})]})).toThrow('too large');
 });
 it('rejects nameless or malformed entries',()=>{
  expect(()=>validateChatRequest({...base,attachments:[img({name:'  '})]})).toThrow('file name');
  expect(()=>validateChatRequest({...base,attachments:[null]})).toThrow('Invalid attachment');
  expect(()=>validateChatRequest({...base,attachments:'nope'})).toThrow('Invalid attachments');
 });
});

describe('history with images',()=>{
 // An image-only turn has no text but must survive normalization.
 it('keeps an image-only turn',()=>{
  const h=[{role:'user',content:'',images:[{mime:'image/png',data:'aGVsbG8='}]}];
  expect(normalizeHistory(h)).toEqual(h);
 });
 it('merges images when combining same-role neighbours',()=>{
  const out=normalizeHistory([{role:'user',content:'a',images:[{mime:'image/png',data:'x'}]},{role:'user',content:'b',images:[{mime:'image/png',data:'y'}]}]);
  expect(out).toEqual([{role:'user',content:'a\n\nb',images:[{mime:'image/png',data:'x'},{mime:'image/png',data:'y'}]}]);
 });
 it('still drops a blank turn that carries no images',()=>{
  expect(normalizeHistory([{role:'user',content:' '}])).toEqual([]);
 });
});

describe('vision request payloads',()=>{
 const history=[{role:'user',content:'what is this?',images:[{mime:'image/png',data:'aGVsbG8='}]},{role:'assistant',content:'a picture'}];
 // Plain-text turns must stay byte-identical to the pre-vision payloads.
 it('keeps text-only turns in the plain string form',()=>{
  const a=buildChatRequest(anthropic,[{role:'user',content:'hi'}],{model:'claude'}).body as {messages:Array<{content:unknown}>};
  expect(a.messages[0].content).toBe('hi');
  const o=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o'}).body as {messages:Array<{content:unknown}>};
  expect(o.messages[0].content).toBe('hi');
  const g=buildChatRequest(gemini,[{role:'user',content:'hi'}],{model:'gemini-2.0-flash'}).body as {contents:Array<{parts:Array<{text:string}>}>};
  expect(g.contents[0].parts).toEqual([{text:'hi'}]);
 });
 it('builds Anthropic image blocks before the text block',()=>{
  const body=buildChatRequest(anthropic,history,{model:'claude'}).body as {messages:Array<{content:unknown}>};
  expect(body.messages[0].content).toEqual([
   {type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}},
   {type:'text',text:'what is this?'},
  ]);
  expect(body.messages[1].content).toBe('a picture');
 });
 it('builds Gemini inlineData parts',()=>{
  const body=buildChatRequest(gemini,history,{model:'gemini-2.5-flash'}).body as {contents:Array<{parts:unknown[]}>};
  expect(body.contents[0].parts).toEqual([
   {inlineData:{mimeType:'image/png',data:'aGVsbG8='}},
   {text:'what is this?'},
  ]);
 });
 it('builds OpenAI image_url parts with a data URL',()=>{
  const body=buildChatRequest(openai,history,{model:'gpt-4o'}).body as {messages:Array<{content:unknown}>};
  expect(body.messages[0].content).toEqual([
   {type:'text',text:'what is this?'},
   {type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}},
  ]);
 });
 it('fills in placeholder text for an image-only turn',()=>{
  const body=buildChatRequest(openai,[{role:'user',content:'',images:[{mime:'image/png',data:'aGVsbG8='}]}],{model:'gpt-4o'}).body as {messages:Array<{content:Array<{type:string;text?:string}>}>};
  expect(body.messages[0].content[0]).toEqual({type:'text',text:'Attached image(s)'});
 });
});

describe('hotkey validation',()=>{
 it('accepts modifier combos',()=>{
  expect(isValidHotkey('Ctrl+K')).toBe(true);
  expect(isValidHotkey('Ctrl+Shift+K')).toBe(true);
  expect(isValidHotkey('Alt+F5')).toBe(true);
  expect(isValidHotkey('Ctrl+,')).toBe(true);
 });
 // A chord without Ctrl or Alt would swallow ordinary typing.
 it('rejects combos without Ctrl or Alt and malformed values',()=>{
  expect(isValidHotkey('K')).toBe(false);
  expect(isValidHotkey('Shift+K')).toBe(false);
  expect(isValidHotkey('Ctrl')).toBe(false);
  expect(isValidHotkey('Ctrl+Boom')).toBe(false);
  expect(isValidHotkey('')).toBe(false);
  expect(isValidHotkey(7)).toBe(false);
 });
 it('falls back to defaults for missing or invalid entries',()=>{
  expect(normalizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS);
  expect(normalizeHotkeys('junk')).toEqual(DEFAULT_HOTKEYS);
  expect(normalizeHotkeys({newChat:'Shift+K',openSettings:'Alt+O'})).toEqual({...DEFAULT_HOTKEYS,openSettings:'Alt+O'});
 });
 it('clamps hotkeys through settings',()=>{
  const out=clampSettings({hotkeys:{newChat:'Alt+N',openSettings:'bad'}});
  expect(out.hotkeys).toEqual({...DEFAULT_HOTKEYS,newChat:'Alt+N'});
 });
});

describe('personas and appearance settings',()=>{
 const persona={id:'p1',name:'Reviewer',prompt:'Review code.',color:'#7aa2f7'};
 it('accepts well-formed personas and drops malformed entries',()=>{
  expect(validatePersonas([persona])).toEqual([persona]);
  expect(validatePersonas([persona,{id:'x',name:'',prompt:'p'},null,{id:'y',name:'n',prompt:'  '}])).toEqual([persona]);
  expect(validatePersonas('nope')).toBeUndefined();
 });
 it('sanitizes persona fields: unknown color/provider fall back, temperature clamps',()=>{
  const out=validatePersonas([{...persona,color:'red',providerId:'bogus',model:' m1 ',temperature:99}]);
  expect(out?.[0].color).toBe('#b59af4');
  expect(out?.[0].providerId).toBeUndefined();
  expect(out?.[0].model).toBe('m1');
  expect(out?.[0].temperature).toBe(2);
 });
 it('clamps personas, accent, notifications and personaId through settings',()=>{
  const out=clampSettings({personas:[persona],accent:'neon',notifications:1,personaId:'p1'});
  expect(out.personas).toEqual([persona]);
  expect(out.accent).toBe('violet'); // not in the allow-list
  expect(out.notifications).toBe(false); // strict boolean coercion
  expect(out.personaId).toBe('p1');
  expect(clampSettings({accent:'blue'}).accent).toBe('blue');
 });
 it('clamps templates, defaultWorkspace, customCss and compactMode',()=>{
  const out=clampSettings({
   templates:[{id:'t1',name:'Review',text:'Review this: {{input}}'},{id:'',name:'bad',text:'x'},{id:'t2',name:'',text:'y'}],
   defaultWorkspace:'C:\\proj',customCss:'body{color:red}',compactMode:true,
  });
  expect(out.templates).toEqual([{id:'t1',name:'Review',text:'Review this: {{input}}'}]);
  expect(out.defaultWorkspace).toBe('C:\\proj');
  expect(out.customCss).toBe('body{color:red}');
  expect(out.compactMode).toBe(true);
 });
});

describe('auto-title cleanup',()=>{
 it('strips quotes, punctuation and extra lines from model output',()=>{
  expect(cleanTitle('"Hello World."')).toBe('Hello World');
  expect(cleanTitle('First line\nSecond line')).toBe('First line');
  expect(cleanTitle('  «Очень интересный разговор»  ')).toBe('Очень интересный разговор');
 });
 it('rejects empty, tiny and rambling answers',()=>{
  expect(cleanTitle('')).toBe('');
  expect(cleanTitle('x')).toBe('');
  expect(cleanTitle('y'.repeat(81))).toBe('');
  expect(cleanTitle(42)).toBe('');
 });
});

describe('enhance prompt',()=>{
 it('ships a prompt that asks for the rewrite only',()=>{
  expect(ENHANCE_PROMPT).toContain('improved prompt only');
 });
 it('strips fences and surrounding quotes from the model answer',()=>{
  expect(cleanEnhanced('```\nbetter text\n```','draft')).toBe('better text');
  expect(cleanEnhanced('"better text"','draft')).toBe('better text');
  expect(cleanEnhanced('«улучшенный текст»','draft')).toBe('улучшенный текст');
 });
 it('rejects empty, unchanged or non-string answers so the draft is never blanked',()=>{
  expect(cleanEnhanced('','draft')).toBe('');
  expect(cleanEnhanced('  draft  ','draft')).toBe('');
  expect(cleanEnhanced(null,'draft')).toBe('');
  expect(cleanEnhanced('x'.repeat(32769),'draft')).toBe('');
 });
});

describe('tool-call streaming parsers',()=>{
 it('reads OpenAI tool-call deltas: start, argument chunks, tool_calls finish',()=>{
  expect(parseToolCallDelta('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file"}}]}}]}'))
   .toEqual([{kind:'call-start',index:0,id:'call_1',name:'read_file'}]);
  expect(parseToolCallDelta('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}'))
   .toEqual([{kind:'call-args',index:0,chunk:'{"path":'}]);
  expect(parseToolCallDelta('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'))
   .toEqual([{kind:'tool-stop'}]);
 });
 it('ignores non-tool OpenAI events and malformed lines',()=>{
  expect(parseToolCallDelta('data: {"choices":[{"delta":{"content":"hi"}}]}')).toEqual([]);
  expect(parseToolCallDelta('data: {')).toEqual([]);
  expect(parseToolCallDelta('data: [DONE]')).toEqual([]);
 });
 it('reads Anthropic tool_use blocks and the tool_use stop reason',()=>{
  expect(parseAnthropicToolEvent('data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file"}}'))
   .toEqual([{kind:'call-start',index:1,id:'toolu_1',name:'write_file'}]);
  expect(parseAnthropicToolEvent('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}'))
   .toEqual([{kind:'call-args',index:1,chunk:'{"path":"a"}'}]);
  expect(parseAnthropicToolEvent('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}'))
   .toEqual([{kind:'tool-stop'}]);
  // Text deltas and other stop reasons are not tool events.
  expect(parseAnthropicToolEvent('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}')).toEqual([]);
  expect(parseAnthropicToolEvent('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}')).toEqual([]);
 });
 it('reads Gemini functionCall parts as complete calls with sequential ids',()=>{
  expect(parseGeminiToolCall('data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_files","args":{}}}]}}]}',0))
   .toEqual([{kind:'call-complete',id:'gemini-call-0',name:'list_files',args:'{}'}]);
  expect(parseGeminiToolCall('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',3)).toEqual([]);
 });
});

describe('tool-aware request bodies',()=>{
 const tools=[{name:'read_file',description:'Read a file',schema:{type:'object',properties:{path:{type:'string'}},required:['path']}}];
 it('maps tools and tool turns into the OpenAI-compatible shape',()=>{
  const body=buildChatRequest(openai,[
   {role:'user',content:'read a.txt'},
   {role:'assistant',content:'',toolCalls:[{id:'call_1',name:'read_file',args:'{"path":"a.txt"}'}]},
   {role:'user',content:'',toolResults:[{toolCallId:'call_1',name:'read_file',content:'hello'}]},
  ],{model:'gpt-4o',tools}).body as {tools?:unknown[];messages:Array<Record<string,unknown>>};
  expect(body.tools).toEqual([{type:'function',function:{name:'read_file',description:'Read a file',parameters:tools[0].schema}}]);
  expect(body.messages[1]).toEqual({role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'read_file',arguments:'{"path":"a.txt"}'}}]});
  expect(body.messages[2]).toEqual({role:'tool',tool_call_id:'call_1',content:'hello'});
 });
 it('maps tools and tool turns into the Anthropic shape',()=>{
  const body=buildChatRequest(anthropic,[
   {role:'assistant',content:'checking',toolCalls:[{id:'toolu_1',name:'read_file',args:'{"path":"a.txt"}'}]},
   {role:'user',content:'',toolResults:[{toolCallId:'toolu_1',name:'read_file',content:'hello'}]},
  ],{model:'claude-sonnet-4-5',tools}).body as {tools?:unknown[];messages:Array<Record<string,unknown>>};
  expect(body.tools).toEqual([{name:'read_file',description:'Read a file',input_schema:tools[0].schema}]);
  expect(body.messages[0]).toEqual({role:'assistant',content:[{type:'text',text:'checking'},{type:'tool_use',id:'toolu_1',name:'read_file',input:{path:'a.txt'}}]});
  expect(body.messages[1]).toEqual({role:'user',content:[{type:'tool_result',tool_use_id:'toolu_1',content:'hello'}]});
 });
 it('maps tools and tool turns into the Gemini shape',()=>{
  const body=buildChatRequest(gemini,[
   {role:'assistant',content:'',toolCalls:[{id:'gemini-call-0',name:'list_files',args:'{}'}]},
   {role:'user',content:'',toolResults:[{toolCallId:'gemini-call-0',name:'list_files',content:'a.txt'}]},
  ],{model:'gemini-2.0-flash',tools}).body as {tools?:unknown[];contents:Array<{role:string;parts:unknown[]}>};
  expect(body.tools).toEqual([{functionDeclarations:[{name:'read_file',description:'Read a file',parameters:tools[0].schema}]}]);
  expect(body.contents[0]).toEqual({role:'model',parts:[{functionCall:{name:'list_files',args:{}}}]});
  expect(body.contents[1]).toEqual({role:'user',parts:[{functionResponse:{name:'list_files',response:{result:'a.txt'}}}]});
 });
 it('omits tool fields entirely when no tools are passed',()=>{
  const body=buildChatRequest(openai,[{role:'user',content:'hi'}],{model:'gpt-4o'}).body as Record<string,unknown>;
  expect('tools' in body).toBe(false);
 });
});

describe('pricing validation',()=>{
 it('keeps well-formed entries and drops malformed ones',()=>{
  const out=validatePricing({'gpt-4o':{input:2.5,output:10},bad:{input:'x',output:1},neg:{input:-1,output:1},nan:{input:NaN,output:0}});
  expect(out).toEqual({'gpt-4o':{input:2.5,output:10}});
 });
 it('returns undefined for non-objects and empty results stay valid',()=>{
  expect(validatePricing('nope')).toBeUndefined();
  expect(validatePricing([1,2])).toBeUndefined();
  expect(validatePricing({})).toEqual({});
 });
 it('flows through provider validation, sanitized',()=>{
  const pinned=new Map<ProviderId,string>();
  const c=validateProviderConfig({id:'custom',name:'Mine',baseUrl:'https://api.example.com/v1',models:['m1'],pricing:{m1:{input:1,output:2},bad:{input:'x',output:1}}},pinned);
  expect(c.pricing).toEqual({m1:{input:1,output:2}});
 });
 it('default pricing covers the seeded cloud providers, not local ones',()=>{
  expect(DEFAULT_PRICING.openai['gpt-4o'].input).toBeGreaterThan(0);
  expect(DEFAULT_PRICING.deepseek['deepseek-chat'].output).toBeGreaterThan(0);
  expect(DEFAULT_PRICING.ollama).toBeUndefined();
  expect(DEFAULT_PRICING.custom).toBeUndefined();
 });
});
