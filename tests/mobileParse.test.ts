import {describe,expect,it} from 'vitest';
import {apiErrorMessage,parseAnthropicAnswer,parseGeminiAnswer,parseOpenAiAnswer} from '../src/platform/mobileParse';

// The Android layer talks to providers non-streamed (CapacitorHttp buffers), so
// these parsers are the only thing between a JSON body and the chat UI.
describe('mobile non-streaming parsers',()=>{
 it('parses an OpenAI-style answer with usage and finish reason',()=>{
  const a=parseOpenAiAnswer({choices:[{message:{content:'hello'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:7}});
  expect(a).toEqual({text:'hello',reasoning:'',promptTokens:5,completionTokens:7,finishReason:'stop'});
 });
 it('reads reasoning_content from reasoning models',()=>{
  const a=parseOpenAiAnswer({choices:[{message:{content:'answer',reasoning_content:'thinking…'},finish_reason:'stop'}]});
  expect(a.reasoning).toBe('thinking…');
  expect(a.text).toBe('answer');
 });
 it('joins OpenAI content parts arrays',()=>{
  const a=parseOpenAiAnswer({choices:[{message:{content:[{text:'a'},{text:'b'}]},finish_reason:'length'}]});
  expect(a.text).toBe('ab');
  expect(a.finishReason).toBe('length');
 });
 it('tolerates a malformed OpenAI body',()=>{
  const a=parseOpenAiAnswer({});
  expect(a.text).toBe('');
  expect(a.promptTokens).toBeNull();
  expect(a.finishReason).toBeNull();
 });
 it('separates Anthropic thinking blocks from text',()=>{
  const a=parseAnthropicAnswer({content:[{type:'thinking',thinking:'hmm'},{type:'text',text:'hi'},{type:'text',text:' there'}],usage:{input_tokens:3,output_tokens:9},stop_reason:'end_turn'});
  expect(a.text).toBe('hi there');
  expect(a.reasoning).toBe('hmm');
  expect(a.promptTokens).toBe(3);
  expect(a.finishReason).toBe('stop');
 });
 it('joins Gemini parts and keeps thought parts as reasoning',()=>{
  const a=parseGeminiAnswer({candidates:[{content:{parts:[{text:'visible'},{text:'hidden',thought:true}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:6,thoughtsTokenCount:10}});
  expect(a.text).toBe('visible');
  expect(a.reasoning).toBe('hidden');
  expect(a.completionTokens).toBe(16);
  expect(a.finishReason).toBe('stop');
 });
 it('formats provider error bodies readably',()=>{
  expect(apiErrorMessage(401,{error:{message:'Invalid API key'}})).toBe('HTTP 401: Invalid API key'.replace('Invalid API key','Invalid API key'));
  expect(apiErrorMessage(500,{})).toBe('HTTP 500');
 });
});
