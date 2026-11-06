import {createHash} from 'node:crypto';
export const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const roles=['match','path','report'];
export const arms=['direct-event','contrast-event','direct-persistent','contrast-persistent'];
export const fields=['months','days','hours','remote','extension','certified','permitted','applied'];
export const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
