// Renders docs/*.md to static HTML under public/docs/, plus the .md twins, search index,
// llms.txt, llms-full.txt and sitemap.xml. Output carries the __ORIGIN__ token that the Worker
// fills with the deployment's public origin, so canonical URLs are right on any domain.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'docs');
const OUT = join(root, 'public', 'docs');
const LIVE = 'https://papertrade-alerts.ninabrekkerese.workers.dev';
const O = '__ORIGIN__';
const REPO = 'https://github.com/nirholas/papertrade-alerts';
const TODAY = new Date().toISOString().slice(0, 10);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => s.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const origin = (s) => s.split(LIVE).join(O);

function parse(file) {
  const raw = readFileSync(join(SRC, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  return { slug: file.replace(/\.md$/, ''), title: meta.title, description: meta.description, order: Number(meta.order), body: m[2].trim() + '\n' };
}

function inline(s, slugs) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const slug = slugs.has(href) ? `/docs/${href}` : href;
    const ext = /^https?:/.test(slug) && !slug.startsWith(LIVE);
    return `<a href="${slug}"${ext ? ' rel="noopener"' : ''}>${text}</a>`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function render(md, slugs) {
  const lines = md.split('\n');
  const html = [];
  const toc = [];
  const plain = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      const code = buf.join('\n');
      plain.push(code);
      html.push(`<div class="code"><button type="button" class="copy" aria-label="Copy code">Copy</button><pre><code${fence[1] ? ` class="lang-${fence[1]}"` : ''}>${esc(code)}</code></pre></div>`);
      continue;
    }
    const h = line.match(/^(#{1,3}) (.+)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].replace(/`/g, '');
      const id = slugify(text);
      if (level > 1) toc.push({ level, id, text });
      plain.push(text);
      html.push(`<h${level} id="${id}">${inline(h[2], slugs)}${level > 1 ? `<a class="anchor" href="#${id}" aria-label="Link to ${esc(text)}">#</a>` : ''}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      plain.push(buf.join(' '));
      html.push(`<blockquote><p>${inline(buf.join(' '), slugs)}</p></blockquote>`);
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      plain.push([head, ...body].map((r) => r.join(' ')).join(' '));
      html.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, slugs)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, slugs)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^(\d+\.|-) (.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) items.push(lines[i++].replace(/^(\d+\.|-) /, ''));
      plain.push(items.join(' '));
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t, slugs)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3} |>|\||(\d+\.|-) )/.test(lines[i])) buf.push(lines[i++]);
    plain.push(buf.join(' '));
    html.push(`<p>${inline(buf.join(' '), slugs)}</p>`);
  }
  return { html: html.join('\n'), toc, plain: plain.join(' ').replace(/\s+/g, ' ').trim() };
}

