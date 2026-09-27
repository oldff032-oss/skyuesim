const STYLE_ID='signal-pattern-style';

export function normalizeSignalPattern(value){
  const nodes=Array.isArray(value)?value.map(String):String(value||'').split(/[^0-9]+/).filter(Boolean);
  if(nodes.length<4||nodes.length>9||nodes.some(node=>!/^[0-8]$/.test(node))||new Set(nodes).size!==nodes.length)return null;
  return nodes.join('-');
}

function installStyles(){
  if(document.getElementById(STYLE_ID))return;
  const style=document.createElement('style');
  style.id=STYLE_ID;
  style.textContent=`
    .signal-pattern{position:relative;width:min(100%,310px);aspect-ratio:1;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:24px;box-sizing:border-box;touch-action:none;user-select:none}
    .signal-pattern::before{content:"";position:absolute;inset:9%;border-radius:34px;background:radial-gradient(circle at 50% 45%,rgba(37,215,255,.09),transparent 67%);border:1px solid rgba(106,135,255,.14)}
    .signal-pattern-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
    .signal-pattern-lines polyline{fill:none;stroke:url(#signal-pattern-gradient);stroke-width:4.5;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 8px rgba(49,218,255,.62))}
    .signal-pattern-node{position:relative;z-index:2;display:grid;place-items:center;align-self:center;justify-self:center;width:58px;height:58px;border:0;background:transparent;cursor:pointer;padding:0;touch-action:none}
    .signal-pattern-node::before{content:"";width:17px;height:17px;border:2px solid #7587a8;border-radius:50%;background:#0b1022;box-shadow:0 0 0 8px rgba(78,101,155,.08);transition:.16s ease}
    .signal-pattern-node.active::before{width:22px;height:22px;border-color:#55e8ff;background:linear-gradient(135deg,#23d9ff,#7164ff);box-shadow:0 0 0 9px rgba(46,210,255,.12),0 0 26px rgba(45,210,255,.72)}
    .signal-pattern.disabled{opacity:.48;pointer-events:none}
    @media(max-width:390px){.signal-pattern{width:min(100%,280px);padding:20px}.signal-pattern-node{width:52px;height:52px}}
    @media(prefers-reduced-motion:reduce){.signal-pattern-node::before{transition:none}}
  `;
  document.head.appendChild(style);
}

export function mountSignalPattern(container,{onComplete=()=>{},label='Графічний ключ'}={}){
  if(!container)throw new Error('Pattern container is required');
  installStyles();
  container.innerHTML=`<div class="signal-pattern" role="group" aria-label="${label}"><svg class="signal-pattern-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="signal-pattern-gradient" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#25dcff"/><stop offset="1" stop-color="#7961ff"/></linearGradient></defs><polyline points=""/></svg>${Array.from({length:9},(_,index)=>`<button class="signal-pattern-node" type="button" data-node="${index}" aria-label="Точка ${index+1}"></button>`).join('')}</div>`;
  const root=container.querySelector('.signal-pattern'),line=root.querySelector('polyline'),nodes=[...root.querySelectorAll('.signal-pattern-node')];
  let path=[],drawing=false,disabled=false,keyboardTimer=null;
  const pointFor=node=>{const rootRect=root.getBoundingClientRect(),rect=node.getBoundingClientRect();return [((rect.left+rect.width/2-rootRect.left)/rootRect.width)*100,((rect.top+rect.height/2-rootRect.top)/rootRect.height)*100];};
  const draw=()=>{nodes.forEach((node,index)=>node.classList.toggle('active',path.includes(String(index))));line.setAttribute('points',path.map(index=>pointFor(nodes[Number(index)]).join(',')).join(' '));};
  const add=node=>{const index=node?.dataset?.node;if(index===undefined||path.includes(index))return;path.push(index);draw();};
  const complete=()=>{if(!path.length)return;const value=normalizeSignalPattern(path);onComplete(value,[...path]);};
  const reset=()=>{path=[];drawing=false;clearTimeout(keyboardTimer);draw();};
  root.addEventListener('pointerdown',event=>{if(disabled)return;const node=event.target.closest('.signal-pattern-node');if(!node)return;event.preventDefault();reset();drawing=true;root.setPointerCapture?.(event.pointerId);add(node);});
  root.addEventListener('pointermove',event=>{if(!drawing||disabled)return;const node=document.elementFromPoint(event.clientX,event.clientY)?.closest?.('.signal-pattern-node');if(node&&root.contains(node))add(node);});
  const finish=event=>{if(!drawing)return;event.preventDefault();drawing=false;complete();};
  root.addEventListener('pointerup',finish);root.addEventListener('pointercancel',finish);
  nodes.forEach(node=>node.addEventListener('click',event=>{if(event.detail!==0||disabled)return;add(node);clearTimeout(keyboardTimer);keyboardTimer=setTimeout(complete,500);}));
  const resize=()=>draw();window.addEventListener('resize',resize,{passive:true});
  return {reset,getValue:()=>normalizeSignalPattern(path),setDisabled(value){disabled=Boolean(value);root.classList.toggle('disabled',disabled);},destroy(){window.removeEventListener('resize',resize);container.innerHTML='';}};
}
