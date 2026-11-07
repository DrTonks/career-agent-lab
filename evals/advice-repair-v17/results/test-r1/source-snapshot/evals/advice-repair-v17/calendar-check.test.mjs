import test from 'node:test';import assert from 'node:assert/strict';
import {readCalendar,checkSchedule,closureCheck} from './calendar-check.mjs';
const initial={id:'e0',text:'|a|可用|周三|09:00|17:00|\n|l|占用|周三|12:00|13:00|'},change={id:'e1',text:'|c|占用|周三|14:00|17:00|'};
test('subtracting a course retains the available hour after lunch; concrete witness refutes a truncated schedule',()=>{
 const r=checkSchedule([initial,change],{candidateIntervals:[{day:'周三',start:'09:00',end:'12:00'}]});assert.equal(r.weeklyHours,4);assert.deepEqual(r.witness.omitted,[{day:'周三',range:[780,840]}]);assert.equal(r.ledger[2].quote,change.text);
});
test('overlapping blocks and availability are counted once, including half hours',()=>{
 const r=readCalendar([initial,{id:'e1',text:'|c|占用|周三|12:30|15:30|\n|x|可用|周三|16:00|19:00|'}]);assert.equal(r.weeklyHours,6.5);
});
test('irrelevant input preserves fact version; a real change and retraction update it',()=>{
 const before=checkSchedule([initial]);assert.equal(readCalendar([initial,{id:'e1',text:'封面变化'}]).factsHash,before.factsHash);
 const after=checkSchedule([initial,change],{compareReceiptId:before.id},[before]);assert.notEqual(after.factsHash,before.factsHash);assert.deepEqual(after.witness.unsupported,[{day:'周三',range:[840,1020]}]);
 assert.equal(readCalendar([initial,change,{id:'e2',text:'|c|撤销|-|-|-|'}]).weeklyHours,7);
 assert.throws(()=>readCalendar([initial,initial]),/Duplicate/);assert.throws(()=>checkSchedule([initial],{compareReceiptId:'fabricated'}),/Unknown/);
});
test('closure rejects fabricated, stale and mismatched arithmetic or outdated expert work',()=>{
 const r=checkSchedule([initial,change]),tasks=[{key:'k',lastExecution:{factsHash:r.factsHash}}],c={key:'k',receiptId:r.id,checkedWeeklyHours:4};
 assert.equal(closureCheck(c,tasks,[r],[initial,change]),null);
 assert.equal(closureCheck({...c,checkedWeeklyHours:3},tasks,[r],[initial,change]),'numeric-conclusion-disagrees-with-receipt');
 assert.equal(closureCheck(c,[{key:'k',lastExecution:{factsHash:'old'}}],[r],[initial,change]),'outputs-predate-current-calendar');
 assert.equal(closureCheck(c,tasks,[r],[initial]),'stale-calculation-receipt');
});

test('valid sources cannot close a task whose expert output repeats incorrect hours',()=>{const r=checkSchedule([initial,change]),task={key:'k',targets:['match'],lastExecution:{factsHash:r.factsHash}},c={key:'k',receiptId:r.id,checkedWeeklyHours:4};assert.equal(closureCheck(c,[task],[r],[initial,change],[{expert:'match',result:{summary:'周工时=3'}}]),'role-arithmetic-disagrees-with-receipt');});