function layout(page, pages, rendered) {
  const idx = pages.findIndex((p) => p.slug === page.slug);
  const prev = pages[idx - 1];
  const next = pages[idx + 1];
  const href = (p) => (p.slug === 'index' ? '/docs/' : `/docs/${p.slug}`);
  const nav = pages.map((p) => `<a href="${href(p)}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('');
  const toc = rendered.toc.filter((t) => t.level === 2).map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('');
  const canonical = `${O}${href(page)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} - Papertrade Alerts docs</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${canonical}">
<link rel="alternate" type="text/markdown" href="${O}/docs/${page.slug}.md">
<meta property="og:title" content="${esc(page.title)} - Papertrade Alerts docs">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${canonical}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/docs/docs.css">
<script src="/docs/docs.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="disclaimer" role="note">Unofficial, not affiliated with Papertrade. High leverage can lose your whole margin. Alerts are best effort.</div>
<header class="top">
  <div class="bar">
    <button type="button" id="menu" class="ghost" aria-label="Toggle navigation" aria-expanded="false" aria-controls="side">Menu</button>
    <a class="brand" href="/docs/"><span class="dot" aria-hidden="true"></span>Papertrade Alerts <span class="mute">docs</span></a>
    <div class="grow"></div>
    <div class="searchbox"><input id="q" type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off" spellcheck="false"><div id="results" role="listbox" hidden></div></div>
    <a class="toplink" href="/">App</a>
    <a class="toplink" href="${REPO}" rel="noopener">GitHub</a>
    <button type="button" id="theme" class="ghost" aria-label="Toggle colour theme">Theme</button>
  </div>
</header>
<div class="layout">
  <nav id="side" class="side" aria-label="Documentation">${nav}</nav>
  <main id="main" class="doc">
${rendered.html}
<div class="pager">${prev ? `<a class="prev" href="${href(prev)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${href(next)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}</div>
<p class="mute foot">Raw markdown: <a href="/docs/${page.slug}.md">/docs/${page.slug}.md</a>. Apache-2.0. Unofficial, not affiliated with Papertrade.</p>
  </main>
  <aside class="toc" aria-label="On this page">${toc ? `<strong>On this page</strong>${toc}` : ''}</aside>
</div>
</body>
</html>
`;
}

const CSS = `:root{--bg:#f6f7f4;--panel:#fff;--ink:#14181a;--mute:#5a6468;--line:#dde2dd;--accent:#0b7a53;--accent-ink:#fff;--warn:#b25e00;--focus:#1a56db;--code:#eef1ee;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:root[data-theme=dark]{--bg:#0d1110;--panel:#151b19;--ink:#e8eeea;--mute:#98a59f;--line:#26302c;--accent:#3ddc97;--accent-ink:#04140d;--warn:#f0b040;--focus:#7aa7ff;--code:#101614}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d1110;--panel:#151b19;--ink:#e8eeea;--mute:#98a59f;--line:#26302c;--accent:#3ddc97;--accent-ink:#04140d;--warn:#f0b040;--focus:#7aa7ff;--code:#101614}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:120px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
a{color:var(--accent)}:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-999px;top:0;background:var(--panel);padding:8px 12px;z-index:30}.skip:focus{left:8px;top:8px}
.disclaimer{background:var(--warn);color:#161000;padding:6px 16px;font-size:13px;text-align:center}
.top{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:12px;min-height:56px;padding:0 16px;max-width:1280px;margin:0 auto}.grow{flex:1}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--ink);text-decoration:none;white-space:nowrap}.brand .mute{font-weight:500}
.dot{width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 25%,transparent)}
.toplink{color:var(--mute);text-decoration:none;padding:6px 8px;border-radius:6px}.toplink:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:6px 12px;min-height:36px;transition:background .15s,transform .05s}
button:hover{background:color-mix(in srgb,var(--ink) 7%,var(--panel))}button:active{transform:translateY(1px)}
button.ghost{background:transparent;border-color:transparent;color:var(--mute)}
#menu{display:none}
.searchbox{position:relative;width:min(260px,40vw)}
#q{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;min-height:36px}#q:hover{border-color:var(--mute)}
#results{position:absolute;right:0;top:42px;width:min(420px,92vw);max-height:60vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:4px}
#results a{display:block;padding:8px 10px;border-radius:6px;text-decoration:none;color:var(--ink)}#results a:hover,#results a:focus{background:color-mix(in srgb,var(--accent) 14%,transparent)}
#results small{display:block;color:var(--mute);font-size:13px;line-height:1.4}#results p{margin:8px 10px;color:var(--mute)}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr) 200px;gap:32px;max-width:1280px;margin:0 auto;padding:24px 16px 64px}
.side,.toc{position:sticky;top:88px;align-self:start;display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - 110px);overflow:auto;font-size:14px}
.side a,.toc a{color:var(--mute);text-decoration:none;padding:6px 10px;border-radius:6px}.side a:hover,.toc a:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}
.side a[aria-current=page]{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);font-weight:600}
.toc strong{padding:6px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.doc{min-width:0;max-width:78ch}
.doc h1{font-size:clamp(28px,5vw,38px);line-height:1.15;margin:0 0 16px;letter-spacing:-.02em}
.doc h2{font-size:22px;margin:40px 0 8px;padding-top:8px;border-top:1px solid var(--line)}.doc h3{font-size:17px;margin:28px 0 6px}
.anchor{margin-left:8px;color:var(--mute);text-decoration:none;opacity:0}h2:hover .anchor,h3:hover .anchor,.anchor:focus{opacity:1}
.doc code{font-family:var(--mono);font-size:.88em;background:var(--code);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.code{position:relative;margin:16px 0}.code pre{margin:0;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;line-height:1.5}
.code pre code{background:none;border:0;padding:0;font-size:13px;white-space:pre;overflow-wrap:normal}
.copy{position:absolute;top:8px;right:8px;min-height:28px;padding:2px 10px;font-size:12px;opacity:.85}
blockquote{margin:16px 0;padding:2px 16px;border-left:4px solid var(--warn);background:color-mix(in srgb,var(--warn) 10%,transparent);border-radius:0 8px 8px 0}
.tablewrap{overflow:auto;margin:16px 0;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:14px}
td code{white-space:nowrap}th,td{padding:8px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{background:var(--code);white-space:nowrap}tr:last-child td{border-bottom:0}
.pager{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:48px 0 16px}
.pager a{display:block;border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:12px 16px;text-decoration:none;color:var(--ink);font-weight:600}.pager a:hover{border-color:var(--accent)}
.pager span{display:block;font-size:12px;font-weight:500;color:var(--mute)}.pager .next{text-align:right}
.mute{color:var(--mute);font-size:13px}
@media(max-width:1020px){.layout{grid-template-columns:200px minmax(0,1fr)}.toc{display:none}}
@media(max-width:760px){.layout{grid-template-columns:minmax(0,1fr);padding-top:16px}#menu{display:inline-block}.toplink{display:none}.brand .mute{display:none}.searchbox{width:42vw}
.side{display:none;position:fixed;inset:var(--navtop,100px) 0 0 0;z-index:15;background:var(--bg);max-height:none;padding:12px 16px;font-size:16px}.side.open{display:flex}}
`;

const JS = `(()=>{
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
  const terms=q.value.toLowerCase().split(/\\s+/).filter(Boolean);
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
`;

const files = readdirSync(SRC).filter((f) => f.endsWith('.md'));
const pages = files.map(parse).sort((a, b) => a.order - b.order);
const slugs = new Set(pages.map((p) => p.slug));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const searchIndex = [];
let full = '';
for (const page of pages) {
  const body = origin(page.body);
  const rendered = render(body, slugs);
  writeFileSync(join(OUT, page.slug === 'index' ? 'index.html' : `${page.slug}.html`), layout(page, pages, rendered));
  writeFileSync(join(OUT, `${page.slug}.md`), body.replace(/\]\(([a-z-]+)\)/g, (m, s) => (slugs.has(s) ? `](${O}/docs/${s}.md)` : m)));
  searchIndex.push({ title: page.title, url: page.slug === 'index' ? '/docs/' : `/docs/${page.slug}`, text: rendered.plain });
  full += `\n\n<!-- ${O}/docs/${page.slug}.md -->\n${body.replace(/\]\(([a-z-]+)\)/g, (m, s) => (slugs.has(s) ? `](${O}/docs/${s}.md)` : m))}`;
}
writeFileSync(join(OUT, 'search-index.json'), JSON.stringify(searchIndex));
writeFileSync(join(OUT, 'docs.css'), CSS);
writeFileSync(join(OUT, 'docs.js'), JS);

