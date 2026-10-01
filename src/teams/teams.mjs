import { openSetStore } from '../storage/indexeddb.mjs';
import { replaySet } from '../engine/set-engine.mjs';
import { validateLineup, lineupIssue, startingRotation, lineupFromSet } from './lineup-model.mjs';
import { mountLineupEditor } from './lineup-editor.mjs';
import { teamHierarchy, setPlan } from './match-model.mjs';
import { POSITIONS, validateTeam, makeMatchSet } from './team-model.mjs';
import { registerApp } from '../app/pwa.mjs';
import { COLOR_THEMES, colorTheme, loadSettings, saveSettings, applyColorTheme } from '../app/themes.mjs';
import { createPractice } from '../practice/practice-model.mjs';
import { buildTeamStats } from './stats-model.mjs';
registerApp();
const $=id=>document.getElementById(id);
applyColorTheme(loadSettings().theme);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let store,teams=[],sets=[],practices=[],active=null,busy=false,dirty=false;
function themePreviewMarkup(theme){
 return `<span class="theme-preview" style="--preview-court:${theme.court};--preview-court-2:${theme.court2};--preview-accent:${theme.accent};--preview-set:${theme.set};--preview-oh:${theme.oh};--preview-mid:${theme.mid};--preview-win:${theme.win};--preview-lose:${theme.lose}"><span class="theme-preview-roles"><i class="set"></i><i class="oh"></i><i class="mid"></i></span><span class="theme-preview-results"><i class="win"></i><i class="lose"></i><b></b></span></span>`;
}
function themeOptionMarkup(theme, selected, attribute='data-theme-choice'){
 return `<button type="button" class="theme-option" ${attribute}="${theme.id}" aria-pressed="${selected===theme.id}">
  ${themePreviewMarkup(theme)}
  <span class="theme-copy"><strong>${esc(theme.name)}</strong><small>${esc(theme.description)}</small></span></button>`;
}
function renderThemeOptions(){
 const selected=colorTheme(loadSettings().theme).id;
 $('themeOptions').innerHTML=COLOR_THEMES.map(t=>themeOptionMarkup(t,selected)).join('');
 $('themeOptions').querySelectorAll('[data-theme-choice]').forEach(button=>button.onclick=()=>{
  const settings=loadSettings();settings.theme=button.dataset.themeChoice;const saved=saveSettings(settings);applyColorTheme(settings.theme);renderThemeOptions();
  const name=colorTheme(settings.theme).name;$('themeTitle').textContent=`App theme · ${name}`;themeButton.textContent=`Theme · ${name}`;themeButton.setAttribute('aria-label',`App theme: ${name}`);notice(saved?`${name} theme applied.`:`${name} theme applied for this page, but could not be saved on this device.`);
 });
 const name=colorTheme(selected).name;themeButton.textContent=`Theme · ${name}`;themeButton.setAttribute('aria-label',`App theme: ${name}`);
}
const themeButton=$('themeButton'),themeDialog=$('themeDialog'),themeDone=$('themeDone');
if(themeButton&&themeDialog)themeButton.onclick=()=>{$('themeTitle').textContent='App theme';renderThemeOptions();themeDialog.showModal();};
if(themeDone&&themeDialog)themeDone.onclick=()=>themeDialog.close();
if(themeDialog)themeDialog.onclick=e=>{if(e.target===themeDialog)themeDialog.close();};
renderThemeOptions();
const identity=()=>crypto.randomUUID();
const expected=()=>active?{id:active.config.id,revision:active.actions.length}:null;
function notice(message='',error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
async function save(work){
 if(busy)return;busy=true;document.body.classList.add('busy');
 const disabled=[...document.querySelectorAll('button,input,select')].map(el=>[el,el.disabled]);disabled.forEach(([el])=>el.disabled=true);
 try{await work();}catch(e){notice(e.message,true);$('notice').scrollIntoView({block:'nearest'});}
 finally{busy=false;document.body.classList.remove('busy');disabled.forEach(([el,value])=>el.disabled=value);}
}
async function withFreshStore(work){
 try{return await work();}
 catch(error){
  if(error?.name!=='InvalidStateError'||!/database connection is closing/i.test(error.message))throw error;
  store?.close();
  store=await openSetStore();
  return work();
 }
}
const plural=(n,word)=>`${n} ${word}${n===1?'':word.endsWith('ch')?'es':'s'}`;
const LOGO_LIMIT=512*1024;
function logoMarkup(logo,name,className='team-logo'){
 return logo?`<img class="${className}" src="${esc(logo)}" alt="${esc(name)} logo">`:'';
}
function fileDataUrl(blob){
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('The logo file could not be read.'));reader.readAsDataURL(blob);});
}
function cleanSvg(source){
 if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('This SVG includes a document type that cannot be used as a logo.');
 const parsed=new DOMParser().parseFromString(source,'image/svg+xml');
 if(parsed.querySelector('parsererror')||parsed.documentElement?.localName?.toLowerCase()!=='svg')throw new Error('Choose a valid SVG logo.');
 const namespace='http://www.w3.org/2000/svg';
 const allowedTags=new Set(['svg','g','path','circle','rect','ellipse','line','polyline','polygon','defs','lineargradient','radialgradient','stop','clippath','mask','use','title','desc','text','tspan']);
 const allowedAttrs=new Map(Object.entries({
  id:'id',x:'x',y:'y',x1:'x1',y1:'y1',x2:'x2',y2:'y2',cx:'cx',cy:'cy',r:'r',rx:'rx',ry:'ry',width:'width',height:'height',viewbox:'viewBox',preserveaspectratio:'preserveAspectRatio',
  d:'d',points:'points',transform:'transform',fill:'fill',fillrule:'fill-rule',fillopacity:'fill-opacity',stroke:'stroke',strokewidth:'stroke-width',strokelinecap:'stroke-linecap',strokelinejoin:'stroke-linejoin',strokedasharray:'stroke-dasharray',strokedashoffset:'stroke-dashoffset',strokeopacity:'stroke-opacity',opacity:'opacity',offset:'offset',stopcolor:'stop-color',stopopacity:'stop-opacity',gradientunits:'gradientUnits',gradienttransform:'gradientTransform',cliprule:'clip-rule',clippathunits:'clipPathUnits',maskunits:'maskUnits',maskcontentunits:'maskContentUnits','clip-path':'clip-path',mask:'mask',href:'href',fontfamily:'font-family',fontsize:'font-size',fontweight:'font-weight',textanchor:'text-anchor'
 }));
 const out=document.implementation.createDocument(namespace,'svg',null),root=out.documentElement;
 const textTags=new Set(['title','desc','text','tspan']);
 function copyAttrs(node,element){
  for(const attr of node.attributes){
   const key=attr.localName.toLowerCase(),name=allowedAttrs.get(key);if(!name||key==='xmlns')continue;
   const value=attr.value.trim();if(!value||value.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(value))continue;
   if(key==='id'&&!/^[A-Za-z_][\w.-]*$/.test(value))continue;
   if(key==='href'&&!/^#[A-Za-z_][\w.-]*$/.test(value))continue;
   if(/url\s*\(/i.test(value)&&!(['fill','stroke','clip-path','mask'].includes(name)&&/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)))continue;
   if(/(?:javascript:|data:|https?:|@import)/i.test(value))continue;
   element.setAttribute(name,value);
  }
 }
 function copy(node,parent){
  if(node.nodeType===Node.TEXT_NODE){if(textTags.has(parent.localName))parent.append(out.createTextNode(node.nodeValue));return;}
  if(node.nodeType!==Node.ELEMENT_NODE||!allowedTags.has(node.localName.toLowerCase()))return;
  const element=out.createElementNS(namespace,node.localName);
  copyAttrs(node,element);
  parent.append(element);for(const child of node.childNodes)copy(child,element);
 }
 copyAttrs(parsed.documentElement,root);
 for(const child of parsed.documentElement.childNodes)copy(child,root);
 return new XMLSerializer().serializeToString(root);
}
async function readTeamLogo(file){
 if(file.size>LOGO_LIMIT)throw new Error('Team logos must be 512 KB or smaller.');
 const bytes=new Uint8Array(await file.arrayBuffer());
 const png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
 const jpg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(png)return fileDataUrl(new Blob([bytes],{type:'image/png'}));
 if(jpg)return fileDataUrl(new Blob([bytes],{type:'image/jpeg'}));
 const source=new TextDecoder().decode(bytes).replace(/^\uFEFF/,'').trim();
 if(!/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(source))throw new Error('Choose an SVG, PNG, or JPG image.');
 const safe=cleanSvg(source);
 const cleaned=new Blob([safe],{type:'image/svg+xml'});
 if(cleaned.size>LOGO_LIMIT)throw new Error('This SVG is too large after removing unsupported content. Choose a smaller logo.');
 return fileDataUrl(cleaned);
}
function remove(message,request,after){
 if(!confirm(message+'\n\nThis cannot be undone.'))return;
 save(async()=>{await store.deleteData(request);await load();after();});
}
function deleteTeam(team){
 const setCount=team.matches.reduce((n,m)=>n+m.sets.length,0),practiceCount=practices.filter(p=>p.teamId===team.id).length,revision=teams.find(t=>t.id===team.id)?.revision??null;
 remove(`Delete ${team.name}${team.editable?', its roster and saved lineups':''}, ${plural(team.matches.length,'match')} (${plural(setCount,'set')}), and ${plural(practiceCount,'practice')}?`,
  {teamId:team.id,teamRevision:revision},()=>{go();notice(`${team.name} deleted.`);});
}
function deleteMatch(team,match){
 remove(`Delete the match vs ${match.opponent}${match.date?' on '+match.date:''}${match.sets.length?` and its ${plural(match.sets.length,'set')}`:''}?`,
  {teamId:team.id,matchId:match.id},()=>{go(team.id);notice(`Match vs ${match.opponent} deleted.`);});
}
async function load(){
 [teams,sets,practices,active]=await Promise.all([store.listTeams(),store.listSets(),store.listPractices(),store.loadActive()]);
 teams.sort((a,b)=>a.name.localeCompare(b.name));$('liveLink').hidden=!active;
}
function route(teamId,matchId,view){
 const params=new URLSearchParams();if(teamId)params.set('team',teamId);if(matchId)params.set('match',matchId);if(view)params.set('view',view);
 return params.toString();
}
function go(teamId,matchId,view){
 const hash=route(teamId,matchId,view);if(location.hash.slice(1)===hash)home();else location.hash=hash;
}
// Top bar: a touch-sized Back button replaces breadcrumb links.
let backAction=null;
function bar(title,context='',back=null){
 $('pageTitle').textContent=title;$('pageContext').textContent=context||'Volleyball';document.title=`${title} · Volleyball`;
 backAction=back?.action??null;$('backButton').hidden=!back;$('backLabel').textContent=back?.label??'';
 window.scrollTo(0,0);
}
const leave=()=>!dirty||confirm('Discard your unsaved changes?');
$('backButton').onclick=()=>{if(!leave())return;dirty=false;notice();backAction?.();};
$('liveLink').onclick=()=>{if(!leave())return;dirty=false;location.href='./index.html';};
const item=(color,main,actions,extra='')=>`<article class="card item ${extra}" style="--team-color:${color}"><div class="item-main">${main}</div><div class="item-actions">${actions}</div></article>`;
function statTable(rows){
 if(!rows.length)return '<div class="stats-empty">No serving or passing results recorded.</div>';
 return `<div class="stats-table-scroll"><table class="stats-table"><thead><tr><th>Player</th><th>Pass avg</th><th>Serve In %</th><th>Ace %</th></tr></thead><tbody>${rows.map(({player,stats})=>{
  const passes=stats.passing.count?`${(stats.passing.sum/stats.passing.count).toFixed(2)} <small>n=${stats.passing.count}</small>`:'—';
  const attempts=stats.serving.attempts, aceIn=stats.serving.aces;
  const serves=`${attempts?`${Math.round(stats.serving.in*100/attempts)}%`:'—'} <small>n=${attempts}</small>`;
  const acePercent=`${attempts?`${Math.round(aceIn*100/attempts)}%`:'—'} <small>n=${attempts}</small>`;
  return `<tr><th scope="row">#${esc(player.jersey)} ${esc(player.name)}</th><td>${passes}</td><td>${serves}</td><td>${acePercent}</td></tr>`;
 }).join('')}</tbody></table></div>`;
}
function teamStatsPage(team){
 const stats=buildTeamStats(team,practices);
 const totalRows=stats.players.map(row=>({player:row.player,stats:row.total}));
 $('content').innerHTML=`<section class="season-stats-summary card" style="--team-color:${team.color}">
   <div><h2>${esc(team.name)} · ${esc(team.season||'Season stats')}</h2><p>${plural(stats.counts.practices,'practice')} · ${plural(stats.counts.matches,'match')} · ${plural(stats.counts.sets,'set')} · ${plural(stats.counts.practiceResults,'practice result')}</p></div>
   <p class="muted">Totals combine all saved practices and match sets linked to this team. Practice results are tapped individually; match serve attempts come from completed rallies. Serve In % includes aces; Ace % shows aces as a share of attempts.</p>
  </section>
  <h2 class="list-title">Season totals · all saved results</h2>
  ${statTable(totalRows)}
  <h2 class="list-title">Matches and sets</h2>
  <div class="stats-breakdowns">${stats.matches.length?stats.matches.map(match=>{
   const result=match.winner?(match.winner==='us'?'Won':'Lost'):match.inProgress?'In progress':match.sets.length?'Complete':'Not started';
   return `<details class="stats-group"><summary><strong>vs ${esc(match.opponent||'Opponent')}</strong><span>${esc(match.date||'Date not recorded')} · ${esc(result)}${match.sets.length?` · Sets ${match.wins.us}–${match.wins.them}`:''}</span></summary>
    ${match.sets.length?`<section class="stats-match-total"><h3>Match totals</h3>${statTable(match.rows)}</section>
     <div class="stats-set-list">${match.sets.map(set=>`<details class="stats-set"><summary>Set ${set.number} · ${set.score.us}–${set.score.them} · ${set.status==='ended'?'Finished':'In progress'}</summary>${statTable(set.rows)}</details>`).join('')}</div>`:'<p class="stats-empty">No set results recorded yet.</p>'}
   </details>`;
  }).join(''):'<div class="stats-empty">No matches recorded for this team.</div>'}</div>
  <h2 class="list-title">Practices</h2>
  <div class="stats-breakdowns">${stats.practices.length?stats.practices.map(practice=>`<details class="stats-group stats-practice"><summary><strong>Practice · ${esc(practice.date)}</strong><span>${plural(practice.resultCount,'result')} · ${new Date(practice.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</span></summary>${statTable(practice.rows)}</details>`).join(''):'<div class="stats-empty">No practices recorded for this team.</div>'}</div>`;
}
function home(){
 dirty=false;
 const hierarchy=teamHierarchy(teams,sets),params=new URLSearchParams(location.hash.slice(1));
 const team=hierarchy.find(t=>t.id===params.get('team'));
 const match=team?.matches.find(m=>m.id===params.get('match'));
 if(team&&!match&&params.get('view')==='stats'){bar('Season stats',team.name,{label:team.name,action:()=>go(team.id)});teamStatsPage(team);return;}
 if(team?.editable&&params.get('view')==='lineups'){bar('Lineups',team.name,{label:team.name,action:()=>go(team.id)});lineupLibrary(teams.find(t=>t.id===team.id));return;}
 if(!team){
  bar('Teams');
  $('content').innerHTML=`<div class="toolbar"><button id="createTeam" class="primary">Create team</button></div>
   <div class="list">${hierarchy.length?hierarchy.map(t=>item(t.color,`<div class="team-card-heading">${logoMarkup(t.logo,t.name)}<div><h3>${esc(t.name)}</h3><p>${t.editable?`${esc(t.level)} · ${esc(t.season)} · ${plural(t.players.length,'player')}`:'Saved team'} · ${plural(t.matches.length,'match')}</p></div></div>`,
    `<button data-team="${esc(t.id)}" class="primary">Open team</button><button data-delete-team="${esc(t.id)}" class="danger">Delete team</button>`)).join(''):'<div class="card"><h3>Add your first team</h3><p>Create a roster, then start a match. Each match keeps its sets together.</p></div>'}</div>`;
  $('createTeam').onclick=()=>editTeam();
  document.querySelectorAll('[data-team]').forEach(b=>b.onclick=()=>go(b.dataset.team));
  document.querySelectorAll('[data-delete-team]').forEach(b=>b.onclick=()=>deleteTeam(hierarchy.find(t=>t.id===b.dataset.deleteTeam)));return;
 }
 if(!match){
  bar(team.name,team.editable?`${team.level} · ${team.season}`:'Saved team',{label:'Teams',action:()=>go()});
  const teamPractices=practices.filter(p=>p.teamId===team.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $('content').innerHTML=`${team.logo?`<div class="team-brand" style="--team-color:${team.color}">${logoMarkup(team.logo,team.name)}<div><strong>${esc(team.name)}</strong><span>${esc(colorTheme(team.teamTheme).name)} theme</span></div></div>`:''}<div class="toolbar">${team.editable?`<button data-start="${esc(team.id)}" class="primary" ${team.players.length<6?'disabled':''}>New match</button><button id="startPractice" class="primary" ${team.players.length?'':'disabled'}>New practice</button><button id="teamLineups">Lineups</button><button data-edit="${esc(team.id)}">Edit roster</button>`:''}<button id="teamStats">View stats</button><button id="deleteTeam" class="danger">Delete team</button></div>
   ${team.editable&&team.players.length<6?'<p class="muted">Add at least six players to start a match.</p>':''}
   <h2 class="list-title">Matches</h2>
   <div class="list">${team.matches.length?team.matches.map(m=>item(team.color,`<h3>${esc(m.opponent)}</h3><p>${esc(m.date)||'Date not recorded'} · ${m.sets.length?`${plural(m.sets.length,'set')} · Sets ${m.wins.us}–${m.wins.them}`:'Not started'}</p><p class="muted">${!m.sets.length?'Saved match':m.winner?(m.winner==='us'?'Match won':'Match lost'):m.inProgress?'Set in progress':'All recorded sets finished'}${m.bestOf?` · Best of ${m.bestOf}`:''}</p>`,
    `<button data-match="${esc(m.id)}" class="primary">Open match</button><button data-delete-match="${esc(m.id)}" class="danger">Delete match</button>`)).join(''):'<div class="card"><p>No matches yet. Choose New match to set up the opponent and first set.</p></div>'}</div>
   <h2 class="list-title">Practices</h2>
   <div class="list">${teamPractices.length?teamPractices.map(p=>item(team.color,`<h3>Practice · ${esc(p.date)}</h3><p>${plural(p.events.length,'recorded result')} · ${new Date(p.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</p>`,
    `<button data-practice="${esc(p.id)}" class="primary">Open practice</button><button data-delete-practice="${esc(p.id)}" class="danger">Delete practice</button>`,'practice-card')).join(''):'<div class="card"><p>No practices recorded yet. Start a practice to track serves and serve receive for this roster.</p></div>'}</div>`;
  $('teamLineups')?.addEventListener('click',()=>go(team.id,null,'lineups'));
  $('teamStats').onclick=()=>go(team.id,null,'stats');
  document.querySelector('[data-start]')?.addEventListener('click',()=>matchSetup(team));
  $('startPractice')?.addEventListener('click',()=>save(async()=>{
   const practice=createPractice(teams.find(t=>t.id===team.id),identity());
   await withFreshStore(()=>store.createPractice(practice));
   busy=false;
   location.href=`./practice.html?id=${encodeURIComponent(practice.id)}`;
  }));
  document.querySelector('[data-edit]')?.addEventListener('click',()=>editTeam(teams.find(t=>t.id===team.id)));
  document.querySelectorAll('[data-match]').forEach(b=>b.onclick=()=>go(team.id,b.dataset.match));
  $('deleteTeam').onclick=()=>deleteTeam(team);
  document.querySelectorAll('[data-delete-match]').forEach(b=>b.onclick=()=>deleteMatch(team,team.matches.find(m=>m.id===b.dataset.deleteMatch)));
  document.querySelectorAll('[data-practice]').forEach(b=>b.onclick=()=>{location.href=`./practice.html?id=${encodeURIComponent(b.dataset.practice)}`;});
  document.querySelectorAll('[data-delete-practice]').forEach(b=>b.onclick=()=>{
   const practice=teamPractices.find(p=>p.id===b.dataset.deletePractice);
   remove(`Delete the ${practice.date} practice and its ${plural(practice.events.length,'result')}?`,
    {teamId:team.id,practiceId:practice.id,practiceRevision:practice.revision},()=>{home();notice('Practice deleted.');});
  });
  return;
 }
 const next=match.sets.length+1;
 bar(match.opponent,[team.name,match.date].filter(Boolean).join(' · '),{label:team.name,action:()=>go(team.id)});
 $('content').innerHTML=`<div class="card match-summary" style="--team-color:${team.color}"><p class="set-score">Sets ${match.wins.us}–${match.wins.them}</p><p>${match.winner?`<strong class="match-result">${match.winner==='us'?'Match won':'Match lost'}</strong> · `:''}${match.bestOf?`Best of ${match.bestOf}`:'Match format not set'}</p></div>
  <div class="toolbar">${!match.winner&&team.editable?`<button id="nextSet" class="primary" ${match.inProgress||team.players.length<6?'disabled':''}>${match.sets.length?`Start set ${next}`:'Set up set 1'}</button>`:''}<button id="deleteMatch" class="danger">Delete match</button></div>
  ${match.inProgress?'<p class="muted">Finish the set in progress before starting another set in this match.</p>':''}
  ${match.sets.length?'<h2 class="list-title">Sets</h2>':''}
  <div class="list">${match.sets.map((r,i)=>{const state=replaySet(r),n=r.config.setNumber??i+1;return item(team.color,`<h3>Set ${n}</h3><p class="set-score">${state.score.us}–${state.score.them}</p><p>${state.status==='ended'?'Finished':'In progress'} · to ${r.config.rules.target}</p>`,
   `<button data-resume="${esc(r.config.id)}" class="primary">${state.status==='ended'?'Open set':'Resume set'}</button>${i===match.sets.length-1?`<button data-delete-set="${esc(r.config.id)}" class="danger">Delete set</button>`:''}`,'set-card');}).join('')}</div>
  ${match.sets.length?'':`<div class="card"><p>Not started · ${esc(match.date)} · Best of ${match.bestOf}. Choose Set up set 1 to change the details or pick the lineup and first serve.</p></div>`}
  ${match.sets.length>1?'<p class="muted">Only the latest set can be deleted, so set numbers and first serve stay in order.</p>':''}`;
 $('deleteMatch').onclick=()=>deleteMatch(team,match);
 document.querySelector('[data-delete-set]')?.addEventListener('click',()=>remove(`Delete set ${match.sets.length} vs ${match.opponent} and all of its rallies?`,
  {teamId:team.id,setId:match.sets.at(-1).config.id},()=>{if(match.sets.length>1)home();else go(team.id);notice(`Set ${match.sets.length} deleted.`);}));
 $('nextSet')?.addEventListener('click',()=>matchSetup(team,match));
 document.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>save(async()=>{await store.activateSet(b.dataset.resume,expected());busy=false;location.href='./index.html';}));
}
window.addEventListener('hashchange',()=>{notice();home();});
function editTeam(team){
 const defaultTheme=colorTheme(loadSettings().theme).id;
 const draft=team?structuredClone(team):{id:identity(),schemaVersion:1,revision:0,name:'',level:'Jr High',season:String(new Date().getFullYear()),teamTheme:defaultTheme,color:colorTheme(defaultTheme).accent,logo:null,players:[]};
 notice();bar(team?'Edit roster':'Create team',team?.name??'',{label:team?team.name:'Teams',action:home});
 $('content').innerHTML=`<form id="teamForm"><p class="help">Save your roster here. Choose starters, setters, and liberos for each match.</p><div class="grid"><label>Team name<input id="teamName" required maxlength="100" value="${esc(draft.name)}" autocomplete="organization"></label><label>Level<select id="level">${['Jr High','JV','Varsity','Club','Other'].map(v=>`<option ${v===draft.level?'selected':''}>${v}</option>`).join('')}</select></label><label>Season / year<input id="season" required maxlength="100" value="${esc(draft.season)}"></label><div class="team-theme-field"><label for="teamTheme">Team theme<select id="teamTheme">${COLOR_THEMES.map(t=>`<option value="${t.id}" ${draft.teamTheme===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label><div id="teamThemePreview" class="team-theme-preview" aria-live="polite"></div><p class="muted">Choose a palette for this team and its live sets.</p></div></div><div class="team-logo-field"><div><h2>Team logo</h2><p class="muted">Upload an SVG, PNG, or JPG image up to 512 KB.</p></div><div class="team-logo-preview" id="teamLogoPreview">${draft.logo?logoMarkup(draft.logo,draft.name||'Team','team-logo-large'):'<span>No logo selected</span>'}</div><label class="upload-label">Choose logo<input id="teamLogoFile" type="file" accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg"></label><button type="button" id="removeTeamLogo" class="danger" ${draft.logo?'':'hidden'}>Remove logo</button></div><div class="section-head"><h2>Players</h2><button type="button" id="addPlayer">Add player</button></div><p class="muted">Jersey numbers 0–99 must be unique within this team.</p><div id="players"></div><div class="actions form-actions"><button type="submit" class="primary">Save team</button><button type="button" id="cancel">Cancel</button></div></form>`;
 function renderTeamThemePreview(){
  const theme=colorTheme(draft.teamTheme);
  $('teamTheme').value=theme.id;
  $('teamThemePreview').innerHTML=`${themePreviewMarkup(theme)}<span class="theme-copy"><strong>${esc(theme.name)}</strong><small>${esc(theme.description)}</small></span>`;
 }
 function renderTeamLogo(){
  $('teamLogoPreview').innerHTML=draft.logo?logoMarkup(draft.logo,draft.name||'Team','team-logo-large'):'<span>No logo selected</span>';
  $('removeTeamLogo').hidden=!draft.logo;
 }
 renderTeamThemePreview();
 function addPlayer(p={id:identity(),athleteId:identity(),name:'',jersey:'',position:'OH'},focus=false){
  const row=document.createElement('div');row.className='roster-row';row.dataset.id=p.id;row.dataset.athlete=p.athleteId;
  row.innerHTML=`<label>Player name<input class="player-name" required maxlength="100" value="${esc(p.name)}" autocomplete="off"></label><label>Jersey #<input class="jersey" required inputmode="numeric" pattern="[0-9]{1,2}" maxlength="2" value="${esc(p.jersey)}"></label><label>Position<select class="position">${POSITIONS.map(v=>`<option ${v===p.position?'selected':''}>${v}</option>`).join('')}</select></label><button type="button" class="danger" aria-label="Remove player">Remove</button>`;
  row.querySelector('button').onclick=()=>{row.remove();dirty=true;};$('players').append(row);if(focus)row.querySelector('input').focus();
 }
 if(draft.players.length)draft.players.forEach(p=>addPlayer(p));else addPlayer();
 $('addPlayer').onclick=()=>{addPlayer(undefined,true);dirty=true;};
 $('teamForm').oninput=()=>{dirty=true;};
 $('teamTheme').onchange=()=>{draft.teamTheme=$('teamTheme').value;draft.color=colorTheme(draft.teamTheme).accent;dirty=true;renderTeamThemePreview();};
 $('teamName').addEventListener('input',()=>{if(draft.logo)renderTeamLogo();});
 $('teamLogoFile').onchange=async()=>{
  const file=$('teamLogoFile').files?.[0];if(!file)return;
  try{draft.logo=await readTeamLogo(file);dirty=true;renderTeamLogo();notice('Logo added. Save the team to keep it.');}
  catch(error){notice(error.message,true);}
  finally{$('teamLogoFile').value='';}
 };
 $('removeTeamLogo').onclick=()=>{draft.logo=null;dirty=true;renderTeamLogo();};
 $('cancel').onclick=()=>{if(!dirty||confirm('Discard these unsaved roster changes?')){notice();home();}};
 $('teamForm').onsubmit=e=>{e.preventDefault();
  const input={...draft,revision:draft.revision+1,name:$('teamName').value,level:$('level').value,season:$('season').value,color:colorTheme(draft.teamTheme).accent,
   players:[...$('players').children].map(row=>({id:row.dataset.id,athleteId:row.dataset.athlete,name:row.querySelector('.player-name').value,jersey:row.querySelector('.jersey').value,position:row.querySelector('.position').value}))};
  save(async()=>{const valid=validateTeam(input);await store.saveTeam(valid,team?.revision??null);dirty=false;await load();go(valid.id);notice(`${valid.name} saved.`);});
 };
 $('teamName').focus();
}
function lineupLibrary(team){
 $('content').innerHTML=`<div class="toolbar"><button id="newLineup" class="primary" ${team.players.length<6?'disabled':''}>Create lineup</button></div>
  <p class="help">Save different R1 lineups for ${esc(team.name)}. Choose one and its starting rotation before each set.</p>
  <div class="list">${team.lineups.length?team.lineups.map(l=>{const issue=lineupIssue(team,l),name=esc(l.name);return item(team.color,`<h3>${name}</h3><p>${l.system} · R1: ${l.starters.map(id=>{const p=team.players.find(p=>p.id===id);return p?'#'+esc(p.jersey):'Missing player';}).join(' · ')}</p>${issue?`<p class="lineup-warning">Needs review: ${esc(issue)}</p>`:''}`,
   `<button data-lineup-edit="${esc(l.id)}" class="primary" aria-label="Edit ${name}">Edit</button><button data-lineup-copy="${esc(l.id)}" aria-label="Copy ${name}">Copy</button><button data-lineup-delete="${esc(l.id)}" class="danger" aria-label="Delete ${name}">Delete</button>`,'three');}).join(''):'<div class="card"><p>No saved lineups yet. Create your first lineup here, or save one during set setup.</p></div>'}</div>`;
 $('newLineup').onclick=()=>editLineup(team);
 document.querySelectorAll('[data-lineup-edit]').forEach(b=>b.onclick=()=>editLineup(team,team.lineups.find(l=>l.id===b.dataset.lineupEdit)));
 document.querySelectorAll('[data-lineup-delete]').forEach(b=>b.onclick=()=>{
  const l=team.lineups.find(l=>l.id===b.dataset.lineupDelete);
  if(!confirm(`Delete the saved lineup ${l.name}? Sets already played with it keep their lineup.\n\nThis cannot be undone.`))return;
  save(async()=>{await store.saveTeam({...team,revision:team.revision+1,lineups:team.lineups.filter(x=>x.id!==l.id)},team.revision);await load();home();notice(`${l.name} deleted.`);});
 });
 document.querySelectorAll('[data-lineup-copy]').forEach(b=>b.onclick=()=>{const l=team.lineups.find(l=>l.id===b.dataset.lineupCopy);editLineup(team,{...l,id:identity(),name:l.name+' copy'});});
}
function editLineup(team,lineup=null){
 notice();bar(lineup?'Edit lineup':'Create lineup',team.name,{label:'Lineups',action:home});
 $('content').innerHTML=`<form id="lineupForm"><label>Lineup name<input id="lineupName" required maxlength="100" value="${esc(lineup?.name??'')}" placeholder="Standard 6-2"></label><div id="lineupFields"></div><div class="actions form-actions"><button class="primary" type="submit">Save lineup</button><button type="button" id="cancel">Cancel</button></div></form>`;
 const editor=mountLineupEditor($('lineupFields'),team,lineup??{},()=>{dirty=true;});
 $('lineupForm').oninput=()=>{dirty=true;};
 $('cancel').onclick=()=>{if(!dirty||confirm('Discard these unsaved lineup changes?')){dirty=false;home();}};
 $('lineupForm').onsubmit=e=>{e.preventDefault();save(async()=>{
  const value=validateLineup(team,{...editor.read(),id:lineup?.id??identity(),name:$('lineupName').value});
  const updated={...team,revision:team.revision+1,lineups:[...team.lineups.filter(l=>l.id!==value.id),value]};
  await store.saveTeam(updated,team.revision);dirty=false;await load();home();notice(`${value.name} saved.`);
 });};
 $('lineupName').focus();
}
function matchSetup(team,match=null){
 team=teams.find(t=>t.id===team.id);notice();
 const setNumber=match?match.sets.length+1:1,planned=match&&!match.sets.length;
 bar(match&&!planned?`Set ${setNumber}`:planned?match.opponent:'New match',match?`${team.name} · ${planned?'Saved match':match.opponent}`:team.name,{label:match?match.opponent:team.name,action:home});
 const previousSet=match?.sets.at(-1),previous=previousSet?.config;
 const today=new Date();const date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
 const previousRotation=previousSet?replaySet(previousSet).rotation:null;
 const lineupOptions=()=>`<option value="">Custom lineup${previous?' / previous set':''}</option>`+team.lineups.map(l=>`<option value="${esc(l.id)}">${esc(l.name)} · ${l.system}${lineupIssue(team,l)?' (needs review)':''}</option>`).join('');
 $('content').innerHTML=`<form id="matchForm"><div class="grid"><label>Opponent<input id="opponent" required maxlength="100" autocomplete="off"></label><label>Match date<input id="date" type="date" required value="${date}"></label><label>Match format<select id="bestOf" ${match?.bestOf&&!planned?'disabled':''}><option value="3">Best of 3</option><option value="5">Best of 5</option></select></label><label id="firstServeLabel">First serve<select id="firstServe"><option value="them">${esc(team.name)} receives</option><option value="us">${esc(team.name)} serves</option></select></label></div><p id="setRules" class="help"></p>
 <fieldset><legend>Choose lineup</legend><label>Saved lineup<select id="lineupSelect">${lineupOptions()}</select></label><p id="lineupNote" class="muted">${previous?'Previous set’s base R1 lineup copied below. You can choose another saved lineup.':'Choose a saved lineup or build one below.'}</p><fieldset id="lineupFields"></fieldset>
 <details id="saveLineupDetails" class="save-lineup"><summary>Save this lineup for later</summary><label>New lineup name<input id="saveLineupName" maxlength="100" placeholder="Standard 6-2"></label><button type="button" id="saveLineup">Save as new lineup</button></details></fieldset>
 <fieldset><legend>Starting rotation</legend><div class="grid"><label>Start choice<select id="rotationMode"><option value="auto">Serve R1 / receive R6</option><option value="manual">Choose a rotation</option><option value="carry" ${previousSet?'':'disabled'}>${previousSet?`Carry previous set’s ending rotation (R${previousRotation})`:'Carry previous set’s ending rotation (no previous set)'}</option></select></label><label id="manualRotationLabel" hidden>Rotation<select id="startingRotation">${[1,2,3,4,5,6].map(n=>`<option value="${n}">R${n}</option>`).join('')}</select></label></div>
 <p id="rotationExplanation" class="help"></p><h3 id="startPreviewTitle">Starting court</h3><div id="startPreview" class="lineup-court lineup-preview" aria-label="Starting court preview"></div></fieldset>
 ${active?'<p class="help">Your current set stays saved in its team’s match page.</p>':''}<div class="actions form-actions"><button type="submit" class="primary">Start</button>${!match||planned?'<button type="button" id="saveMatch">Save</button>':''}<button type="button" id="cancel">Cancel</button></div></form>`;
 let selectedLineupId='';
 const initial=previousSet?lineupFromSet(previousSet):{};
 const editor=mountLineupEditor($('lineupFields'),team,initial,()=>{
  selectedLineupId='';$('lineupSelect').value='';$('lineupNote').textContent='Custom changes apply to this set. Save as a new lineup to reuse them.';preview();
 });
 function preview(){
  const saved=Boolean(selectedLineupId);
  $('lineupFields').hidden=saved;$('lineupFields').disabled=saved;
  $('saveLineupDetails').hidden=saved;
  const mode=$('rotationMode').value;
  $('manualRotationLabel').hidden=mode!=='manual';
  const rotation=startingRotation({mode,firstServe:$('firstServe').value,rotation:Number($('startingRotation').value),previousSet});
  $('startPreviewTitle').textContent=`Starting court · R${rotation} · ${$('firstServe').value==='us'?'Serving':'Receiving'}`;
  $('rotationExplanation').textContent=mode==='carry'?`R${rotation} from the end of the previous set, using the lineup selected above. Substitutions and libero entries are not carried over.`:mode==='auto'?'The starting court follows first serve: R1 when serving, R6 when receiving.':`The selected lineup starts in R${rotation}.`;
  const lineup=editor.read(),base=lineup.starters,order=[...base.slice(rotation-1),...base.slice(0,rotation-1)];
  $('startPreview').innerHTML='<span class="lineup-net" aria-hidden="true">NET</span><span class="lineup-attack-line" aria-hidden="true"></span>'+[4,3,2,5,6,1].map((pos,i)=>{
   const p=team.players.find(p=>p.id===order[pos-1]);
   const color=p&&lineup.setters.includes(p.id)?'var(--c-set)':p?.position==='MB'?'var(--c-mid)':'var(--c-oh)';
   return `<div data-preview-position="${pos}" class="lineup-player ${[1,5,6].includes(pos)?'back':''} ${p?'':'empty'}" style="--column:${i%3};--row:${Math.floor(i/3)};--player-color:${color}"><small class="lineup-position">P${pos}${pos===1&&$('firstServe').value==='us'?' · server':''}</small><span class="lineup-disc"><strong class="lineup-number">${p?esc(p.jersey):'—'}</strong></span><span class="lineup-name">${p?esc(p.name):'Choose a player'}</span></div>`;
  }).join('');
 }
 $('lineupSelect').onchange=()=>{
  const value=team.lineups.find(l=>l.id===$('lineupSelect').value);
  editor.write(value??initial);selectedLineupId=value?.id??'';
  $('lineupNote').textContent=value?(lineupIssue(team,value)||`${value.name} loaded. Choose how this lineup starts below.`):'Custom lineup / previous set’s R1 order.';preview();
 };
 $('saveLineup').onclick=()=>save(async()=>{
  const value=validateLineup(team,{...editor.read(),id:identity(),name:$('saveLineupName').value});
  await store.saveTeam({...team,revision:team.revision+1,lineups:[...team.lineups,value]},team.revision);
  await load();team=teams.find(t=>t.id===team.id);$('lineupSelect').innerHTML=lineupOptions();$('lineupSelect').value=value.id;selectedLineupId=value.id;
  $('saveLineupName').value='';preview();notice(`${value.name} saved for ${team.name}.`);
 });
 if(planned){$('opponent').value=match.opponent;$('date').value=match.date;$('bestOf').value=String(match.bestOf);}
 if(previous){
  $('opponent').value=match.opponent;$('opponent').readOnly=true;$('date').value=match.date;$('date').readOnly=true;
  if(match.bestOf)$('bestOf').value=String(match.bestOf);
 }
 function rules(){
  const plan=setPlan({bestOf:Number($('bestOf').value),setNumber,previousSet});
  $('firstServeLabel').hidden=Boolean(plan.firstServe);if(plan.firstServe)$('firstServe').value=plan.firstServe;
  const server=$('firstServe').value==='us'?team.name:match?.opponent??'Opponent';
  $('setRules').textContent=`Set ${setNumber} is played to ${plan.target}${plan.deciding?' (deciding set)':''}.`+(plan.firstServe?` ${server} serves first; first serve alternates each set.`:'');
  preview();
 }
 $('bestOf').onchange=rules;
 for(const id of ['rotationMode','startingRotation'])$(id).onchange=preview;
 $('firstServe').onchange=rules;
 rules();
 $('cancel').onclick=()=>{notice();home();};
 // Save the match details only; lineup and first serve are chosen when it starts.
 $('saveMatch')?.addEventListener('click',()=>{
  if(!$('opponent').reportValidity()||!$('date').reportValidity())return;
  save(async()=>{
   const entry={id:match?.id??identity(),opponent:$('opponent').value,date:$('date').value,bestOf:Number($('bestOf').value)};
   const updated=validateTeam({...team,revision:team.revision+1,plannedMatches:[...team.plannedMatches.filter(m=>m.id!==entry.id),entry]});
   await store.saveTeam(updated,team.revision);await load();go(team.id);notice(`Match vs ${updated.plannedMatches.find(m=>m.id===entry.id).opponent} saved.`);
  });
 });
 $('matchForm').onsubmit=e=>{e.preventDefault();
  const choices={...editor.read(),bestOf:Number($('bestOf').value),opponent:$('opponent').value,date:$('date').value,firstServe:$('firstServe').value,
    rotationMode:$('rotationMode').value,rotation:Number($('startingRotation').value),previousSet,lineupId:selectedLineupId};
  save(async()=>{const record=makeMatchSet(team,choices,{setId:identity(),matchId:match?.id??identity(),setNumber});await store.startSet(record,expected());busy=false;location.href='./index.html';});
 };
 if(match)$('lineupSelect').focus();else $('opponent').focus();
}
window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
// Let committed navigation leave normally.
window.addEventListener('pagehide',()=>store?.close());
try{notice('Opening saved teams…');store=await openSetStore();notice('Reading saved teams…');await load();home();notice();}catch(e){notice(e.message,true);$('content').innerHTML='<button id="retry">Retry loading teams</button>';$('retry').onclick=()=>location.reload();}
