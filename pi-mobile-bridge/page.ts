export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pi on this PC</title><link rel="stylesheet" href="style.css"><script src="app.js" defer></script></head>
<body><header><div><strong>Pi on this PC</strong><small id="session"></small></div><span id="activity">Connecting…</span></header>
<main><nav id="sessions" aria-label="Running Pi terminals"></nav><section id="work"></section><section id="question" hidden></section><section id="timeline" aria-live="polite"></section></main>
<footer><textarea id="prompt" rows="2" placeholder="Message this Pi session"></textarea><div class="controls"><span id="notice"></span><button id="send">Send</button></div></footer>
<dialog id="pair"><form method="dialog"><h2>Connect to Pi</h2><p>Enter the token shown by <code>/phone-token</code> in any desktop Pi terminal.</p>
<input id="token" type="password" autocomplete="off" spellcheck="false"><button id="connect">Connect</button></form></dialog>
</body></html>`;

export const STYLE = `
:root{font:15px system-ui,sans-serif;color-scheme:dark;background:#11151b;color:#e2e8f0}
*{box-sizing:border-box}body{margin:0;display:flex;flex-direction:column;height:100dvh}
header,footer{padding:12px 16px;background:#1b2330}header{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #364152}
header small{display:block;color:#9aa9bc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65vw}
#activity{font-size:13px;color:#a7c4ea;white-space:nowrap}main{flex:1;overflow:auto;padding:10px 14px}
#work{display:grid;gap:5px;margin-bottom:5px}.workrow{font-size:13px;color:#b7c8da;padding:6px 8px;background:#202936;border-radius:6px}
#sessions{display:flex;gap:7px;overflow-x:auto;padding:3px 0 10px}#sessions button{background:#263343;white-space:nowrap;font-size:13px;padding:7px 10px}
#sessions button.selected{background:#376aab}#sessions button.attention{border:1px solid #d8a65b}
.workrow b{color:#e4efff}.workrow small{display:block;white-space:pre-wrap;color:#9aa9bc}
#timeline{display:grid;gap:12px;padding:14px 0 25px}.entry{border:1px solid #303d4d;border-radius:10px;padding:9px 11px;background:#18212b}
.entry.user{background:#20334a}.entry.tool{border-style:dashed}.entry.live{border-color:#5c8bbc}
.entry h3{font-size:12px;color:#92aac5;margin:0 0 7px;font-weight:600}
.entry pre{font:14px/1.45 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
#question{background:#41321e;border:1px solid #9c7136;border-radius:10px;padding:12px;margin-top:10px}
#question h2{font-size:17px;margin:0 0 8px}#question p{white-space:pre-wrap;margin:6px 0 12px}
.choice{display:block;margin:9px 0}.choice small{display:block;margin-left:24px;color:#c6b9a2}
input,textarea,button{font:inherit}textarea,input[type=text],input[type=password]{width:100%;background:#101822;color:#fff;border:1px solid #64748b;border-radius:7px;padding:9px}
button{background:#376aab;border:0;border-radius:7px;color:white;padding:9px 14px;cursor:pointer}button:disabled{opacity:.5}
.controls{display:flex;align-items:center;justify-content:space-between;margin-top:7px;gap:10px}
#notice{font-size:12px;color:#d0b786}#question button{margin:8px 8px 0 0}
dialog{background:#202936;color:#e2e8f0;border:1px solid #64748b;border-radius:12px;width:min(90vw,400px)}
dialog::backdrop{background:#000b}dialog h2{margin-top:0}
`;

export const APP_JS = `
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('pi-mobile-token')||'';
let currentAsk='',busy=false,currentInstance=sessionStorage.getItem('pi-mobile-instance')||'';
const main=document.querySelector('main');
const note=text=>{$('notice').textContent=text};
function pair(){if(!$('pair').open)$('pair').showModal()}
async function api(path,method='GET',body){
 const r=await fetch(path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 if(r.status===401){token='';sessionStorage.removeItem('pi-mobile-token');pair();throw Error('Enter the current token')}
 const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;
}
function row(kind,label,text){
 const el=document.createElement('article');el.className='entry '+kind;
 const title=document.createElement('h3');title.textContent=label;
 const body=document.createElement('pre');body.textContent=text;
 el.append(title,body);return el;
}
function renderAsk(ask){
 const area=$('question');if(!ask){area.hidden=true;area.replaceChildren();currentAsk='';return}
 if(currentAsk===ask.id)return;
 currentAsk=ask.id;area.hidden=false;area.replaceChildren();
 const title=document.createElement('h2');title.textContent=ask.question;area.append(title);
 if(ask.context){const p=document.createElement('p');p.textContent=ask.context;area.append(p)}
 const name='answer-'+ask.id,checks=[];
 for(const option of ask.options){
  const label=document.createElement('label');label.className='choice';
  const input=document.createElement('input');input.type=ask.allowMultiple?'checkbox':'radio';input.name=name;input.value=option.title;
  label.append(input,document.createTextNode(' '+option.title));
  if(option.description){const small=document.createElement('small');small.textContent=option.description;label.append(small)}
  area.append(label);checks.push(input);
 }
 const free=document.createElement('textarea');free.rows=2;free.placeholder=ask.options.length?'Or write another answer':'Your answer';
 if(ask.allowFreeform)area.append(free);
 const comment=document.createElement('input');comment.type='text';comment.placeholder='Optional comment';
 if(ask.allowComment&&ask.options.length)area.append(comment);
 const submit=document.createElement('button');submit.textContent='Answer';
 const cancel=document.createElement('button');cancel.textContent='Cancel';
 area.append(submit,cancel);
  const instance=currentInstance;
  const answer=async value=>{try{await api('api/answer?session='+encodeURIComponent(instance),'POST',{id:ask.id,answer:value});area.hidden=true;currentAsk='';note('Answer delivered')}catch(e){note(e.message)}};
 submit.onclick=()=>{
  const selected=checks.filter(x=>x.checked).map(x=>x.value),text=free.value.trim();
  if(selected.length)answer({kind:'selection',selections:selected,comment:comment.value.trim()||undefined});
  else if(text)answer({kind:'freeform',text});else note('Choose an option or enter an answer');
 };
 cancel.onclick=()=>answer(null);
}
async function refresh(){
 if(!token){pair();return}
 try{
   const sessions=(await api('api/sessions')).sessions;
   if(!sessions.some(item=>item.id===currentInstance)){
     currentInstance=sessions[0]?.id||'';currentAsk='';sessionStorage.setItem('pi-mobile-instance',currentInstance);
   }
   const tabs=$('sessions');tabs.replaceChildren();
   for(const item of sessions){
     const button=document.createElement('button');button.textContent=item.name+' · '+item.cwd.split(/[\\\\/]/).filter(Boolean).pop()+
       ' #'+item.id.slice(0,5)+' · '+item.state+(item.summary?' · '+item.summary:'');
     button.title=item.cwd;
     button.className=(item.id===currentInstance?'selected ':'')+(item.state==='needs-answer'?'attention':'');
     button.onclick=()=>{currentInstance=item.id;currentAsk='';sessionStorage.setItem('pi-mobile-instance',item.id);
       $('prompt').value='';renderAsk(null);refresh()};tabs.append(button);
   }
   if(!currentInstance){$('activity').textContent='No Pi terminals';$('session').textContent='Open Pi on the PC';
      $('timeline').replaceChildren();$('work').replaceChildren();renderAsk(null);return}
   const instance=currentInstance;
   const state=await api('api/state?session='+encodeURIComponent(instance));
   if(instance!==currentInstance)return;
   note('');
   $('session').textContent=state.name+' · '+state.cwd;
   $('activity').textContent=state.busy?'Working'+(state.tools.length?' · '+state.tools.join(', '):''):'Idle';
  const work=$('work');work.replaceChildren();
  for(const item of state.work){const div=document.createElement('div');div.className='workrow';
    const b=document.createElement('b');b.textContent=item.label+' · '+item.status;div.append(b);
    if(item.summary){const s=document.createElement('small');s.textContent=item.summary;div.append(s)}work.append(div)}
  renderAsk(state.ask);
  const nearBottom=main.scrollHeight-main.scrollTop-main.clientHeight<140;
  const list=$('timeline');list.replaceChildren();
  for(const item of state.messages)list.append(row(item.kind,item.label,item.text));
  if(state.live)list.append(row('live','Assistant · streaming',state.live));
  if(nearBottom)main.scrollTop=main.scrollHeight;
 }catch(e){note(e.message)}
}
$('connect').onclick=e=>{e.preventDefault();token=$('token').value.trim();if(!token)return;
 sessionStorage.setItem('pi-mobile-token',token);$('pair').close();refresh()};
$('send').onclick=async()=>{
 const text=$('prompt').value.trim();if(!text||busy||!currentInstance)return;busy=true;$('send').disabled=true;
 try{const result=await api('api/message?session='+encodeURIComponent(currentInstance),'POST',{text});$('prompt').value='';note(result.queued?'Queued after current work':'Sent');refresh()}
 catch(e){note(e.message)}finally{busy=false;$('send').disabled=false}
};
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('send').click()}});
if(!token)pair();else refresh();setInterval(refresh,1600);
`;