const head = `# Papertrade Alerts

> Unofficial, self-hostable alerting service for Papertrade (papertrade.xyz) wallets on Cloudflare Workers + D1, with an MCP server for AI agents. Not affiliated with Papertrade. High leverage can lose your whole margin. Alerts are best effort. Nothing here signs, sends funds or places orders.
`;
const links = pages.map((p) => `- [${p.title}](${O}/docs/${p.slug}.md): ${p.description}`).join('\n');
writeFileSync(join(root, 'public', 'llms.txt'), `${head}
- MCP endpoint (Streamable HTTP, stateless): ${O}/mcp
- MCP server card: ${O}/.well-known/mcp/server-card.json
- Agent card: ${O}/.well-known/agent-card.json
- OpenAPI 3.1: ${O}/openapi.json
- Full documentation in one file: ${O}/llms-full.txt
- Source: ${REPO}
- Auth: POST /api/accounts (or the MCP create_subscription tool) returns a one-time bearer token (ptal_...). Send Authorization: Bearer <token>.

## Docs

${links}
`);
writeFileSync(join(root, 'public', 'llms-full.txt'), `${head}\nComplete documentation, one page after another.\n${full}\n`);

const urls = ['/', ...pages.map((p) => (p.slug === 'index' ? '/docs/' : `/docs/${p.slug}`)), '/llms.txt', '/llms-full.txt', '/openapi.json', '/.well-known/mcp/server-card.json', '/.well-known/agent-card.json'];
writeFileSync(join(root, 'public', 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${O}${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n')}\n</urlset>\n`);
console.log(`docs: ${pages.length} pages`);
