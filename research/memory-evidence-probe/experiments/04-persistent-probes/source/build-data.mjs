// Synthetic source generator. Hidden evaluator specifications never enter prompts.
import {mkdirSync,writeFileSync} from 'node:fs';
import {hash} from './core.mjs';
const base=new URL('./',import.meta.url);
const scenarios=['immediate','delayed','missing','rule-change','no-action-change','scope-conflict'];
const names=['项目运营助理','课程交付助理','社区内容专员','实验室协调员','客户培训助理','资料研究助理'];
function rule(family,n,revision,scenario){
 const m=family==='extension'?8:5+n%2,d=4,w=30,h=8;
 const spec={family,minMonths:m,minDays:d,minWeekly:w,minDaily:h};
 if(revision===2&&scenario==='rule-change')spec.minMonths=3;
 if(revision===2&&scenario!=='rule-change')spec.minDays=3;
 const clauses={standard:`可承诺月数至少${spec.minMonths}个月、每周现场至少${spec.minDays}天，且每周现场时长至少${w}小时`,portfolio:`可承诺月数至少${spec.minMonths}个月或已取得专项认证，两者满足其一；另须每周现场至少${spec.minDays}天且每周现场时长至少${w}小时`,combined:`可承诺月数至少${spec.minMonths}个月，每周现场天数与获准远程天数之和至少${spec.minDays}天，且现场天数乘每日现场小时数至少${w}小时`,extension:`可承诺月数与已批准延长期的月数之和至少${spec.minMonths}个月，每周现场至少${spec.minDays}天且现场周时长至少${w}小时`,either:`可承诺月数至少${spec.minMonths}个月，另外每周现场至少${spec.minDays}天或现场周时长至少${w}小时，两者满足其一即可`,floor:`可承诺月数至少${spec.minMonths}个月，每周现场至少${spec.minDays}天，且每天现场至少${h}小时`};
 return {public:{id:`policy-${hash([family,n,revision]).slice(0,12)}`,version:revision,text:`本岗位必须有有效实习许可(permitted=true)，并满足：${clauses[family]}。现场周时长=days*hours。月份均为完整月。资格match只判断这些要求；report推荐值与资格相同；已申请(applied=true)且符合则path=wait，未申请且符合则apply，不符合且已申请则withdraw，否则none；证据不足以确定时相应值为null。`},spec};
}
function trajectory(split,n,family,scenario){
 const id='t-'+hash([split,n,family,scenario,'v12-r1']).slice(0,12),scope='岗位/'+id;
 const initial={months:6,days:4,hours:8,remote:1,extension:2,certified:false,permitted:scenario!=='no-action-change',applied:false};
 const domains={months:[2,3,4,5,6,7,8],days:[1,2,3,4,5],hours:[6,7,8,9],remote:[0,1,2],extension:[0,1,2,3],certified:[false,true],permitted:[false,true],applied:[false,true]};
 const r1=rule(family,n,1,scenario),r2=rule(family,n,2,scenario),actualMonths=parseInt(hash([id,"months"]).slice(0,2),16)%2?3:6,actualDays=parseInt(hash([id,"days"]).slice(0,2),16)%3?4:2;
 const events=[],hidden=[];
 const document=(key,value,version,tag,wrong=false)=>({id:'doc-'+hash([id,key,version,tag]).slice(0,14),scope:wrong?scope+'/另一申请人':scope,title:({months:['教务协调回函','实践安排确认件','可履约时间确认'],days:['现场安排回执','项目排班核定单']}[key]??['安排确认'])[n%(key==='days'?2:3)],text:`${wrong?'另一申请人':'本人'}当前有效确认：${key==='months'?'从岗位规定入职日起可连续实习的完整月数':'每周现场出勤天数'}为${value}。对应条件修订号${version}。`,observations:{[key]:{value,version}},documentStatus:tag==='stale'?'历史归档':'本次出具'});
 const push=(observations={},documents=[],extra={})=>{const i=events.length+1;events.push({id:`${id}-e${i}`,scope,text:`事件${i}：${extra.text??'收到一项后续材料或安排变化。'}`,observations,documents,...extra});hidden.push({eventId:`${id}-e${i}`,actualMonths,actualDays});};
 push({months:{value:null,version:2}},[],{text:'本人后续可履约月数尚在协调，原确认已撤回；范围为2至8个完整月。请据新情况维护建议。'});
 push({},scenario==='immediate'?[document('months',actualMonths,2,'early')]:[document('months',6,2,'other',true)],{text:'材料目录有新增回函，标题不代表正文已核定。'});
 push({days:{value:null,version:2},applied:{value:true,version:2}},[],{text:'已提交申请；每周现场排班正在重排，原排班不再有效，范围为1至5天。'});
 push({},[],{rule:r2.public,text:scenario==='rule-change'?'岗位修改了月数条件，其余要求以新规则原件为准。':'岗位更新了出勤要求，请以新规则原件为准。'});
 push({},[document('days',5,2,'other',true)],{scope:scope+'/其他项目',text:'另一个项目新增一份排班回执。',compact:true});
 push({},scenario==='missing'?[]:[document('months',6,1,'stale'),document('months',actualMonths,2,'current'),document('months',actualMonths===6?3:6,2,'other2',true)],{text:'收到后续确认，资料目录包含历史件与其他申请人的材料。'});
 push({},[document('days',actualDays,2,'current')],{text:'现场安排核定材料已到达。'});
 push({months:{value:null,version:3}},scenario==='missing'?[]:[document('months',actualMonths===6?3:6,3,'new')],{text:'本人可履约月数再次调整，条件修订号3；先前确认不再代表当前情况。'});
 return {public:{id,scope,job:names[n%names.length],split,initial,domains,rule:r1.public,events},gold:{id,family,scenario,initial,domains,ruleSpecs:{[r1.public.id]:r1.spec,[r2.public.id]:r2.spec},hidden}};
}
const out={development:[],test:[]},gold={};
for(const [split,families,repetitions]of [['development',['standard','portfolio'],1],['test',['combined','extension','either','floor'],2]]){
 let n=0;for(let rep=0;rep<repetitions;rep++)for(const family of families)for(const scenario of scenarios){const t=trajectory(split,n++,family,scenario);out[split].push(t.public);gold[t.public.id]=t.gold;}
}
mkdirSync(new URL('data/',base),{recursive:true});mkdirSync(new URL('private/',base),{recursive:true});
for(const [split,rows]of Object.entries(out))writeFileSync(new URL(`data/${split}.json`,base),JSON.stringify(rows,null,2)+'\n');
writeFileSync(new URL('private/gold.json',base),JSON.stringify(gold,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.length]))));
