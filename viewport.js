const {Platform} = require('obsidian');
function attachViewport(modal) {
  const doc=modal.modalEl.ownerDocument,win=doc.defaultView,viewport=win.visualViewport,container=modal.containerEl;
  const mobile=()=>Boolean(Platform?.isMobile)||doc.body.classList.contains('is-mobile')||win.matchMedia('(max-width:600px)').matches;
  let baseline=Math.max(viewport?.height||0,win.innerHeight),nativeHeight=0,disposed=false,frame;
  function update() {
    if(disposed)return;
    if(!mobile()){container.classList.remove('flomo-mobile-viewport','flomo-keyboard-open');return;}
    const cssHeight=parseFloat(win.getComputedStyle(doc.body).getPropertyValue('--keyboard-height'))||0;
    const keyboard=Math.max(nativeHeight,cssHeight);
    const visible=viewport?.height||win.innerHeight;
    if(!keyboard && doc.activeElement?.tagName!=='TEXTAREA')baseline=Math.max(baseline,visible,win.innerHeight);
    // WKWebView may overlay the keyboard without resizing visualViewport.
    // Take the smallest boundary, rather than subtracting a keyboard twice.
    const height=Math.max(0,Math.min(visible,keyboard?baseline-keyboard:visible));
    container.classList.add('flomo-mobile-viewport');
    container.classList.toggle('flomo-keyboard-open',keyboard>0||height<baseline-100);
    container.style.setProperty('--flomo-viewport-height',height+'px');
    container.style.setProperty('--flomo-viewport-top',(viewport?.offsetTop||0)+'px');
    modal.modalEl.dispatchEvent(new win.Event('flomo:viewport'));
  }
  function schedule(){update();win.cancelAnimationFrame(frame);frame=win.requestAnimationFrame(update);}
  function show(event){nativeHeight=Number(event.keyboardHeight??event.detail?.keyboardHeight)||0;schedule();}
  function hide(){nativeHeight=0;schedule();}
  const listeners=[];
  const on=(target,event,fn)=>{if(!target)return;target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));};
  for(const event of ['keyboardWillShow','keyboardDidShow'])on(win,event,show);
  for(const event of ['keyboardWillHide','keyboardDidHide'])on(win,event,hide);
  on(win,'resize',schedule);on(win,'orientationchange',()=>{baseline=win.innerHeight;schedule();});
  on(viewport,'resize',schedule);on(viewport,'scroll',schedule);on(container,'focusin',schedule);on(container,'focusout',schedule);
  const observer=new win.MutationObserver(schedule);
  observer.observe(doc.body,{attributes:true,attributeFilter:['style','class']});
  observer.observe(doc.documentElement,{attributes:true,attributeFilter:['style','class']});
  update();
  return ()=>{disposed=true;win.cancelAnimationFrame(frame);observer.disconnect();listeners.forEach(dispose=>dispose());container.classList.remove('flomo-mobile-viewport','flomo-keyboard-open');};
}
module.exports={attachViewport};
