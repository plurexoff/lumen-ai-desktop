import {describe,expect,it} from 'vitest';
import {formatCost,messageCost,priceFor} from '../src/cost';
import type {ProviderConfig} from '../electron/shared';

const providers:ProviderConfig[]=[
 {id:'openai',name:'OpenAI',baseUrl:'https://api.openai.com/v1',models:['gpt-4o-mini'],pricing:{'gpt-4o-mini':{input:0.15,output:0.6}}},
 {id:'ollama',name:'Ollama',baseUrl:'http://127.0.0.1:11434/v1',models:['llama3']},
];

describe('priceFor',()=>{
 it('matches provider + model exactly',()=>{
  expect(priceFor(providers,'openai','gpt-4o-mini')).toEqual({input:0.15,output:0.6});
  expect(priceFor(providers,'openai','gpt-4o')).toBeNull(); // unknown model, no guessing
  expect(priceFor(providers,'ollama','llama3')).toBeNull(); // no pricing map
  expect(priceFor(providers,null,'gpt-4o-mini')).toBeNull();
 });
});

describe('messageCost',()=>{
 it('computes USD from per-1M prices',()=>{
  // 1000 prompt @ $0.15/1M + 500 completion @ $0.60/1M = 0.00015 + 0.0003
  expect(messageCost(providers,'openai','gpt-4o-mini',1000,500)).toBeCloseTo(0.00045,8);
 });
 it('returns null without tokens or without a price',()=>{
  expect(messageCost(providers,'openai','gpt-4o-mini',null,null)).toBeNull();
  expect(messageCost(providers,'openai','gpt-4o',1000,500)).toBeNull();
  expect(messageCost(providers,'ollama','llama3',1000,500)).toBeNull();
 });
});

describe('formatCost',()=>{
 it('adapts precision to the magnitude',()=>{
  expect(formatCost(0)).toBe('$0.00');
  expect(formatCost(0.0004)).toBe('<$0.01');
  expect(formatCost(0.0123)).toBe('$0.012');
  expect(formatCost(1.234)).toBe('$1.23');
 });
 it('rejects nonsense input',()=>{
  expect(formatCost(NaN)).toBe('');
  expect(formatCost(-1)).toBe('');
 });
});
