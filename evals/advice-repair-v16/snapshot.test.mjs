import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloneSnapshot,mergeArtifacts} from './snapshot.mjs';
test('fork copies identical bytes and refuses live WAL or existing destination',()=>{
 const dir=mkdtempSync(join(tmpdir(),'career-fork-'));try{
 const src=join(dir,'a.sqlite'),dst=join(dir,'b.sqlite');writeFileSync(src,'frozen database bytes');writeFileSync(src+'-wal','pending');
 assert.throws(()=>cloneSnapshot(src,dst),/WAL/);writeFileSync(src+'-wal','');
 const out=cloneSnapshot(src,dst);assert.equal(out.sourceHash,out.forkHash);assert.throws(()=>cloneSnapshot(src,dst),/existing/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('carry forward untouched roles but do not conceal a failed newer role',()=>{
 const old=[{expert:'match',id:'old'},{expert:'path',id:'p'}];
 const current=[{expert:'match',id:'new',failure:{code:'limit'}}];
 assert.deepEqual(mergeArtifacts(old,current),[current[0],old[1]]);
});
