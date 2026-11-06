// Deliberately DeepSeek-only. No GPT key, endpoint selection or provider flag.
export const settings={model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions',reasoning:'disabled'};
export function deepseekSender(key,{fetchImpl=fetch}={}){
  return async({model,messages,limit,signal,timeoutMs=120000})=>{
    if(model!=='deepseek')throw Error('Only DeepSeek is authorized');
    const started=Date.now();
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
    const response=await fetchImpl(settings.endpoint,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:combined,
      body:JSON.stringify({model:settings.model,messages,stream:false,thinking:{type:'disabled'},temperature:0,max_tokens:limit})});
    const data=await response.json();
    if(!response.ok)throw Error('Provider request failed');
    const raw=data.usage??{},choice=data.choices?.[0];
    return {answer:choice?.message?.content??'',usage:{raw,input:raw.prompt_tokens??0,output:raw.completion_tokens??0,returnedModel:data.model,finishReason:choice?.finish_reason,latencyMs:Date.now()-started}};
  };
}
