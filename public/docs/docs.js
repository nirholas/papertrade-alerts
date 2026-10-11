(()=>{
const root=document.documentElement;
try{const t=localStorage.getItem('theme');if(t)root.dataset.theme=t}catch{}
document.getElementById('theme')?.addEventListener('click',()=>{
  const dark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
  const next=dark?'light':'dark';root.dataset.theme=next;try{localStorage.setItem('theme',next)}catch{}
});
const menu=document.getElementById('menu'),side=document.getElementById('side');
const place=()=>side.style.setProperty('--navtop',document.querySelector('.top').getBoundingClientRect().bottom+'px');
menu?.addEventListener('click',()=>{place();const open=side.classList.toggle('open');menu.setAttribute('aria-expanded',String(open))});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'){side.classList.remove('open');menu?.setAttribute('aria-expanded','false');hide()}
  if(e.key==='/'&&!/input|textarea/i.test(document.activeElement.tagName)){e.preventDefault();q.focus()}});
document.querySelectorAll('.copy').forEach((b)=>b.addEventListener('click',async()=>{
  const code=b.parentElement.querySelector('code').textContent;
  try{await navigator.clipboard.writeText(code);b.textContent='Copied'}catch{b.textContent='Press Ctrl+C'}
  setTimeout(()=>{b.textContent='Copy'},1600);
}));
const q=document.getElementById('q'),box=document.getElementById('results');let index=null,loading=null;
function hide(){box.hidden=true}
async function load(){
  if(index)return index;
  loading??=fetch('/docs/search-index.json').then((r)=>{if(!r.ok)throw new Error('http '+r.status);return r.json()}).then((j)=>(index=j));
  return loading;
}
function esc(s){return s.replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c])}
async function run(){
  const terms=q.value.toLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length){hide();return}
  let docs;try{docs=await load()}catch{box.innerHTML='<p>Search is unavailable right now. Reload and try again.</p>';box.hidden=false;return}
  const hits=docs.map((d)=>{
    const title=d.title.toLowerCase(),text=d.text.toLowerCase();let score=0;
    for(const t of terms){const inT=title.includes(t),inX=text.includes(t);if(!inT&&!inX)return null;score+=(inT?10:0)+(inX?1:0)}
    return {d,score,at:text.indexOf(terms[0])};
  }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,8);
  box.innerHTML=hits.length?hits.map(({d,at})=>{
    const s=Math.max(0,at-40),snip=at<0?d.text.slice(0,110):(s?'...':'')+d.text.slice(s,s+120)+'...';
    return '<a role="option" href="'+d.url+'">'+esc(d.title)+'<small>'+esc(snip)+'</small></a>';
  }).join(''):'<p>No pages match "'+esc(q.value)+'". Try a shorter word such as "token" or "webhook".</p>';
  box.hidden=false;
}
q.addEventListener('input',run);q.addEventListener('focus',()=>{load().catch(()=>{});if(q.value)run()});
document.addEventListener('click',(e)=>{if(!e.target.closest('.searchbox'))hide()});
})();
