import {roles,evidenceIndex,validateTask,reconcile} from './state.mjs';
import {scheduleTool,checkSchedule,closureCheck,digest,readCalendar} from './calendar-check.mjs';
const strings={type:'array',items:{type:'string'}};
const props={subject:{type:'string'},field:{type:'string'},question:{type:'string',maxLength:600},targets:{type:'array',items:{type:'string',enum:roles}},claimRefs:strings,evidenceRefs:strings,readIds:strings,action:{type:'string',enum:['dispatch','wait']},eventQuote:{type:'string'},branches:{type:'array',maxItems:2,items:{type:'object',properties:{condition:{type:'string'},consequence:{type:'string'}},required:['condition','consequence'],additionalProperties:false}}};
const tool={type:'function',function:{name:'review_submit',description:'Submit necessary evidence tasks and cited closure requests. Never treat a hypothetical answer as source data.',parameters:{type:'object',properties:{tasks:{type:'array',maxItems:4,items:{type:'object',properties:props,required:Object.keys(props),additionalProperties:false}},closed:{type:'array',items:{type:'object',properties:{key:{type:'string'},reason:{type:'string'},claimRefs:strings,receiptId:{type:'string'},checkedWeeklyHours:{type:'number'},evidenceQuotes:{type:'array',items:{type:'object',properties:{id:{type:'string'},quote:{type:'string'}},required:['id','quote'],additionalProperties:false}}},required:['key','reason','claimRefs','receiptId','checkedWeeklyHours','evidenceQuotes'],additionalProperties:false}},receiptIds:strings},required:['tasks','closed','receiptIds'],additionalProperties:false}}};
export async function review(provider,{arm,event,artifacts,priorTasks,catalog,initial,signal,sources,priorReceipts=[]}){
 const persistent=arm!=='direct',index=evidenceIndex(artifacts);
 for(const src of sources)index.evidence[src.id]={...src,version:digest(src.text),kind:'request'};
 const conclusions=artifacts.map(a=>({ref:'artifact:'+a.id,role:a.expert,version:a.version,summary:a.result.summary,failure:a.failure??null}));
 const common=`你是职业规划多智能体的取证复查代理。最多3次模型响应、每次最多1个工具调用；最后一次必须review_submit。所有组都有schedule_check，可按需使用，支持当前周工时核算及对旧回执/假设时段的差异检查。日程原表完整描述当前可用和占用时间；工具自动读取全部原始日程记录，先取可用并集再扣占用并集。回执仅证明该表的时段计算，不证明岗位资格。必须依据岗位原文判定资格。\n任务最多4个，只针对真实依赖变化、已读来源中的实际错误或待核定条件。claimRefs选conclusions.ref；evidenceRefs选sources.id；readIds选catalog.id。稳定subject=user，时间依赖field=availability.weeklyHours。question只写需要核查的问题，不嵌入尚未验证的小时数或资格答案。程序会把派发问题渲染为中立核查请求，实际计算只能来自工具回执。targets只列受影响角色。\naction=dispatch需要当前事件真正改变依赖的精确原话eventQuote；无关封面更改不派发，不重复询问。初始生成仅登记watch，不声称专家已完成复核。\n关闭任务需要当前有效责任角色产物、逐字原件引用，以及与当前日程版本一致的schedule_check回执。checkedWeeklyHours填回执数值；各责任角色summary的周工时也必须与回执一致。不能仅因四个专家一致而关闭。任务更新后若尚无本轮执行，不得提前关闭。原件未变可沿用同版本回执，receiptIds列本轮需要传给下游的真实回执ID。`;
 const modes={direct:'直接检查当前事件与旧结论，按需调用工具和提出取证问题。不保存跨轮任务；不要求生成branches，可自由使用反例检查；closed=[]。',natural:'维护跨轮探针：首次必须用schedule_check登记至少一个决定资格的时间依赖。结合pendingTasks续办，branches写可能使旧结论失效的条件；条件变化时核对是否满足并安排取证。',counterexample:'维护跨轮探针：首次必须用schedule_check登记至少一个决定资格的时间依赖。结合pendingTasks续办，主动寻找能反驳旧推导的具体时段：哪段实际可用时间被遗漏，哪段旧可用时间已被占用，新增时段是否与旧时段重叠。后续用schedule_check比较旧回执或明确标记为假设的候选时段，取得具体反例或差集为空的检查结果。branches只引用检查得到的具体片段与待核定影响；不存在反例就明确无此变化，不编造未来事实。'};
 const messages=[{role:'system',content:common+'\n'+modes[arm]},{role:'user',content:JSON.stringify({event,initial,conclusions,sources:Object.values(index.evidence),catalog,pendingTasks:persistent?priorTasks:[],priorReceipts})}];
 const checks=[],toolLog=[],errors=[];let parsed,reply;
 for(let turn=0;turn<3;turn++){
  reply=await provider.complete(messages,turn===2?[tool]:[tool,scheduleTool],signal);messages.push(reply.message);
  const calls=reply.message.tool_calls??[];
  if(calls.length!==1){for(const c of calls)messages.push({role:'tool',tool_call_id:c.id,content:JSON.stringify({error:'Exactly one tool per response'})});if(!calls.length)messages.push({role:'user',content:'请提交一个工具调用。'});continue;}
  const c=calls[0];let result;
  try{
   const args=JSON.parse(c.function.arguments);
   if(c.function.name==='review_submit'){parsed=args;break;}
   if(c.function.name!=='schedule_check')throw Error('Unknown tool');
   result=checkSchedule(sources,args,[...priorReceipts,...checks]);checks.push(result);toolLog.push({tool:c.function.name,args,receipt:result});
  }catch(e){result={error:e.message};toolLog.push({tool:c.function.name,error:e.message});}
  messages.push({role:'tool',tool_call_id:c.id,content:JSON.stringify(result)});
 }
 if(!parsed){parsed={tasks:[],closed:[],receiptIds:[]};errors.push({error:'No valid review_submit in reviewer budget'});}
 const available=[...priorReceipts,...checks],selected=[...new Map((parsed.receiptIds??[]).map(id=>{const r=available.find(r=>r.id===id);if(!r){errors.push({error:'Unknown receipt: '+id});return [id,null];}return [id,r];})).values()].filter(Boolean);
 // Successful calculations remain visible even when the reviewer forgets to select their IDs.
 for(const r of checks)if(!selected.some(s=>s.id===r.id))selected.push(r);
 const proposals=[];
 for(const raw of (parsed.tasks??[]).slice(0,4)){try{proposals.push(validateTask(raw,index,catalog,true));}catch(e){errors.push({error:e.message,field:raw.field});}}
 const closures=[];
 for(const c of persistent?(parsed.closed??[]):[]){const issue=closureCheck(c,priorTasks,available,sources,artifacts);if(issue)errors.push({error:issue,key:c.key});else closures.push(c);}
 if(initial&&persistent&&!proposals.length)errors.push({error:'initial-dependency-not-registered'});
 const result=reconcile({previous:persistent?priorTasks:[],proposals,closures,index,catalog,event,initial,persistent});
 const currentHash=readCalendar(sources).factsHash;
 const currentChecks=selected.filter(r=>r.factsHash===currentHash);
 return {...result,errors,checks:currentChecks,toolLog,rawSubmission:parsed,reply:reply?.message,initialRegistered:initial&&persistent&&proposals.length>0&&checks.length>0};
}
export function contextFor(catalog,artifacts,active,checks=[]){return {schemaVersion:'memory-probe-integration-v1',historicalArtifactAccess:true,catalog,derivationChecks:checks,priorConclusions:artifacts.map(a=>({id:a.id,role:a.expert,version:a.version,summary:a.result.summary})),tasks:active.map(t=>({key:t.key,question:'请根据当前原始日程、实际变化及岗位原文核对可用时段、周工时和岗位资格，更新受影响结论与模拟候选。计算回执是派生检查结果，须读取其对应用户原文；不得将未核验的假设或旧结论当作事实。',targets:t.targets,refs:t.evidenceRefs,binding:t.binding,status:'dispatched-for-verification',requestedEvidence:[...new Set([...t.readIds,...(t.activation?.changedSourceIds??[])])]}))};}
