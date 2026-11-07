import test from 'node:test';import assert from 'node:assert/strict';
import {contextFor} from './probe.mjs';
test('downstream task rendering cannot promote a model-suggested answer or hypothetical branch to a fact',()=>{
 const task={key:'k',question:'预设错误：每周17小时',branches:[{condition:'虚构变化'}],targets:['match'],evidenceRefs:[],binding:{},readIds:[]};
 const c=contextFor([],[],[task],[{id:'verified',weeklyHours:18}]);assert(!JSON.stringify(c).includes('17小时'));assert(!JSON.stringify(c).includes('虚构变化'));assert.equal(c.derivationChecks[0].weeklyHours,18);
});
import {review} from './probe.mjs';
test('ordinary review can spontaneously propose a counterexample without losing its valid task',async()=>{
 const event={id:'e1',text:'新增课程\n|a|可用|周三|09:00|17:00|'},sources=[{id:'event:e1',text:event.text}],artifact={id:'m',expert:'match',version:1,result:{status:'succeeded',summary:'old'},publishedEvidence:[]};
 const task={subject:'user',field:'availability.weeklyHours',question:'核对变化',targets:['match'],claimRefs:['artifact:m'],evidenceRefs:['event:e1'],readIds:[],action:'dispatch',eventQuote:'新增课程',branches:[{condition:'时段冲突',consequence:'核对'}]};
 const provider={complete:async()=>({message:{role:'assistant',content:null,tool_calls:[{id:'x',type:'function',function:{name:'review_submit',arguments:JSON.stringify({tasks:[task],closed:[],receiptIds:[]})}}]},usage:{}})};
 const out=await review(provider,{arm:'direct',event,artifacts:[artifact],priorTasks:[],catalog:[],initial:false,signal:new AbortController().signal,sources});
 assert.equal(out.active.length,1);assert.deepEqual(out.errors,[]);assert.equal(contextFor([],[],out.active).tasks[0].question.includes('时段冲突'),false);
});
