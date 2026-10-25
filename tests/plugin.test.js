const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {updateFlomoNoteCount:update,parseRecords}=require('../count');
const heading='## 2026-10-19 23:00:00';
test('counts records, excludes fenced examples and preserves YAML',()=>{
 const input='---\ntags: [flomo]\nnoteCount: 99\n---\n'+heading+'\n```md\n'+heading+'\n```\n~~~\n'+heading+'\n~~~\n'+heading+'\n';
 const result=update(input); assert.match(result,/noteCount: 2/); assert.match(result,/tags: \[flomo\]/); assert.equal(update(result),result);
 assert.match(update(result.replace(heading,'')),/noteCount: 1/);
});
test('CRLF, BOM, missing frontmatter, zero and nested properties',()=>{
 for(const nl of ['\n','\r\n']) {
  const input='\uFEFF---'+nl+'nested:'+nl+'  noteCount: 8'+nl+'noteCount: 99'+nl+'---'+nl+heading+nl;
  const result=update(input); assert.equal(update(result),result); assert.match(result,/  noteCount: 8/); assert.equal((result.match(/^noteCount:/gm)||[]).length,1); assert.match(result,/noteCount: 1/);
 }
 assert.match(update('text'),/noteCount: 0/); assert.match(update(heading),/noteCount: 1/);
});
test('real vault annual documents: idempotent count updates without editing source',()=>{
 const base='/Users/raymond/Library/Mobile Documents/iCloud~md~obsidian/Documents/Raymond/01.快速记录/flomo-import';
 for(const name of fs.readdirSync(base).filter(n=>/^\d{4}年\.md$/.test(n))) {
  const original=fs.readFileSync(base+'/'+name,'utf8'); const updated=update(original);
  assert.equal(update(updated),updated); assert.equal(original.slice(original.indexOf('\n---\n')+5),updated.slice(updated.indexOf('\n---\n')+5));
 }
});
test('packaged plugin refreshes counts after create, modify, rename and startup without a write loop',async()=>{
 const events={};const timers=[];let writes=0;
 const file={path:'01.快速记录/flomo-import/2026年.md',name:'2026年.md',extension:'md',parent:{path:'01.快速记录/flomo-import'}};
 let text=heading;
 class Plugin {async loadData(){return null;} addSettingTab(){} addRibbonIcon(){} addCommand(){} registerEvent(){} }
 const app={vault:{on:(event,cb)=>events[event]=cb,getMarkdownFiles:()=>[file],read:async()=>text,process:async(f,fn)=>{text=fn(text);writes++;events.modify(file);}},workspace:{onLayoutReady:cb=>cb()}};
 const sandbox={module:{exports:{}},require:()=>({Plugin,Modal:class{},PluginSettingTab:class{},Notice:class{}}),setTimeout:cb=>{timers.push(cb);return cb;},clearTimeout:cb=>{const i=timers.indexOf(cb);if(i>=0)timers.splice(i,1);}};
 vm.runInNewContext(fs.readFileSync('dist/flomo-quick-capture/main.js','utf8'),sandbox);
 const plugin=new sandbox.module.exports();plugin.app=app;await plugin.onload();
 const drain=async()=>{let limit=10;while(timers.length&&limit--)await timers.shift()();assert.ok(limit>0);};
 await drain(); assert.match(text,/noteCount: 1/);assert.equal(writes,1);
 text+='\n'+heading;events.modify(file);await drain();assert.match(text,/noteCount: 2/);assert.equal(writes,2);
 file.path='Other/2026年.md';file.parent.path='Other';events.rename(file);await drain();assert.equal(writes,2);
 plugin.onunload();
});
test('tag completion handles Chinese, nested tags and cursor replacement without matching URL fragments',()=>{
 const sandbox={module:{exports:{}},require:()=>({getAllTags:cache=>cache.tags})};
 vm.runInNewContext(fs.readFileSync('tags.js','utf8'),sandbox);
 const {tagContext,collectTags}=sandbox.module.exports;
 for(const value of ['#','想法 #工作/产品','\n#中文']) assert.ok(tagContext(value,value.length));
 for(const value of ['https://example.com/#tag','word#tag','##','#tag!']) assert.equal(tagContext(value,value.length),null);
 assert.equal(tagContext('#tag',1,3),null);
 const value='开头 #工作/产品 后文';const context=tagContext(value,6);
 assert.equal(value.slice(context.from,context.to),'#工作/产品');
 assert.equal(value.slice(0,context.from)+'#新标签'+value.slice(context.to),'开头 #新标签 后文');
 const app={vault:{getMarkdownFiles:()=>['one','two']},metadataCache:{getFileCache:()=>({tags:['#中文','#工作/产品','#中文']})}};
 assert.equal(collectTags(app).length,2);
});
test('parseRecords counts stay consistent with updateFlomoNoteCount across BOM, CRLF and fences',()=>{
 for(const nl of ['\n','\r\n']) {
  const input='\uFEFF---'+nl+'tags: [flomo]'+nl+'---'+nl+heading+nl+'```md'+nl+heading+nl+'```'+nl+'~~~'+nl+heading+nl+'~~~'+nl+heading+nl;
  assert.equal(parseRecords(input).length,2);
  assert.match(update(input),/noteCount: 2/);
 }
 const plain='没有 frontmatter 的正文\n'+heading;
 assert.equal(parseRecords(plain).length,1);
 assert.match(update(plain),/noteCount: 1/);
});
