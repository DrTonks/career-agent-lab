// Presentation-only correction discovered during result inspection; frozen scoring remains intact.
export function normalizePresentation(d){
 const text=s=>(s??'').replaceAll('**','').replaceAll('`','').replace(/(核定\s*[\[【]\s*)job:/g,'$1').replace(/^\|\s*(?:job:)?([A-Za-z0-9_-]+)\s*\|\s*(符合|不符|待核定)\s*\|/gm, (row,id,status)=>`核定[${id}]=${status} ${row}`);
 const artifacts=items=>items?.map(a=>({...a,result:{...a.result,summary:text(a.result.summary)}}));
 return {...d,answer:text(d.answer),artifacts:artifacts(d.artifacts),effectiveArtifacts:artifacts(d.effectiveArtifacts)};
}
