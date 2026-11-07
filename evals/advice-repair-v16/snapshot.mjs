import {readFileSync,copyFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const digestFile=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function cloneSnapshot(source,target){
 if(existsSync(source+'-wal')&&statSync(source+'-wal').size)throw Error('Uncheckpointed WAL');
 if(existsSync(target))throw Error('Refuse to replace an existing branch database');
 copyFileSync(source,target);const sourceHash=digestFile(source),forkHash=digestFile(target);
 if(sourceHash!==forkHash)throw Error('Fork differs from prefix');
 return {sourceHash,forkHash,bytes:statSync(source).size};
}
export function mergeArtifacts(previous,current){
 const latest=new Map(previous.map(a=>[a.expert,a]));
 // A failed new output stays visible to scoring; never hide it behind an old success.
 for(const a of current)latest.set(a.expert,a);
 return [...latest.values()];
}
