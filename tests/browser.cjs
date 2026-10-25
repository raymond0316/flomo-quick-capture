const {chromium}=require(process.env.FLOMO_PLAYWRIGHT_PATH || 'playwright');
const fs=require('fs');const assert=require('node:assert/strict');
const bundle=fs.readFileSync('dist/flomo-quick-capture/main.js','utf8').replace("module.exports=load('./main');","window.testExports={capture:load('./capture'),DraftStore:load('./drafts').DraftStore,CleanupModal:load('./cleanup').CleanupModal};");
const css=fs.readFileSync('styles.css','utf8');
const shim=String.raw`
Object.assign(Element.prototype,{
 createEl(tag,options={}){const el=document.createElement(tag);if(options.cls)el.className=options.cls;if(options.text)el.textContent=options.text;if(options.type)el.type=options.type;if(options.placeholder)el.placeholder=options.placeholder;if(options.alt)el.alt=options.alt;for(const [key,value]of Object.entries(options.attr||{}))el.setAttribute(key,value);this.append(el);return el;},
 createDiv(options){return this.createEl('div',options);},createSpan(options){return this.createEl('span',options);},setText(text){this.textContent=text;},addClass(name){this.classList.add(name);},empty(){this.replaceChildren();}
});
class Modal {
 constructor(app){this.app=app;this.containerEl=document.createElement('div');this.containerEl.className='modal-container';this.modalEl=this.containerEl.createDiv({cls:'modal'});this.titleEl=this.modalEl.createDiv({cls:'modal-title'});this.contentEl=this.modalEl.createDiv({cls:'modal-content'});}
 open(){document.body.append(this.containerEl);this.onOpen();}close(){this.onClose();this.containerEl.remove();}
}
window.require=()=>({Modal,Notice:class{constructor(text){window.notices.push(text);}hide(){}},getAllTags:cache=>cache.tags,setIcon(){}});
window.notices=[];window.moment=()=>({format:pattern=>({'YYYY':'2026','YYYY-MM-DD HH:mm:ss':'2026-10-19 23:59:59','YYYYMMDD-HHmmss':'20261019-235959','HH:mm:ss':'23:59:59'})[pattern]});
window.MediaRecorder=class{static isTypeSupported(){return true;}};
`;
const setup=String.raw`
window.files=new Map();window.failNotes=false;
const vault={getMarkdownFiles:()=>[{path:'tags.md'}],getAbstractFileByPath:path=>window.files.get(path),getName:()=> 'test',
 async createFolder(path){const f={path,children:[]};window.files.set(path,f);return f;},
 async createBinary(path,data){const f={path,data};window.files.set(path,f);return f;},
 async create(path,text){if(window.failNotes)throw Error('disk full');const f={path,text};window.files.set(path,f);return f;},
 async process(file,fn){if(window.failNotes)throw Error('disk full');file.text=fn(file.text);},
 async read(file){return file.text;}
};
window.plugin={app:{vault,metadataCache:{getFileCache:()=>({tags:['#比喻','#标准','#财富','#参数','#草稿','#产品','#产品/策略','#产品/产品经理',...Array.from({length:60},(_,i)=>'#标签'+i)]}),on:()=>({}),offref(){}},workspace:{openLinkText(){}},secretStorage:{getSecret:()=> '{}'}},settings:{noteFolder:'notes',audioFolder:'audio',imageFolder:'images',autoAsr:false,engine:'16k_zh'},drafts:new window.testExports.DraftStore('browser-test')};
window.openCapture=()=>{window.capturePromise=window.testExports.capture(window.plugin);return new Promise(resolve=>setTimeout(resolve,50));};
`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.FLOMO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message);});
 await page.route('https://flomo.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<style>body{margin:0;background:#222;color:#eee;--background-primary:#242424;--background-secondary:#303030;--background-modifier-border:#444;--text-normal:#eee;--text-muted:#aaa;--text-error:#f08080}.modal-container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}.modal{box-sizing:border-box}.modal-title{flex-shrink:0}textarea{color:#eee}button{border:0}'+css+'</style><script>'+shim+'</script><script>const module={exports:{}};'+bundle+'</script><script>'+setup+'</script>'}));
 await page.goto('https://flomo.test/');await page.evaluate(()=>openCapture());

 for(const width of [320,390,736]) {
  await page.setViewportSize({width,height:844});
  const body=await page.locator('.flomo-body').boundingBox();
  const button=page.getByRole('button',{name:'开始录音',exact:true});await button.hover();
  const box=await button.boundingBox();assert.ok(box.x>=body.x,'record button left edge stays inside scroll container');assert.ok(box.x+box.width<=body.x+body.width,'record button right edge stays inside scroll container');
 }
 await page.setViewportSize({width:390,height:844});

 // Reproduce phone theme positioning and a keyboard that overlays WKWebView.
 await page.evaluate(()=>{
  document.body.classList.add('is-mobile');
  const style=document.createElement('style');style.textContent='.is-mobile .modal-container{align-items:flex-end;padding-bottom:var(--keyboard-height,0px)}.is-mobile .modal{transform:translateY(70px);bottom:0;min-width:400px}.is-mobile .flomo-tools{margin-left:-8px;margin-right:-8px}';document.head.append(style);
  window.dispatchEvent(new CustomEvent('keyboardWillShow',{detail:{keyboardHeight:340}}));
 });
 await page.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('.modal-container')).height)-504)<1);
 let nativeFooter=await page.locator('.flomo-footer').boundingBox();assert.ok(nativeFooter.y+nativeFooter.height<=504,'native overlay keyboard leaves footer visible');
 const noOverflow=await page.evaluate(()=>[document.querySelector('.modal'),document.querySelector('.flomo-body'),document.querySelector('.flomo-tools')].every(el=>el.scrollWidth<=el.clientWidth));assert.ok(noOverflow,'phone layout has no horizontal overflow');
 await page.screenshot({path:'/tmp/flomo-ios-overlay.png'});
 await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:504});visualViewport.dispatchEvent(new Event('resize'));});
 assert.equal(Math.round((await page.locator('.modal-container').boundingBox()).height),504,'do not subtract native keyboard height twice');
 await page.evaluate(()=>{window.dispatchEvent(new Event('keyboardDidHide'));Object.defineProperty(visualViewport,'height',{configurable:true,value:844});document.body.style.setProperty('--keyboard-height','340px');visualViewport.dispatchEvent(new Event('resize'));});
 await page.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('.modal-container')).height)-504)<1);
 await page.evaluate(()=>{document.body.style.removeProperty('--keyboard-height');window.dispatchEvent(new Event('keyboardDidHide'));});
 await page.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('.modal-container')).height)-844)<1);
 const input=page.locator('.flomo-input');const emptyBox=await page.locator('.modal').boundingBox();await input.fill('#');const firstTagBox=await page.locator('.modal').boundingBox();assert.equal(emptyBox.y,firstTagBox.y);assert.equal(emptyBox.height,firstTagBox.height);await input.press('Escape');await input.fill('重启后恢复 #产品');
 await page.evaluate(async()=>{plugin.captureModal.addClip(new Blob(['test-audio'],{type:'audio/webm'}),'录音 23:59');plugin.captureModal.addImage(new File(['test-image'],'photo.png',{type:'image/png'}));await plugin.captureModal.persistDraft();});
 await page.reload();await page.evaluate(()=>openCapture());await assert.equal(await input.inputValue(),'重启后恢复 #产品');
 const restored=await page.evaluate(async()=>{const d=await plugin.drafts.load();return {clips:d.clips.length,images:d.images.length,audio:await d.clips[0].blob.text(),imageType:d.images[0].blob.type};});assert.deepEqual(restored,{clips:1,images:1,audio:'test-audio',imageType:'image/png'});
 // Restored modal uses red discard and only one image picker.
 assert.equal(await page.locator('.flomo-discard').isVisible(),true);assert.equal(await page.locator('input[type=file]').count(),1);
 const before=await page.locator('.modal').boundingBox();await input.fill('#');await page.locator('.flomo-tag-suggestions').waitFor({state:'visible'});const after=await page.locator('.modal').boundingBox();assert.equal(before.y,after.y);assert.equal(before.height,after.height);
 await input.press('ArrowDown');await input.press('Enter');assert.match(await input.inputValue(),/^#.+ /);
 // Keyboard shrinks the visual viewport; footer stays above its lower edge.
 await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:380});visualViewport.dispatchEvent(new Event('resize'));});
 const keyboard=await page.locator('.modal').boundingBox(),footer=await page.locator('.flomo-footer').boundingBox();assert.ok(keyboard.y+keyboard.height<=380.5);assert.ok(footer.y+footer.height<=380.5);
 await page.screenshot({path:'/tmp/flomo-keyboard.png'});
 await input.fill('失败后仍保留');await page.evaluate(()=>{plugin.realSave=plugin.drafts.save.bind(plugin.drafts);plugin.drafts.save=async()=>{throw Error('quota');};});
 await page.evaluate(()=>plugin.captureModal.persistDraft());await page.getByText('稍后继续',{exact:true}).click();assert.equal(await input.isVisible(),true);assert.equal(await page.locator('.flomo-draft-label').textContent(),'草稿未保存');assert.equal(await page.locator('.flomo-draft-retry').count(),1);
 await page.evaluate(()=>{plugin.drafts.save=plugin.realSave;});await page.locator('.flomo-draft-retry').click();await page.getByText('稍后继续',{exact:true}).click();await page.evaluate(()=>capturePromise);
 await page.evaluate(()=>openCapture());assert.equal(await input.inputValue(),'失败后仍保留');await page.locator('.flomo-discard').click();await page.locator('.flomo-discard').click();await page.waitForFunction(()=>document.querySelector('.flomo-input').value==='');assert.equal(await input.inputValue(),'');assert.equal(await page.evaluate(()=>plugin.drafts.load()),undefined);
 // Note write failure leaves a durable draft; successful write clears it.
 await input.fill('保存失败需要恢复');await page.evaluate(()=>{window.failNotes=true;});await page.getByText('保存记录',{exact:true}).click();await page.evaluate(()=>capturePromise);assert.equal((await page.evaluate(()=>plugin.drafts.load())).text,'保存失败需要恢复');
 await page.evaluate(()=>{window.failNotes=false;return openCapture();});assert.equal(await input.inputValue(),'保存失败需要恢复');await page.getByText('保存记录',{exact:true}).click();await page.evaluate(()=>capturePromise);assert.equal(await page.evaluate(()=>plugin.drafts.load()),undefined);
 assert.ok(await page.evaluate(()=>[...window.files.values()].some(f=>f.text?.includes('保存失败需要恢复'))));
 await page.evaluate(()=>{
  window.testAudio='new-recording';window.micFailure=false;window.recordFailure=false;
  navigator.mediaDevices.getUserMedia=async()=>{if(window.micFailure)throw Error('permission');return {getTracks:()=>[{stop(){}}]};};
  window.MediaRecorder=class{
   static isTypeSupported(){return true;}
   constructor(){this.state='inactive';this.mimeType='audio/webm';}
   start(){this.state='recording';}
   stop(){this.state='inactive';queueMicrotask(()=>{if(window.recordFailure){this.onerror?.();}else this.ondataavailable?.({data:new Blob([window.testAudio])});this.onstop?.();});}
  };
 });
 await page.evaluate(()=>openCapture());
 await page.getByRole('button',{name:'开始录音',exact:true}).click();
 await page.getByRole('button',{name:'停止录音',exact:true}).click();
 await page.getByRole('button',{name:'重录',exact:true}).waitFor();
 assert.equal(await page.locator('.flomo-clips button').count(),0);
 assert.equal(await page.getByRole('button',{name:'删除',exact:true}).isVisible(),true);
 await page.evaluate(async()=>{await plugin.captureModal.persistDraft();});
 assert.equal(await page.evaluate(async()=>await (await plugin.drafts.load()).clips[0].blob.text()),'new-recording');
 // A failed permission request or failed recording must preserve the old clip.
 await page.evaluate(()=>{window.micFailure=true;});await page.getByRole('button',{name:'重录',exact:true}).click();
 assert.equal(await page.evaluate(async()=>await plugin.captureModal.clips[0].blob.text()),'new-recording');
 await page.evaluate(()=>{window.micFailure=false;window.recordFailure=true;});
 await page.getByRole('button',{name:'重录',exact:true}).click();await page.getByRole('button',{name:'停止录音',exact:true}).click();
 await page.getByRole('button',{name:'重录',exact:true}).waitFor();
 assert.equal(await page.evaluate(async()=>await plugin.captureModal.clips[0].blob.text()),'new-recording');
 // A successful re-record replaces, rather than appends to, the existing audio.
 await page.evaluate(()=>{window.recordFailure=false;window.testAudio='replacement';});
 await page.getByRole('button',{name:'重录',exact:true}).click();await page.getByRole('button',{name:'停止录音',exact:true}).click();
 await page.getByRole('button',{name:'重录',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>plugin.captureModal.clips.length),1);
 assert.equal(await page.evaluate(async()=>await plugin.captureModal.clips[0].blob.text()),'replacement');
 await page.getByRole('button',{name:'删除',exact:true}).click();
 await page.getByRole('button',{name:'开始录音',exact:true}).waitFor();
 assert.equal(await page.locator('.flomo-clips audio').count(),0);
 await page.evaluate(()=>plugin.captureModal.persistDraft());assert.equal(await page.evaluate(()=>plugin.drafts.load()),undefined);
 await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.getByRole('button',{name:'停止录音',exact:true}).click();
 await page.getByRole('button',{name:'重录',exact:true}).waitFor();
 await page.screenshot({path:'/tmp/flomo-recording-controls.png'});
 await page.getByText('稍后继续',{exact:true}).click();await page.evaluate(()=>capturePromise);
 await page.evaluate(()=>openCapture());await page.getByRole('button',{name:'重录',exact:true}).waitFor();
 await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByText('稍后继续',{exact:true}).click();await page.evaluate(()=>capturePromise);

 // Cleanup is reachable as a modal, defaults to no selection, and requires confirmation.
 await page.evaluate(()=>{
  const file={path:'images/image-cleanup.png',name:'image-cleanup.png',stat:{size:3,mtime:1},data:new Uint8Array([1,2,3]).buffer};window.files.set(file.path,file);
  plugin.app.vault.getFiles=()=>[...window.files.values()];plugin.app.vault.readBinary=async f=>f.data;
  plugin.app.vault.trash=async(f,system)=>{if(system)throw Error('must use local trash');window.files.delete(f.path);};
  plugin.app.workspace.getLeaf=()=>({openFile:async file=>{window.previewPath=file.path;}});
  new window.testExports.CleanupModal(plugin).open();
 });
 const cleanup=page.locator('.flomo-cleanup');await cleanup.getByRole('button',{name:'扫描附件',exact:true}).click();
 await cleanup.locator('input[type=checkbox]').waitFor();assert.equal(await cleanup.locator('input[type=checkbox]').isChecked(),false);
 await cleanup.getByRole('button',{name:'预览',exact:true}).click();assert.equal(await page.evaluate(()=>window.previewPath),'images/image-cleanup.png');
 await cleanup.locator('input[type=checkbox]').check();await cleanup.getByRole('button',{name:'移入回收站',exact:true}).click();assert.equal(await page.evaluate(()=>window.files.has('images/image-cleanup.png')),true);
 await cleanup.getByRole('button',{name:'确认移入回收站',exact:true}).click();await page.waitForFunction(()=>!window.files.has('images/image-cleanup.png'));
assert.deepEqual(errors,[]);
 console.log('PASS: durable text/audio/images across reload, restoration/discard, write failure/retry, note failure retention, clear only after saved, floating tags without layout shift, keyboard viewport; recording/re-record/delete, failed re-record retention and restored controls.');await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
