import {z} from 'zod';
import {messages as previousMessages,parseStage} from '../advice-repair-v6/prompts.mjs';
const atom=z.union([z.string(),z.number().finite(),z.boolean(),z.null()]);
export const Verdict=z.object({answer:z.string(),values:z.record(z.string(),atom),status:z.enum(['current','uncertain','stale']),refs:z.array(z.string()).min(1),needsEvidence:z.boolean()}).strict();
export function messages(stage,payload){
  if(stage==='decide')return previousMessages('decide',payload);
  if(stage==='answer-first'){
    const result=previousMessages('decide',payload),marker='JSON格式示意（仅说明形状；实际ID、值和数组长度必须来自输入，不能照抄占位符）：';
    const [prefix,example,...extra]=result[0].content.split(marker);
    if(extra.length||!example)throw Error('Unrecognised baseline prompt');
    const old=JSON.parse(example),{answer,...rest}=old;
    result[0].content=prefix+marker+JSON.stringify({answer,...rest});
    return result;
  }
  if(stage==='review'){
    const {candidate,...context}=payload;
    const user=JSON.parse(previousMessages('decide',context)[1].content);
    return [{role:'system',content:'你参与虚构职业规划记忆维护实验。对当前唯一目标进行一次提交前复核。候选回答和候选写入可能正确也可能错误，不是新证据；不要因存在候选就一定修改。根据相同原始资料、当前依赖和适用时间确定最终字段。未知保持null与uncertain；所有允许状态输出一致时可保留确定结论。不可猜测缺失规则或事实，不实际申请或撤回。给出简短结论说明，不输出推理过程。只输出JSON，键按answer、values、status、refs、needsEvidence；不要返回patches。values必须恰好包含writeScope.fields，不添加理由字段。refs仅可用allowedSourceIds或allowedAlternativeMemoryIds；不得引用目标自己或候选回答。status只可current/uncertain/stale。程序将按当前目标版本把最终字段构造为写入，不会从说明文字抽取真值。'},
      {role:'user',content:JSON.stringify({...user,candidate})}];
  }
  throw Error('Unknown A2 stage');
}
export function parse(stage,text){return stage==='review'?Verdict.parse(JSON.parse(text)):parseStage('decide',text);}
export function answerBeforePatches(raw){
  try{const keys=Object.keys(JSON.parse(raw));return keys.includes('answer')&&keys.includes('patches')?keys.indexOf('answer')<keys.indexOf('patches'):null;}catch{return null;}
}
export function verdictDecision(verdict,target){
  const value=Verdict.parse(verdict);
  if(JSON.stringify(Object.keys(value.values).sort())!==JSON.stringify(Object.keys(target.values).sort()))throw Error('Verdict fields mismatch');
  return {patches:[{memoryId:target.id,expectedVersion:target.version,values:value.values,refs:value.refs,status:value.status,text:JSON.stringify(value.values)}],answer:value.answer,needsEvidence:value.needsEvidence,externalAction:'none'};
}
