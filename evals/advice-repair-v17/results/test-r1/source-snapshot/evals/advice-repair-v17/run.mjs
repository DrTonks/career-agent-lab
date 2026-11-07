import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {CurrentAssessment} from '../../dist/src/current-assessment.js';
import {CompatibleProvider} from '../../dist/src/providers.js';
import {config,hash} from '../../dist/src/config.js';
import {view,solve,applyPolicy} from './core.mjs';
const [action,dest]=process.argv.slice(2);if(!['register','live'].includes(action)||!dest)throw Error('register|live OUTPUT');
const root=resolve(dest),base='evals/advice-repair-v17',read=p=>JSON.parse(readFileSync(p,'utf8'));
function save(p,x){mkdirSync(resolve(p,'..'),{recursive:true});writeFileSync(p+'.tmp',JSON.stringify(x,null,2)+'\n');renameSync(p+'.tmp',p);}
const policies=['text','structured','verified'];
const cfg={...config(),baseUrl:'https://api.deepseek.com',model:'deepseek-flash',maxResponseTokens:4096};
const files=[...readdirSync('src').filter(f=>f.endsWith('.ts')).map(f=>'src/'+f),...readdirSync(base).filter(f=>/\.(mjs|md|py)$/.test(f)).map(f=>base+'/'+f),base+'/data/test.json',base+'/private/gold.json'];
if(action==='register'){
 if(existsSync(root))throw Error('Fresh output required');const hashes={};
 for(const f of files){const s=readFileSync(f,'utf8');hashes[f]=hash(s);mkdirSync(join(root,'source-snapshot',f,'..'),{recursive:true});writeFileSync(join(root,'source-snapshot',f),s);}
 save(join(root,'registration.json'),{at:new Date().toISOString(),componentOnly:true,nativeFourExpertRuntime:false,sharedAuthor:true,reviewerContextsIsolated:true,policies,actors:['memory-author','memory-reviewer'],cfg,hashes,authorMaxCallsPerEvent:2,reviewerMaxCallsPerEventPerPolicy:2,trajectories:4,eventsPerTrajectory:4});process.exit();
}
const reg=read(join(root,'registration.json'));for(const [p,h]of Object.entries(reg.hashes))if(hash(readFileSync(p,'utf8'))!==h)throw Error('Registered file changed: '+p);
const cases=read(base+'/data/test.json'),key=readFileSync('../api.txt','utf8').trim(),provider=new CompatibleProvider(reg.cfg,key),abort=new AbortController();
const Case=z.object({hypothesisId:z.string(),jobId:z.string(),factsVersion:z.string(),ruleVersion:z.string(),predictedAfter:z.enum(['符合','不符','待核定']),claimsRefutation:z.boolean()}).strict();
const Author=z.object({summary:z.string().max(4500),currentAssessment:CurrentAssessment,cases:z.array(Case).max(12)}).strict();
const Review=z.object({close:z.boolean(),cases:z.array(Case).max(12),note:z.string().max(3000)}).strict();
const finish=(name,schema)=>({type:'function',function:{name,description:'Submit a complete source-bound result.',parameters:z.toJSONSchema(schema)}});
const checker={type:'function',function:{name:'condition_check',description:'Read a deterministic receipt for the current calendar and every listed hypothetical case against the public time-rule cards. The hypothetical cases do not change real facts.',parameters:{type:'object',properties:{},additionalProperties:false}}};
const authorCheck={...checker,function:{...checker.function,name:'calendar_check',description:'Compute current daily and weekly hours from the visible original calendar. Does not decide job rules or hypothetical outcomes.'}};
async function call(dir,label,messages,tools){
 mkdirSync(dir,{recursive:true});const number=readdirSync(dir).filter(f=>/^\d+\.json$/.test(f)).length+1;
 if(number>2||abort.signal.aborted||existsSync(join(root,'STOP')))throw Error('Budget exhausted or stopped');
 const file=join(dir,String(number).padStart(3,'0')+'.json'),data={number,label,status:'pending',messages,tools};save(file,data);const start=Date.now();
 try{const response=await provider.complete(messages,tools,abort.signal);save(file,{...data,status:'ok',elapsedMs:Date.now()-start,response});return response;}
 catch(e){save(file,{...data,status:'error',elapsedMs:Date.now()-start,error:e.message});if([401,402,403].includes(e.status)){abort.abort();writeFileSync(join(root,'STOP'),'Provider access failure\n');}throw e;}
}
async function actor(dir,label,system,input,schema,isAuthor,v,t){
 const finished=join(dir,'actor-result.json');if(existsSync(finished))return read(finished);
 const messages=[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}],submit=finish(isAuthor?'memory_submit':'review_submit',schema),tool=isAuthor?authorCheck:checker;
 const log=[];let parsed=null,error=null;
 for(let turn=0;turn<2;turn++){
  const selectedTools=turn===1?[submit]:[submit,tool], priorPath=join(dir,'calls',String(turn+1).padStart(3,'0')+'.json');
  let response;
  if(existsSync(priorPath)){const prior=read(priorPath);if(hash(prior.messages)!==hash(messages)||hash(prior.tools)!==hash(selectedTools))throw Error('Replay input mismatch');if(prior.status!=='ok')throw Error('Uncompleted call requires explicit recovery');response=prior.response;}
  else response=await call(join(dir,'calls'),label,messages,selectedTools);messages.push(response.message);
  const calls=response.message.tool_calls??[];
  if(calls.length!==1){for(const c of calls)messages.push({role:'tool',tool_call_id:c.id,content:'{"error":"Use exactly one tool call"}'});if(!calls.length)messages.push({role:'user',content:'请调用提交工具，或先用核算工具。'});continue;}
  const c=calls[0];let result;
  try{
   const args=JSON.parse(c.function.arguments);
   if(c.function.name===submit.function.name){parsed=schema.parse(args);break;}
   if(c.function.name!==tool.function.name)throw Error('Unknown tool');
   result=isAuthor?{factsVersion:v.factsVersion,weeklyHours:v.calendar.weeklyHours,dailyHours:v.calendar.dailyHours,sourceRefs:v.evidenceIds}:solve(v,t);log.push({name:c.function.name,result});
  }catch(e){error=e.message;result={error};}
  messages.push({role:'tool',tool_call_id:c.id,content:JSON.stringify(result)});
 }
 const out={parsed,toolLog:log,error:parsed?null:error??'No valid submission within budget',inputHash:hash(input)};save(finished,out);return out;
}
const sharedInstruction=`你是长期记忆条目的作者。只根据可见来源产生当前状态。最多2次模型响应，每次1个工具；可以先调用calendar_check，最后memory_submit。当前数字与岗位核定写入currentAssessment，factsVersion、ruleVersion、evidenceIds从上下文复制并核对；历史数字只属于旧版本，不是当前值。summary保留当前结论和必要历史变更依据，明确旧结论已失效，不必抹掉旧数字。岗位JSON规则是公开原件，不是推测条件：qualifyingDays为至少N天达到阈值，everyWorkingDayHoursAtLeast才是每个有出勤时段的日都达标。对每个hypothesisId×jobId给出一个预测：predictedAfter是该假设下判定，claimsRefutation仅在它确实改变当前判定时为true。假设不修改真实日程。不要因旧警示声称一定不符就相信它。所有事实均为合成实验资料。`;
const reviewInstruction=`你是另一位独立上下文的记忆复核代理。最多2次模型响应，每次1个工具；可以先用condition_check核对，最后review_submit。复核当前状态是否可提交并把close设为true/false。对每个hypothesisId×jobId独立提交预测和claimsRefutation；仅实际改变当前判定才是有效反例。完整读取公开岗位规则、真实原表和假设沙箱；至少N天达标不是所有天达标。旧文本、先前警示、作者预测都不是新事实。所有组具有相同核算工具，不因stateProjection格式不同而减少必要检查。`;
async function trajectory(t,index){
 for(let i=0;i<t.events.length;i++){
  if(abort.signal.aborted||existsSync(join(root,'STOP')))return;
  const v=view(t,i),dir=join(root,t.id,'event-'+i);save(join(dir,'visible-snapshot.json'),{trajectory:t.id,event:i,sources:v.sources,rules:v.rules,userFacts:t.userFacts,hypotheses:v.hypotheses,factsVersion:v.factsVersion,evidenceIds:v.evidenceIds});
  const common={sources:v.sources,userFacts:t.userFacts,publicRules:v.rules,hypotheses:v.hypotheses,metadata:{factsVersion:v.factsVersion,ruleVersions:Object.fromEntries(v.rules.map(j=>[j.id,j.ruleVersion])),evidenceIds:v.evidenceIds}};
  const previous=i?read(join(root,t.id,'event-'+(i-1),'author/actor-result.json')).parsed:t.historicalMemory;
  const authored=await actor(join(dir,'author'),t.id+'/'+i+'/author',sharedInstruction,{...common,previousMemory:previous},Author,true,v,t);
  for(const policy of [...policies.slice(index%3),...policies.slice(0,index%3)]){
   const branch=join(dir,policy),resultPath=join(branch,'result.json');if(existsSync(resultPath))continue;
   if(!authored.parsed){save(resultPath,{trajectory:t.id,event:i,policy,status:'blocked-author',authorError:authored.error});continue;}
   const previousReview=i?read(join(root,t.id,'event-'+(i-1),policy,'result.json')):null;
   const author=authored.parsed,input={...common,authorSummary:author.summary,authorCases:author.cases,stateProjection:policy==='text'?{summary:author.summary}:{currentAssessment:author.currentAssessment},previousWorkflow:previousReview?{currentStateCommitted:previousReview.outcome?.currentStateCommitted,fullyResolved:previousReview.outcome?.fullyResolved,closureReason:previousReview.outcome?.closureReason}:null};
   const reviewed=await actor(branch,t.id+'/'+i+'/'+policy,reviewInstruction,input,Review,false,v,t);
   const outcome=reviewed.parsed?applyPolicy(policy,author,reviewed.parsed,v,t):null;
   save(resultPath,{trajectory:t.id,event:i,policy,status:reviewed.parsed?'completed':'invalid-review',review:reviewed.parsed,outcome,actorError:reviewed.error});
   console.log(JSON.stringify({trajectory:t.id,event:i,policy,status:reviewed.parsed?'completed':'invalid-review',closed:outcome?.fullyResolved,acceptedCases:outcome?.acceptedCases.length}));
  }
 }
}
let cursor=0;await Promise.allSettled(Array.from({length:2},async()=>{while(cursor<cases.length&&!abort.signal.aborted){const index=cursor++,t=cases[index];try{await trajectory(t,index);}catch(e){save(join(root,t.id,'worker-error.json'),{error:e.message});}}}));
const count=cases.reduce((n,t)=>n+t.events.reduce((s,_,i)=>s+policies.filter(p=>existsSync(join(root,t.id,'event-'+i,p,'result.json'))).length,0),0);save(join(root,'execution-status.json'),{count,planned:48});if(count===48)save(join(root,'complete.json'),{at:new Date().toISOString(),count});
