import {createHash} from 'node:crypto';
export const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const days=['周一','周二','周三','周四','周五','周六','周日'];
const time=x=>{if(!/^\d{2}:\d{2}$/.test(x))throw Error('Invalid clock');const [h,m]=x.split(':').map(Number);if(h>24||m>59||(h===24&&m!==0))throw Error('Invalid clock');return h*60+m;};
export function union(xs){const out=[];for(const [a,b] of xs.toSorted((x,y)=>x[0]-y[0])){const last=out.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out;}
export function subtract(xs,ys){let out=union(xs);for(const [c,d] of union(ys))out=out.flatMap(([a,b])=>d<=a||c>=b?[[a,b]]:[[a,Math.max(a,c)],[Math.min(b,d),b]].filter(([x,y])=>x<y));return out;}
export function readCalendar(sources){
 const records=new Map(),ledger=[];
 for(const [turnIndex,src] of sources.entries()){for(const line of src.text.split('\n')){
  if(!line.trim().startsWith('|'))continue;const cells=line.split('|').slice(1,-1).map(x=>x.trim());
  if(cells.length!==5||!['可用','占用','撤销'].includes(cells[1]))continue;
  const [id,kind,day,start,end]=cells;if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid record ID');
  const source={sourceId:src.id,turnIndex,sourceHash:digest(src.text),quote:line};
  if(kind==='撤销'){if(!records.has(id))throw Error('Unknown withdrawn record');records.delete(id);ledger.push({id,kind,...source});continue;}
  if(!days.includes(day))throw Error('Invalid weekday');const a=time(start),b=time(end);if(a>=b)throw Error('Empty or overnight range');
  if(records.has(id))throw Error('Duplicate active record ID; retract first');
  const record={id,kind,day,start:a,end:b,...source};records.set(id,record);ledger.push(record);
 }}
 if(!records.size)throw Error('No calendar records');
 const active=[...records.values()],intervals=Object.fromEntries(days.map(day=>[day,subtract(active.filter(r=>r.day===day&&r.kind==='可用').map(r=>[r.start,r.end]),active.filter(r=>r.day===day&&r.kind==='占用').map(r=>[r.start,r.end]))]));
 const dailyHours=Object.fromEntries(days.map(day=>[day,intervals[day].reduce((s,[a,b])=>s+b-a,0)/60]));
 return {factsHash:digest(active),sourceRefs:[...new Set(ledger.map(r=>r.sourceId))],ledger,intervals,dailyHours,weeklyHours:Object.values(dailyHours).reduce((a,b)=>a+b,0),workingDays:Object.values(dailyHours).filter(h=>h>0).length};
}
export function checkSchedule(sources,{compareReceiptId=null,candidateIntervals=null}={},previous=[]){
 const actual=readCalendar(sources);let claim=null,comparisonOrigin=null;
 if(compareReceiptId){const old=previous.find(r=>r.id===compareReceiptId);if(!old)throw Error('Unknown comparison receipt');claim=old.intervals;comparisonOrigin={receiptId:old.id,factsHash:old.factsHash};}
 if(candidateIntervals){if(compareReceiptId)throw Error('Choose one comparison');claim=Object.fromEntries(days.map(d=>[d,[]]));for(const r of candidateIntervals){if(!days.includes(r.day))throw Error('Invalid candidate day');const a=time(r.start),b=time(r.end);if(a>=b)throw Error('Invalid candidate range');claim[r.day].push([a,b]);}comparisonOrigin={type:'model-hypothesis-not-source-fact'};}
 const witness=claim?{omitted:days.flatMap(day=>subtract(actual.intervals[day],claim[day]??[]).map(range=>({day,range}))),unsupported:days.flatMap(day=>subtract(claim[day]??[],actual.intervals[day]).map(range=>({day,range})))}:null;
 const body={schemaVersion:'schedule-check-v1',...actual,comparisonOrigin,witness,scope:'Deterministic arithmetic over quoted calendar records only. sourceId is a review log ID; native experts must use input_history_list/read for the indicated turnIndex, not cite the receipt as a native evidence ID. No job eligibility or completeness outside the declared records is certified.'};
 return {id:'schedule:'+digest(body).slice(0,24),...body};
}
export const scheduleTool={type:'function',function:{name:'schedule_check',description:'Calculate the current weekly calendar from ALL visible original table records. Available intervals are unioned then occupied intervals subtracted, including overlap and half hours. Optionally compare a prior calculation receipt or a candidate schedule and return concrete omitted/unsupported time segments. The receipt does not decide job eligibility.',parameters:{type:'object',properties:{compareReceiptId:{type:['string','null']},candidateIntervals:{type:['array','null'],items:{type:'object',properties:{day:{type:'string',enum:days},start:{type:'string'},end:{type:'string'}},required:['day','start','end'],additionalProperties:false}}},required:['compareReceiptId','candidateIntervals'],additionalProperties:false}}};
export function closureCheck(closure,tasks,receipts,sources,artifacts=[]){
 const task=tasks.find(t=>t.key===closure.key),r=receipts.find(r=>r.id===closure.receiptId);
 if(!task||!r)return 'missing-calculation-receipt';
 if(r.factsHash!==readCalendar(sources).factsHash)return 'stale-calculation-receipt';
 if(task.lastExecution?.factsHash!==r.factsHash)return 'outputs-predate-current-calendar';
 if(closure.checkedWeeklyHours!==r.weeklyHours)return 'numeric-conclusion-disagrees-with-receipt';
 for(const role of task.targets??[]){const a=artifacts.filter(a=>a.expert===role).at(-1);if(!a||readHours(a.result.summary)!==r.weeklyHours)return 'role-arithmetic-disagrees-with-receipt';}
 return null;
}

export function readHours(text){const values=[...text.replaceAll('**','').matchAll(/周工时\s*[=＝:：]\s*([0-9]+(?:\.[0-9]+)?)/g)].map(m=>Number(m[1]));return values.length&&new Set(values).size===1?values[0]:null;}
