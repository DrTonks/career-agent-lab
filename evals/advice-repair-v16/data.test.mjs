import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {readCalendar} from './calendar-check.mjs';
const data=JSON.parse(readFileSync(new URL('./data/test.json',import.meta.url))),gold=JSON.parse(readFileSync(new URL('./private/gold.json',import.meta.url)));
test('all manually specified expectations agree with independent minute-grid arithmetic',()=>{
 for(const t of data){const cells=Array.from({length:7},()=>({yes:new Set(),no:new Set()}));
  for(let i=0;i<t.events.length;i++){
   for(const row of t.events[i].text.split('\n')){const c=row.split('|').slice(1,-1).map(s=>s.trim());if(c.length!==5||!['可用','占用'].includes(c[1]))continue;const day=['周一','周二','周三','周四','周五','周六','周日'].indexOf(c[2]),mins=s=>Number(s.slice(0,2))*60+Number(s.slice(3));for(let m=mins(c[3]);m<mins(c[4]);m++)cells[day][c[1]==='可用'?'yes':'no'].add(m);}
   const n=cells.reduce((s,d)=>s+[...d.yes].filter(m=>!d.no.has(m)).length,0)/60;
   assert.equal(n,gold[t.id][i].calculation);assert.equal(readCalendar(t.events.slice(0,i+1).map(e=>({id:e.id,text:e.text}))).weeklyHours,n);
  }
 }
});
