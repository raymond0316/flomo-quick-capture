const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
const sandbox={module:{exports:{}},require:()=>({Modal:class{},Notice:class{}}),crypto:webcrypto};vm.runInNewContext(fs.readFileSync('cleanup.js','utf8'),sandbox);
const {scanAttachments,trashSelection}=sandbox.module.exports;
function fixture(){
 const media=(name,data='abc')=>({path:'media/'+name,name,stat:{size:data.length,mtime:1},data});
 const files=[media('recording-used.m4a'),media('recording-copy.m4a'),media('image-free.png','different'),media('other.png'),{path:'elsewhere/image-other.png',name:'image-other.png',stat:{size:1,mtime:1},data:'x'},{path:'note.md',name:'note.md',text:'![[recording-used.m4a|音频]]'},{path:'board.canvas',name:'board.canvas',text:'{}'}];
 const trashed=[];
 const plugin={settings:{audioFolder:'media',imageFolder:'media'},app:{vault:{getFiles:()=>files,read:async file=>file.text,readBinary:async file=>new TextEncoder().encode(file.data).buffer,trash:async(file,system)=>{assert.equal(system,false);trashed.push(file.path);files.splice(files.indexOf(file),1);}},loadLocalStorage:()=>({})}};
 return {plugin,files,trashed};
}
test('scans only generated attachments; protects wikilinks and finds byte-identical copies',async()=>{
 const {plugin}=fixture();const rows=await scanAttachments(plugin);assert.equal(rows.length,3);assert.equal(rows.find(r=>r.path.endsWith('used.m4a')).referenced,true);assert.equal(rows.find(r=>r.path.endsWith('copy.m4a')).duplicateOf,'media/recording-used.m4a');assert.equal(rows.find(r=>r.path.endsWith('free.png')).duplicateOf,null);
});
test('rechecks newly added references and changed media; trashes only eligible files locally',async()=>{
 const {plugin,files,trashed}=fixture(),rows=await scanAttachments(plugin);
 files.find(f=>f.path==='board.canvas').text='{"file":"media/image-free.png"}';
 const result=await trashSelection(plugin,rows);assert.equal(result.trashed,1);assert.equal(result.skipped,2);assert.deepEqual(trashed,['media/recording-copy.m4a']);assert.equal(plugin.cleanupBusy,false);
});
test('read failure and active capture prevent cleanup; pending transcriptions are protected',async()=>{
 const {plugin}=fixture();plugin.capturing=true;await assert.rejects(scanAttachments(plugin));plugin.capturing=false;
 plugin.app.loadLocalStorage=()=>({'media/recording-copy.m4a':'pending'});assert.equal((await scanAttachments(plugin)).find(r=>r.path.endsWith('copy.m4a')).referenced,true);
 plugin.app.vault.read=async()=>{throw Error('sync unavailable');};await assert.rejects(trashSelection(plugin,[{path:'media/image-free.png'}]));assert.equal(plugin.cleanupBusy,false);
});
test('changes during a batch and modified attachments are skipped',async()=>{
 const {plugin,files,trashed}=fixture();const rows=(await scanAttachments(plugin)).filter(r=>!r.referenced);
 const original=plugin.app.vault.trash;plugin.app.vault.trash=async(file,system)=>{await original(file,system);files.find(f=>f.path==='note.md').text+=' ![[image-free.png]]';};
 const result=await trashSelection(plugin,rows);assert.equal(result.trashed,1);assert.equal(result.skipped,1);assert.equal(trashed.length,1);
 const next=fixture(),preview=await scanAttachments(next.plugin);next.files.find(f=>f.name==='image-free.png').stat.mtime=2;assert.equal((await trashSelection(next.plugin,[preview.find(r=>r.path.endsWith('free.png'))])).skipped,1);
});
test('URL-encoded references are protected',async()=>{
 const {plugin,files}=fixture();files.find(f=>f.path==='board.canvas').text='{"file":"media/recording%2Dcopy.m4a"}';assert.equal((await scanAttachments(plugin)).find(r=>r.path.endsWith('copy.m4a')).referenced,true);
});
