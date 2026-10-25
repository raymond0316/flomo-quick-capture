const {Modal,Notice} = require('obsidian');
const MEDIA=/\.(?:m4a|mp3|wav|ogg|webm|mp4|aac|flac|opus|amr|pcm|silk|speex|jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?|svg)$/i;
const TEXT=/\.(?:md|canvas|base|json|txt|html?|svg|css|js|ts|ya?ml|csv|xml|m3u)$/i;
function candidates(files,settings) {
  return files.filter(file=>[settings.audioFolder,settings.imageFolder].some(folder=>file.path.startsWith(folder+'/')) && !file.path.split('/').some(part=>part.startsWith('.')) && /^(?:recording|image)-/.test(file.name) && MEDIA.test(file.name));
}
function assertIdle(plugin) {
  if(plugin.capturing || plugin.captureModal?.containerEl?.isConnected)throw new Error('请先保存或关闭快速记录，再扫描清理。');
}
async function scanAttachments(plugin,{hash=true}={}) {
  assertIdle(plugin);
  const {vault}=plugin.app,files=vault.getFiles(),items=candidates(files,plugin.settings);
  const used=new Set(),pending=plugin.app.loadLocalStorage?.('flomo-asr-pending-results')||{};
  for(const file of items)if(pending[file.path] || globalThis.window?.__raymondFlomoAsrActive?.has(file.path))used.add(file.path);
  // Conservative basename matching also protects aliases, short wikilinks and canvas/base links.
  for(const file of files.filter(f=>TEXT.test(f.path))) {
    let text=await vault.read(file); // Fail closed if any potentially referring file cannot be read.
    text=text.replace(/(?:%[0-9a-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch(_){return part;}}).toLowerCase().replace(/\\\//g,'/');
    for(const item of items)if(text.includes(item.name.toLowerCase()) || text.includes(encodeURIComponent(item.name).toLowerCase()))used.add(item.path);
  }
  const rows=items.map(file=>({file,path:file.path,size:file.stat.size,mtime:file.stat.mtime,referenced:used.has(file.path),digest:null,duplicateOf:null}));
  if(hash) {
    const groups=new Map();
    for(const row of rows){const group=groups.get(row.size)||[];group.push(row);groups.set(row.size,group);}
    for(const group of groups.values())if(group.length>1) {
      const matches=new Map();
      for(const row of group){
        const data=await vault.readBinary(row.file);
        const digest=await globalThis.crypto.subtle.digest('SHA-256',data);
        row.digest=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
        const same=matches.get(row.digest)||[];same.push(row);matches.set(row.digest,same);
      }
      for(const same of matches.values())if(same.length>1){
        same.sort((a,b)=>Number(b.referenced)-Number(a.referenced)||a.path.localeCompare(b.path));
        for(let i=1;i<same.length;i++)same[i].duplicateOf=same[0].path;
      }
    }
  }
  return rows;
}
async function trashSelection(plugin,selection) {
  assertIdle(plugin);
  if(plugin.cleanupBusy)throw new Error('已有附件清理正在进行。');
  plugin.cleanupBusy=true;
  const result={trashed:0,skipped:0,failed:0};
  try {
    for(const old of selection) {
      assertIdle(plugin);
      // Re-check references for every file, including changes made during a batch.
      const current=await scanAttachments(plugin,{hash:false});
      const row=current.find(item=>item.path===old.path);
      if(!row || row.referenced || row.size!==old.size || row.mtime!==old.mtime){result.skipped++;continue;}
      try {await plugin.app.vault.trash(row.file,false);result.trashed++;}
      catch(_){result.failed++;}
    }
    return result;
  } finally {plugin.cleanupBusy=false;}
}
function sizeLabel(bytes){return bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB';}
class CleanupModal extends Modal {
  constructor(plugin){super(plugin.app);this.plugin=plugin;this.selected=new Set();this.rows=[];}
  onOpen(){this.titleEl.setText('附件清理');this.modalEl.addClass('flomo-cleanup');this.render();}
  render(){
    const el=this.contentEl;el.empty();
    el.createEl('p',{text:'仅扫描配置目录中插件生成的 recording- 录音和 image- 图片。核对仓库内文本引用；所有候选默认不勾选，已引用文件不可清理。'});
    const status=el.createEl('p',{text:this.message||'扫描不会修改文件。',attr:{'aria-live':'polite'}});
    const scan=el.createEl('button',{text:'扫描附件'});
    scan.onclick=async()=>{
      this.scanning=true;scan.disabled=true;status.setText('正在核对引用和重复内容…');
      try{this.rows=await scanAttachments(this.plugin);this.scanning=false;this.selected.clear();this.confirming=false;this.message='扫描完成：'+this.rows.filter(r=>!r.referenced).length+' 个未引用附件，'+this.rows.filter(r=>r.referenced).length+' 个已引用附件已保护。';this.render();}
      catch(error){this.scanning=false;status.setText(error.message||'扫描失败，未修改任何文件。');scan.disabled=false;}
    };
    const actionable=this.rows.filter(row=>!row.referenced),duplicates=this.rows.filter(row=>row.duplicateOf);
    if(!actionable.length){if(this.rows.length)el.createEl('p',{text:'没有可清理的未引用附件。'});return;}
    const list=el.createDiv({cls:'flomo-cleanup-list'});
    for(const row of actionable){
      const label=list.createEl('label',{cls:'flomo-cleanup-row'});
      const check=label.createEl('input',{type:'checkbox'});check.checked=this.selected.has(row.path);
      const detail=label.createDiv();detail.createEl('div',{text:row.path,cls:'flomo-cleanup-path'});
      detail.createEl('small',{text:sizeLabel(row.size)+' · '+(row.duplicateOf?'内容重复 · 保留副本：'+row.duplicateOf:'未找到文本引用')});
      check.onchange=()=>{check.checked?this.selected.add(row.path):this.selected.delete(row.path);this.confirming=false;refresh();};
      const view=detail.createEl('button',{text:'预览'});view.type='button';view.onclick=event=>{event.preventDefault();void this.app.workspace.getLeaf('tab').openFile(row.file);};
    }
    if(duplicates.some(row=>row.referenced))el.createEl('p',{text:'部分相同内容仍被笔记引用，已保护，不会列入清理候选。'});
    el.createEl('p',{text:'清理将移入仓库的 .trash 文件夹，可从该位置找回。'});
    const summary=el.createEl('p'),clean=el.createEl('button',{text:'移入回收站'});
    const refresh=()=>{const rows=actionable.filter(row=>this.selected.has(row.path));summary.setText('已选 '+rows.length+' 个 · '+sizeLabel(rows.reduce((sum,row)=>sum+row.size,0)));clean.disabled=!rows.length;clean.setText(this.confirming?'确认移入回收站':'移入回收站');};refresh();
    clean.onclick=async()=>{
      if(this.scanning)return;
      if(!this.confirming){this.confirming=true;refresh();return;}
      clean.disabled=true;scan.disabled=true;list.querySelectorAll('input').forEach(input=>input.disabled=true);
      try{
        const result=await trashSelection(this.plugin,actionable.filter(row=>this.selected.has(row.path)));
        new Notice(`已移入回收站 ${result.trashed} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`);
        this.rows=[];this.selected.clear();this.message='清理完成。可重新扫描查看剩余附件。';this.confirming=false;this.render();
      }catch(error){this.message=error.message||'清理未完成，请重新扫描。';this.confirming=false;this.render();}
    };
  }
}
module.exports={scanAttachments,trashSelection,candidates,CleanupModal};
