import type {ModelPrice,ProviderConfig} from '../electron/shared';

// Cost estimates from each provider's pricing map (USD per 1M tokens). Only exact
// model ids match — an unknown model simply shows tokens without a $ figure rather
// than a misleading guess.

export function priceFor(providers:ProviderConfig[],providerId:string|null|undefined,model:string|null|undefined):ModelPrice|null{
 if(!providerId||!model)return null;
 return providers.find(p=>p.id===providerId)?.pricing?.[model]??null;
}

export function messageCost(providers:ProviderConfig[],providerId:string|null|undefined,model:string|null|undefined,promptTokens?:number|null,completionTokens?:number|null):number|null{
 const price=priceFor(providers,providerId,model);
 if(!price)return null;
 const prompt=promptTokens??0,completion=completionTokens??0;
 if(!prompt&&!completion)return null;
 return (prompt*price.input+completion*price.output)/1e6;
}

// Adaptive precision: cents matter for long sessions, fractions of a cent for a
// single mini reply. Tiny-but-nonzero shows a floor marker instead of $0.00.
export function formatCost(usd:number):string{
 if(!Number.isFinite(usd)||usd<0)return '';
 if(usd===0)return '$0.00';
 if(usd<0.01)return '<$0.01';
 if(usd<1)return '$'+usd.toFixed(3);
 return '$'+usd.toFixed(2);
}
