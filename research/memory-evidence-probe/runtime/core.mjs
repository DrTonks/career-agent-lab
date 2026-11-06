import {createHash} from 'node:crypto';

export const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const equal = (a,b) => canonical(a) === canonical(b);
function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
