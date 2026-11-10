/** Exact top-level replacement, not recursive merge: removed holdings stay removed. */
export function serializedFields(value:object):Record<string,string|undefined>{
 return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,JSON.stringify(entry)]));
}
export function changedFields(before:Record<string,string|undefined>,value:object):Record<string,string|undefined>{
 const after=serializedFields(value),changes:Record<string,string|undefined>={};
 for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(before[key]!==after[key])changes[key]=after[key];
 return changes;
}
export function deltaSql(changes:Record<string,string|undefined>){
 let expression='value';const args:string[]=[];
 const paths=Object.entries(changes).map(([key,value])=>{
  if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))throw new Error('invalid_state_field');
  return {path:`$.${key}`,value};
 });
 const deleted=paths.filter(p=>p.value===undefined),set=paths.filter(p=>p.value!==undefined);
 if(deleted.length){expression=`json_remove(${expression},${deleted.map(()=>'?').join(',')})`;args.push(...deleted.map(p=>p.path));}
 if(set.length){expression=`json_set(${expression},${set.map(()=> '?,json(?)').join(',')})`;for(const p of set)args.push(p.path,p.value!);}
 return {expression,args};
}
