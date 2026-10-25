const {getAllTags} = require('obsidian');
function tagContext(value,start,end=start) {
  if (start !== end) return null;
  const match=/(?:^|\s)#([\p{L}\p{N}_\/-]*)$/u.exec(value.slice(0,start));
  if (!match) return null;
  const from=start-match[1].length-1;
  const tail=/^[\p{L}\p{N}_\/-]*/u.exec(value.slice(start))[0];
  return {from,to:start+tail.length,query:match[1].toLocaleLowerCase()};
}
function collectTags(app) {
  const tags=new Set();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache=app.metadataCache.getFileCache(file);
    if (cache) for (const tag of getAllTags(cache)||[]) tags.add(tag);
  }
  return [...tags].sort((a,b)=>a.localeCompare(b,'zh-CN'));
}
function caretRect(input) {
  const doc=input.ownerDocument,style=doc.defaultView.getComputedStyle(input);
  const mirror=doc.createElement('div');
  for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderLeftWidth','boxSizing','wordSpacing','tabSize']) mirror.style[key]=style[key];
  Object.assign(mirror.style,{position:'absolute',visibility:'hidden',pointerEvents:'none',whiteSpace:'pre-wrap',overflowWrap:'break-word',width:input.clientWidth+'px',border:'0',left:'0',top:'0'});
  mirror.textContent=input.value.slice(0,input.selectionStart);
  const marker=doc.createElement('span');marker.textContent=input.value.slice(input.selectionStart)||'.';mirror.append(marker);doc.body.append(mirror);
  const rect=input.getBoundingClientRect();
  const result={left:rect.left+marker.offsetLeft-input.scrollLeft,top:rect.top+marker.offsetTop-input.scrollTop,height:parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.8};
  mirror.remove();return result;
}
function attachTagSuggestions(app,input) {
  const doc=input.ownerDocument;
  const panel=doc.createElement('div'); panel.className='flomo-tag-suggestions'; panel.hidden=true;
  panel.id='flomo-tag-list-'+Math.random().toString(36).slice(2);
  panel.setAttribute('role','listbox');panel.setAttribute('aria-label','已有标签');
  const host=input.closest('.modal') || doc.body;host.append(panel); input.setAttribute('aria-controls',panel.id); input.setAttribute('aria-autocomplete','list');
  let tags=collectTags(app),items=[],selected=0,composing=false;
  const listeners=[];
  const on=(target,type,fn)=>{target.addEventListener(type,fn);listeners.push(()=>target.removeEventListener(type,fn));};
  const hide=()=>{panel.hidden=true;items=[];input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');};
  const choose=tag=>{
    const context=tagContext(input.value,input.selectionStart,input.selectionEnd); if (!context) return hide();
    const suffix=input.value.slice(context.to);
    const insert=tag+(/^\s/.test(suffix)?'':' ');
    input.setRangeText(insert,context.from,context.to,'end');
    hide();input.focus();input.dispatchEvent(new input.ownerDocument.defaultView.Event('input',{bubbles:true}));hide();
  };
  const position=()=>{
    if(panel.hidden)return;
    const caret=caretRect(input),bounds=host.getBoundingClientRect(),viewport=doc.defaultView.visualViewport;
    const screenTop=viewport?.offsetTop||0,screenBottom=screenTop+(viewport?.height||doc.defaultView.innerHeight);
    const top=Math.max(bounds.top+8,screenTop+8),bottom=Math.min(bounds.bottom-8,screenBottom-8);
    const width=Math.max(120,Math.min(340,bounds.width-24));panel.style.width=width+'px';
    const below=Math.max(0,bottom-(caret.top+caret.height+6)),above=Math.max(0,caret.top-6-top);
    const down=below>=120 || below>=above;
    panel.style.maxHeight=Math.max(40,Math.min(240,down?below:above))+'px';
    panel.style.left=Math.max(8,Math.min(caret.left-bounds.left,bounds.width-width-8))+'px';
    panel.style.top=(down?Math.max(top,caret.top+caret.height+6)-bounds.top:Math.max(top,caret.top-6-panel.offsetHeight)-bounds.top)+'px';
  };
  const draw=()=>{
    panel.replaceChildren();panel.hidden=!items.length; input.setAttribute('aria-expanded',String(items.length>0));
    items.forEach((tag,index)=>{
      const button=doc.createElement('button');button.type='button';button.textContent=tag.slice(1);
      button.id=panel.id+'-'+index; button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===selected));
      button.className=index===selected?'is-selected':'';
      button.onpointerdown=e=>e.preventDefault();button.onclick=()=>choose(tag);panel.append(button);
    });
    if(items.length) {input.setAttribute('aria-activedescendant',panel.id+'-'+selected);position();const option=panel.children[selected];if(option){if(option.offsetTop<panel.scrollTop)panel.scrollTop=option.offsetTop;else if(option.offsetTop+option.offsetHeight>panel.scrollTop+panel.clientHeight)panel.scrollTop=option.offsetTop+option.offsetHeight-panel.clientHeight;}}
  };
  const update=()=>{
    if(composing)return hide();
    const context=tagContext(input.value,input.selectionStart,input.selectionEnd);
    if(!context)return hide();
    items=tags.filter(tag=>tag.slice(1).toLocaleLowerCase().includes(context.query)).sort((a,b)=>Number(!a.slice(1).toLocaleLowerCase().startsWith(context.query))-Number(!b.slice(1).toLocaleLowerCase().startsWith(context.query))).slice(0,50);
    selected=0;draw();
  };
  on(input,'input',update);on(input,'click',update);on(input,'scroll',position);
  on(doc,'scroll',position);on(doc.defaultView,'resize',position);
  if(doc.defaultView.visualViewport){on(doc.defaultView.visualViewport,'resize',position);on(doc.defaultView.visualViewport,'scroll',position);}
  on(host,'flomo:viewport',position);
  const scroller=input.closest('.flomo-body');if(scroller)on(scroller,'scroll',position);
  on(input,'focus',()=>{tags=collectTags(app);});on(input,'blur',e=>{if(!panel.contains(e.relatedTarget))hide();});
  on(input,'compositionstart',()=>{composing=true;hide();});on(input,'compositionend',()=>{composing=false;update();});
  on(input,'keydown',e=>{
    if(e.isComposing||composing||panel.hidden||!items.length)return;
    if(['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)) {
      e.preventDefault();e.stopPropagation();
      if(e.key==='Escape')return hide();
      if(e.key==='Enter'||e.key==='Tab')return choose(items[selected]);
      selected=(selected+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;draw();
    } else if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key))hide();
  });
  const ref=app.metadataCache.on('changed',()=>{tags=collectTags(app);});
  return ()=>{listeners.forEach(dispose=>dispose());app.metadataCache.offref(ref);panel.remove();};
}
module.exports={tagContext,collectTags,attachTagSuggestions};
