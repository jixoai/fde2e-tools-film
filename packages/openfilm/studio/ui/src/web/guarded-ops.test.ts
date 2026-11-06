import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guardedOps} from './guarded-ops.ts';
const film=()=>({stage:{w:320,h:180},tracks:[{locked:true,clips:[{id:'a',src:'a.png',time:[0,2] as [number,number]}]},{clips:[{id:'b',src:'b.png',time:[0,2] as [number,number]}]}]});
test('raw operations cannot delete, mutate or insert into a locked track',()=>{
 for(const ops of [[{op:'remove',clip:'a'}],[{op:'track',track:0,field:'locked',value:false},{op:'remove',clip:'a'}],[{op:'props',edits:[{clip:'a',prop:'volume',value:0}]}],[{op:'move',clip:'b',track:0,at:3}]])assert.throws(()=>guardedOps(film(),ops as never),/locked/);
 assert.equal(Boolean(guardedOps(film(),[{op:'track',track:0,field:'locked',value:false}]).tracks[0]?.locked),false);
 assert.equal(guardedOps(film(),[{op:'remove',clip:'b'}]).tracks.length,1);
});
