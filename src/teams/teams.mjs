import { openSetStore } from '../storage/indexeddb.mjs';
import { replaySet } from '../engine/set-engine.mjs';
import { validateLineup, lineupIssue } from './lineup-model.mjs';
import { mountLineupEditor } from './lineup-editor.mjs';
import { teamHierarchy, isExhibitionSet, correctSetFirstServe } from './match-model.mjs';
import { POSITIONS, validateTeam } from './team-model.mjs';
import { registerApp } from '../app/pwa.mjs';
import { COLOR_THEMES, colorTheme } from '../app/themes.mjs';
import { createPractice } from '../practice/practice-model.mjs';
import { buildLineupAnalysis, buildTeamStats, matchSetLineups } from './stats-model.mjs';
import { makeStatsTablesSortable, matchSummary, rotationReport } from '../app/team-menu.mjs';
import { PLAYER_PERFORMANCE_HEADERS, playerPerformanceCells } from '../app/player-performance.mjs';
registerApp();
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let store,teams=[],sets=[],practices=[],active=null,busy=false,dirty=false;
function themePreviewMarkup(theme){
 return `<span class="theme-preview" style="--preview-court:${theme.court};--preview-court-2:${theme.court2};--preview-accent:${theme.accent};--preview-set:${theme.set};--preview-oh:${theme.oh};--preview-mid:${theme.mid};--preview-win:${theme.win};--preview-lose:${theme.lose}"><span class="theme-preview-roles"><i class="set"></i><i class="oh"></i><i class="mid"></i></span><span class="theme-preview-results"><i class="win"></i><i class="lose"></i><b></b></span></span>`;
}
const reportDialog=$('reportDialog'),reportBody=$('reportBody');
function openReport(html,wide=false){
 reportBody.innerHTML=html;reportDialog.classList.toggle('wide',wide);
 if(!reportDialog.open)reportDialog.showModal();
}
reportBody?.addEventListener('click',e=>{
 if(!e.target.closest('#shCancel'))return;
 reportDialog.close();
});
reportDialog?.addEventListener('click',e=>{if(e.target===reportDialog)reportDialog.close();});
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
 save(async()=>{await withFreshStore(()=>store.deleteData(request));await load();after();});
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
function editMatchDetails(team,match){
 dirty=false;notice();
 bar('Edit match details',match.opponent,{label:match.opponent,action:()=>go(team.id,match.id)});
 $('content').innerHTML=`<form id="matchDetailsForm"><p class="help">Changing the opponent or date updates every saved set in this match and keeps the existing rally statistics.</p>
  <div class="grid"><label>Opponent<input id="matchOpponent" required maxlength="100" value="${esc(match.opponent)}"></label><label>Match date<input id="matchDate" type="date" value="${esc(match.date)}"></label></div>
  <div class="actions form-actions"><button type="submit" class="primary">Save match details</button><button type="button" id="cancelMatchDetails">Cancel</button></div></form>`;
 $('matchDetailsForm').oninput=()=>{dirty=true;};
 $('cancelMatchDetails').onclick=()=>{dirty=false;go(team.id,match.id);};
 $('matchDetailsForm').onsubmit=e=>{e.preventDefault();save(async()=>{
  const opponent=$('matchOpponent').value.trim(),date=$('matchDate').value||match.date||'';
  if(!opponent)throw new Error('Enter an opponent.');
  await withFreshStore(()=>store.updateMatchDetails({teamId:team.id,matchId:match.id,teamRevision:team.revision,
   expectedSetIds:match.sets.map(record=>record.config.id),opponent,date}));
  dirty=false;await load();go(team.id,match.id);notice(`Match details updated for vs ${opponent}.`);
 });};
}
async function load(){
 [teams,sets,practices,active]=await withFreshStore(()=>Promise.all([store.listTeams(),store.listSets(),store.listPractices(),store.loadActive()]));
 teams.sort((a,b)=>a.name.localeCompare(b.name));
 $('liveLink').hidden=!active;
 $('liveLink').textContent=active&&replaySet(active).status==='ended'?'Open set':'Live set';
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
function matchReportContext(team,match,record,closeLabel='Close'){
 return {record,state:replaySet(record),teams:{us:team.name,them:match.opponent||'Opponent'},players:team.players,
  matchRecords:()=>match.sets,exhibition:isExhibitionSet(record,match.sets),matchWins:match.wins,
  open:openReport,closeLabel};
}
function editSetFirstServe(team,match,record){
 const setNumber=record.config.setNumber??1;
 openReport(`<h4>Correct first server · Set ${setNumber}</h4>
  <p>Choose the team that actually served first. The score history is retained, and the set’s server and rotation stats are recalculated.</p>
  <label>First server<select id="correctFirstServer"><option value="us" ${record.config.firstServe==='us'?'selected':''}>${esc(team.name)} served</option><option value="them" ${record.config.firstServe==='them'?'selected':''}>${esc(match.opponent||'Opponent')} served</option></select></label>
  <div class="actions"><button type="button" id="saveFirstServer" class="primary">Save correction</button><button type="button" id="shCancel" class="cancel">Cancel</button></div>`);
 reportBody.querySelector('#saveFirstServer').onclick=()=>{
  const firstServer=reportBody.querySelector('#correctFirstServer').value;
  let correction;
  try{correction=correctSetFirstServe(record,firstServer);}
  catch(error){notice(`Correction could not be applied: ${error.message} No saved data was changed.`,true);return;}
  if(firstServer===record.config.firstServe){reportDialog.close();return;}
  const details=[`Set ${setNumber} will start with ${firstServer==='us'?team.name:match.opponent||'the opponent'} serving.`];
  if(correction.droppedReceiveActions)details.push(`${correction.droppedReceiveActions} receive rating or formation action${correction.droppedReceiveActions===1?'':'s'} logged before the first rally will be removed because your team was serving.`);
  if(correction.reclassifiedFirstRally)details.push('The first rally’s serve outcome will be reclassified to preserve which team won that point.');
  if(!confirm(details.join('\n\n')+'\n\nSave this correction?'))return;
  save(async()=>{
   await withFreshStore(()=>store.updateSetRecord(record,correction.record));
   await load();reportDialog.close();go(team.id,match.id);notice(`Set ${setNumber} first server corrected.`);
  });
 };
}
function showMatchSummary(team,match){
 const record=match.sets.at(-1);if(record)matchSummary(matchReportContext(team,match,record));
}
function cleanExportPart(value){
 return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'');
}
function downloadJson(text,filename){
 const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download=filename;link.hidden=true;document.body.append(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function shareOrDownloadExport(payload,filename,title){
 const text=JSON.stringify(payload,null,2);
 let file=null;
 try{file=new File([text],filename,{type:'application/json'});}catch{}
 if(file&&typeof navigator.share==='function'&&typeof navigator.canShare==='function'){
  try{
   if(navigator.canShare({files:[file]})){
    await navigator.share({files:[file],title});notice(`${title} shared.`);return;
   }
  }catch(error){
   if(error?.name==='AbortError')return;
   downloadJson(text,filename);notice(`${title} downloaded; sharing was unavailable.`);return;
  }
 }
 downloadJson(text,filename);notice(`${title} downloaded.`);
}
function exportMatch(team,match){
 const payload={schemaVersion:1,kind:'volleyball-match-export',exportedAt:new Date().toISOString(),
  match:{id:match.id,teamId:team.id,teamName:team.name,opponent:match.opponent,date:match.date,bestOf:match.bestOf,
   setsWon:{us:match.wins.us,them:match.wins.them},winner:match.winner},sets:match.sets};
 const stem=[team.name,'vs',match.opponent,match.date].map(cleanExportPart).filter(Boolean).join('-')||'volleyball-match';
 void shareOrDownloadExport(payload,`${stem}.json`,'Match export');
}
function exportTeam(team){
 const sourceTeam=teams.find(item=>item.id===team.id);
 const exportedAt=new Date().toISOString();
 const matches=team.matches.map(match=>({
  id:match.id,opponent:match.opponent,date:match.date,bestOf:match.bestOf,
  wins:{...match.wins},winner:match.winner,inProgress:match.inProgress,
  planned:match.planned?structuredClone(match.planned):null,
  sets:match.sets.map(record=>structuredClone(record)),
 }));
 const payload={schemaVersion:1,kind:'volleyball-team-export',exportedAt,
  team:sourceTeam?structuredClone(sourceTeam):{schemaVersion:null,id:team.id,name:team.name,color:team.color,
   teamTheme:team.teamTheme??null,logo:team.logo??null,legacy:true},
  matches,practices:practices.filter(practice=>practice.teamId===team.id).map(practice=>structuredClone(practice)),
 };
 const stem=cleanExportPart(team.name)||'volleyball-team';
 const date=exportedAt.slice(0,10);
 void shareOrDownloadExport(payload,`${stem}-team-${date}.json`,'Team export');
}
function showRotationReportPicker(team,match){
 const lineups=matchSetLineups(match.sets);
 const sets=match.sets.map((record,index)=>({record,state:replaySet(record),number:record.config.setNumber??index+1,
  exhibition:isExhibitionSet(record,match.sets),lineup:lineups[index]}));
 const rotations=Array.from({length:6},(_,index)=>({number:index+1,won:0,lost:0,rallies:0}));
 for(const {state} of sets)for(const rally of state.rallies){
  const row=rotations[rally.rotation-1];if(!row)continue;
  row.rallies++;row[rally.winner==='us'?'won':'lost']++;
 }
 const qualified=rotations.filter(row=>row.rallies>=8);
 const rates=qualified.map(row=>row.won/row.rallies);
 const bestRate=rates.length?Math.max(...rates):null,worstRate=rates.length?Math.min(...rates):null;
 const totalRallies=rotations.reduce((total,row)=>total+row.rallies,0);
 const exhibitionCount=sets.filter(set=>set.exhibition).length;
 const setCountLabel=sets.length===1?'1 set':`${sets.length} sets`;
 const rallyCountLabel=totalRallies===1?'1 rally':`${totalRallies} rallies`;
 const rotationSnapshot=`<section class="rotation-snapshot" aria-label="Match rotation snapshot">
  <div class="rotation-snapshot-heading"><strong>Match rotation snapshot</strong><span>${setCountLabel} · ${rallyCountLabel}${exhibitionCount?` · includes ${exhibitionCount} exhibition ${exhibitionCount===1?'set':'sets'}`:''}</span></div>
  <div class="rotation-snapshot-grid">${rotations.map(row=>{
   const rate=row.rallies?row.won/row.rallies:null;
   const best=bestRate!==null&&bestRate>worstRate&&row.rallies>=8&&rate===bestRate;
   const worst=bestRate!==null&&bestRate>worstRate&&row.rallies>=8&&rate===worstRate;
   const highlight=best?' best':worst?' worst':'';
   const detail=rate===null?'no rallies':`${Math.round(rate*100)}% won · n=${row.rallies}`;
   return `<div class="rotation-snapshot-cell${highlight}" role="group" aria-label="Rotation ${row.number}: ${row.won} won, ${row.lost} lost, ${detail}${best?', best':worst?', lowest':''}"><span class="rotation-snapshot-label">R${row.number}${best?'<i>Best</i>':worst?'<i>Lowest</i>':''}</span><strong>${row.won}–${row.lost}</strong><small>${detail}</small></div>`;
  }).join('')}</div>
  <p>Totals combine all recorded sets and lineups. Highest and lowest are highlighted only with at least 8 rallies.</p>
 </section>`;
 openReport(`<h4>Rotation Report · ${esc(team.name)} vs ${esc(match.opponent||'Opponent')}</h4>
  ${rotationSnapshot}<h5>Choose a set to view its rotation report</h5>
  <div class="report-set-picker">${sets.map(({record,state,number,lineup,exhibition})=>`<button type="button" data-report-set="${esc(record.config.id)}"><strong>Set ${number}${exhibition?' · Exhibition':''} · ${esc(lineup.name)}${lineup.inheritedFromSet?` (continued from Set ${lineup.inheritedFromSet})`:''}</strong><span>${state.score.us}–${state.score.them} · ${esc(record.config.system)}</span></button>`).join('')}</div>
 <button class="cancel" id="shCancel" type="button">Close</button>`);
 reportBody.querySelectorAll('[data-report-set]').forEach(button=>button.onclick=()=>{
  const record=match.sets.find(set=>set.config.id===button.dataset.reportSet);
  if(record)showRotationReportSet(team,match,record);
 });
}
function showRotationReportSet(team,match,record){
 rotationReport(matchReportContext(team,match,record,'Choose another set'));
 const close=reportBody.querySelector('#shCancel');
 close?.addEventListener('click',event=>{
  event.preventDefault();event.stopPropagation();
  showRotationReportPicker(team,match);
 },{once:true});
}
function statTable(rows,matchStats=false){
 if(!rows.length)return `<div class="stats-empty">No ${matchStats?'player match':'serving, passing, or attacking'} results recorded.</div>`;
 return `<div class="stats-table-scroll"><table class="stats-table player-performance-table${matchStats?' match-stats':''}"><thead><tr><th>Player</th>${PLAYER_PERFORMANCE_HEADERS}${matchStats?'<th>Ace %</th><th>+/-</th>':''}</tr></thead><tbody>${rows.map(({player,stats})=>{
  const serving=stats.serving,attempts=serving.attempts,acePercent=attempts?`${Math.round(serving.aces*100/attempts)}% <small>n=${attempts}</small>`:'—';
  const plusMinus=stats.attacking.plusMinus;
  return `<tr><th scope="row">#${esc(player.jersey)} ${esc(player.name)}</th>${playerPerformanceCells(stats)}${matchStats?`<td>${acePercent}</td><td class="${plusMinus>0?'pos':plusMinus<0?'neg':''}">${plusMinus>0?`+${plusMinus}`:plusMinus}</td>`:''}</tr>`;
 }).join('')}</tbody></table></div>`;
}
const analysisPercent=(part,total)=>total?`${Math.round(part*100/total)}%`:'—';
const analysisSigned=value=>value>0?`+${value}`:String(value);
function lineupPlayerTable(players){
 const rows=players.filter(({passing,serving,attacking})=>passing.count||serving.attempts||attacking.kills||attacking.hittingErrors||attacking.nonTerminalAttempts);
 if(!rows.length)return '<div class="stats-empty">No passing, serving, or attacking results recorded for this lineup.</div>';
 return `<div class="stats-table-scroll"><table class="stats-table player-performance-table lineup-player-table"><thead><tr><th>Player</th>${PLAYER_PERFORMANCE_HEADERS}<th>Serve points W–L</th><th>Ace %</th><th>Pass scores · 0 / 1 / 2 / 3</th></tr></thead><tbody>${rows.map(({player,passing,serving,attacking})=>{
  const serveRecord=serving.attempts?`${serving.pointsWon}–${serving.pointsLost} <small>n=${serving.attempts}</small>`:'—';
  const acePercent=serving.attempts?`${analysisPercent(serving.aces,serving.attempts)} <small>n=${serving.attempts}</small>`:'—';
  const distribution=passing.count?[0,1,2,3].map(r=>passing.ratings[r]).join(' / '):'—';
  return `<tr><th scope="row">#${esc(player.jersey)} ${esc(player.name)}</th>${playerPerformanceCells({passing,serving,attacking})}<td>${serveRecord}</td><td>${acePercent}</td><td>${distribution}</td></tr>`;
 }).join('')}</tbody></table></div>`;
}
function lineupAnalysisMarkup(lineups){
 if(!lineups.length)return '<div class="stats-empty">No match lineup data yet. Start recording sets to compare lineups and rotations.</div>';
 return `<div class="stats-breakdowns lineup-analysis-list">${lineups.map((lineup,index)=>{
  const rotationCards=[1,2,3,4,5,6].map(number=>{
   const r=lineup.rotations[number],pass=r.passing,passAvg=pass.count?(pass.sum/pass.count).toFixed(2):'—';
   const distribution=pass.count?[0,1,2,3].map(score=>`${score}: ${pass.ratings[score]}`).join(' · '):'No pass scores';
   const delta=r.won-r.lost;
   return `<section class="analysis-rotation ${delta>0?'positive':delta<0?'negative':''}">
    <h4>R${number}<span>${r.won}–${r.lost} · <b class="${delta>0?'pos':delta<0?'neg':''}">${analysisSigned(delta)}</b></span></h4>
    <p class="analysis-volume">${r.rallies} rallies${r.rallies<10?' · small sample':''}</p>
    <dl><dt>Side-out</dt><dd>${analysisPercent(r.wonReceiving,r.received)} <small>${r.wonReceiving}/${r.received} received</small></dd>
     <dt>Point-scoring</dt><dd>${analysisPercent(r.wonServing,r.served)} <small>${r.wonServing}/${r.served} served</small></dd>
     <dt>Pass average</dt><dd>${passAvg} <small>n=${pass.count}</small></dd>
     <dt>Pass scores</dt><dd class="analysis-distribution">${distribution}</dd>
     <dt>Pass to side-out</dt><dd>${analysisPercent(pass.sideoutWins,pass.linked)} <small>n=${pass.linked} linked</small></dd>
     <dt>Best run</dt><dd>${r.bestRun}</dd><dt>Longest run allowed</dt><dd>${r.longestRunAllowed}</dd></dl>
   </section>`;
  }).join('');
  const delta=lineup.won-lineup.lost;
  return `<details class="stats-group lineup-analysis-group" ${index===0?'open':''}>
   <summary><strong>${esc(lineup.name)}</strong><span>${esc(lineup.system)} · ${lineup.matches} matches · ${lineup.setsWon}–${lineup.setsLost} sets · ${lineup.won}–${lineup.lost} rallies · <b class="${delta>0?'pos':delta<0?'neg':''}">${analysisSigned(delta)}</b></span></summary>
   <div class="lineup-analysis-body"><p class="muted"><strong>R1:</strong> ${esc(lineup.starterLabel)} · <strong>Setters:</strong> ${esc(lineup.setterLabel)} · ${lineup.rallies} rallies in ${lineup.setsPlayed} sets. Cells with fewer than 10 rallies are marked as small samples.</p>
    <div class="analysis-rotation-grid">${rotationCards}</div>
    <details class="stats-set analysis-players"><summary>Serving and passing by player</summary>${lineupPlayerTable(lineup.players)}</details>
   </div>
  </details>`;
 }).join('')}</div>`;
}
function teamStatsPage(team){
 const stats=buildTeamStats(team,practices);
 const lineupAnalysis=buildLineupAnalysis(team);
 const exhibitionCount=stats.matches.reduce((count,match)=>count+match.sets.filter(set=>set.exhibition).length,0);
 const seasonRows=source=>stats.players.map(row=>({player:row.player,stats:row[source]}))
  .filter(row=>row.stats.passing.count||row.stats.serving.attempts||row.stats.attacking.actions
   ||row.stats.attacking.nonTerminalAttempts);
 const seasonSourceText=source=>source==='matches'
  ?`Match stats · ${plural(stats.counts.sets,'set')} recorded${exhibitionCount?` · includes ${plural(exhibitionCount,'exhibition set')}`:''}`
  :`Practice stats · ${plural(stats.counts.practices,'practice')} · ${plural(stats.counts.practiceResults,'result')}`;
 $('content').innerHTML=`<section class="season-stats-summary card" style="--team-color:${team.color}">
   <div><h2>${esc(team.name)} · ${esc(team.season||'Season stats')}</h2><p>${plural(stats.counts.practices,'practice')} · ${plural(stats.counts.matches,'match')} · ${plural(stats.counts.sets,'set')} · ${plural(stats.counts.practiceResults,'practice result')}</p></div>
   <p class="muted">Practice results are tapped individually; match serve attempts come from completed rallies. Use the source selector to review each separately. Exhibition set stats count here, but those sets do not change official match results. Serve In % includes aces; Ace % shows aces as a share of attempts. Hitting % = (kills − hitting errors) ÷ all attacks, including non-terminal attempts. Match +/− is kills, blocks, and aces minus errors credited to that player.</p>
  </section>
  <h2 class="list-title">Lineup and rotation analysis</h2>
  <p class="help">Rally outcomes are grouped by the lineup used in each set and the rotation at the start of each rally. Pass-to-side-out rates include scores linked to a recorded rally.</p>
  ${lineupAnalysisMarkup(lineupAnalysis)}
  <section class="season-totals">
   <div class="season-totals-heading"><div><h2 class="list-title">Season totals</h2><p id="seasonTotalsContext" class="muted">${seasonSourceText('matches')}</p></div>
    <div class="season-source-toggle" role="group" aria-label="Season totals source"><button type="button" data-season-source="matches" aria-pressed="true">Matches</button><button type="button" data-season-source="practice" aria-pressed="false">Practices</button></div>
   </div>
   <div id="seasonTotalsTable">${statTable(seasonRows('matches'),true)}</div>
  </section>
  <h2 class="list-title">Matches and sets</h2>
  <div class="stats-breakdowns">${stats.matches.length?stats.matches.map(match=>{
   const result=match.winner?(match.winner==='us'?'Won':'Lost')+(match.inProgress?' · exhibition in progress':''):match.inProgress?'In progress':match.sets.length?'Complete':'Not started';
   return `<details class="stats-group"><summary><strong>vs ${esc(match.opponent||'Opponent')}</strong><span>${esc(match.date||'Date not recorded')} · ${esc(result)}${match.sets.length?` · Sets ${match.wins.us}–${match.wins.them}`:''}</span></summary>
    ${match.sets.length?`<section class="stats-match-total"><h3>Match totals</h3>${match.sets.some(set=>set.exhibition)?'<p class="muted">Includes stats from the exhibition set; the official match result excludes it.</p>':''}${statTable(match.rows,true)}</section>
     <div class="stats-set-list">${match.sets.map(set=>`<details class="stats-set"><summary>Set ${set.number}${set.exhibition?' · Exhibition':''} · ${set.score.us}–${set.score.them} · ${set.status==='ended'?'Finished':'In progress'}</summary><p class="stats-set-lineup"><strong>Lineup:</strong> ${esc(set.lineupName)}${set.lineupInheritedFromSet?` · continued from Set ${set.lineupInheritedFromSet}`:''}</p>${statTable(set.rows,true)}</details>`).join('')}</div>`:'<p class="stats-empty">No set results recorded yet.</p>'}
   </details>`;
  }).join(''):'<div class="stats-empty">No matches recorded for this team.</div>'}</div>
  <h2 class="list-title">Practices</h2>
  <div class="stats-breakdowns">${stats.practices.length?stats.practices.map(practice=>`<details class="stats-group stats-practice"><summary><strong>Practice · ${esc(practice.date)}</strong><span>${plural(practice.resultCount,'result')} · ${new Date(practice.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</span></summary>${statTable(practice.rows)}</details>`).join(''):'<div class="stats-empty">No practices recorded for this team.</div>'}</div>`;
 makeStatsTablesSortable($('seasonTotalsTable'));
 const sourceButtons=[...$('content').querySelectorAll('[data-season-source]')];
 sourceButtons.forEach(button=>button.onclick=()=>{
  const source=button.dataset.seasonSource;
  sourceButtons.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  $('seasonTotalsContext').textContent=seasonSourceText(source);
  $('seasonTotalsTable').innerHTML=statTable(seasonRows(source),source==='matches');
  makeStatsTablesSortable($('seasonTotalsTable'));
 });
}
function home(){
 dirty=false;
 const hierarchy=teamHierarchy(teams,sets),params=new URLSearchParams(location.hash.slice(1));
 const team=hierarchy.find(t=>t.id===params.get('team'));
 const match=team?.matches.find(m=>m.id===params.get('match'));
 if(team?.editable&&match&&params.get('view')==='edit-match'){editMatchDetails(teams.find(t=>t.id===team.id),match);return;}
 if(team?.editable&&match&&params.get('view')==='setup'){
  const nextSet=match.sets.length+1;
  const optionalThird=match.bestOf===3&&nextSet===3&&match.sets.length===2&&Boolean(match.winner);
  const canSetup=!match.inProgress&&match.bestOf&&nextSet<=match.bestOf&&(!match.winner||optionalThird);
  if(canSetup){launchSetSetup(team.id,match.id);return;}
 }
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
   $('content').innerHTML=`${team.logo?`<div class="team-brand" style="--team-color:${team.color}">${logoMarkup(team.logo,team.name)}<div><strong>${esc(team.name)}</strong><span>${esc(colorTheme(team.teamTheme).name)} theme</span></div></div>`:''}<div class="toolbar">${team.editable?`<button data-start="${esc(team.id)}" class="primary" ${team.players.length<6?'disabled':''}>New match</button><button id="startPractice" class="primary" ${team.players.length?'':'disabled'}>New practice</button><button id="teamLineups">Lineups</button><button data-edit="${esc(team.id)}">Edit roster</button>`:''}<button id="teamStats">View stats</button><button id="exportTeam">Export Team</button><button id="deleteTeam" class="danger">Delete team</button></div>
   ${team.editable&&team.players.length<6?'<p class="muted">Add at least six players to start a match.</p>':''}
   <h2 class="list-title">Matches</h2>
   <div class="list">${team.matches.length?team.matches.map(m=>{
    const reportsAvailable=Boolean(m.winner&&m.sets.length);
    const exportAvailable=Boolean(reportsAvailable&&!m.inProgress);
    const exhibitions=m.sets.filter(record=>isExhibitionSet(record,m.sets)).length;
    const resultLabel=!m.sets.length?'Saved match':m.winner?(m.winner==='us'?'Match won':'Match lost')+(m.inProgress?' · exhibition set in progress':''):m.inProgress?'Set in progress':'All recorded sets finished';
    return item(team.color,`<h3>${esc(m.opponent)}</h3><p>${esc(m.date)||'Date not recorded'} · ${m.sets.length?`${plural(m.sets.length,'set')} · Sets ${m.wins.us}–${m.wins.them}${exhibitions?` · ${plural(exhibitions,'exhibition set')}`:''}`:'Not started'}</p><p class="muted">${resultLabel}${m.bestOf?` · Best of ${m.bestOf}`:''}</p>`,
     `<button data-match="${esc(m.id)}" class="primary">Open match</button>${reportsAvailable?`<button data-match-summary="${esc(m.id)}">Match Summary</button><button data-rotation-report="${esc(m.id)}">Rotation Report</button>`:''}${exportAvailable?`<button data-export-match="${esc(m.id)}">Export Match</button>`:''}<button data-delete-match="${esc(m.id)}" class="danger">Delete match</button>`,'match-card');
   }).join(''):'<div class="card"><p>No matches yet. Choose New match to set up the opponent and first set.</p></div>'}</div>
   <h2 class="list-title">Practices</h2>
   <div class="list">${teamPractices.length?teamPractices.map(p=>item(team.color,`<h3>Practice · ${esc(p.date)}</h3><p>${plural(p.events.length,'recorded result')} · ${new Date(p.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</p>`,
    `<button data-practice="${esc(p.id)}" class="primary">Open practice</button><button data-delete-practice="${esc(p.id)}" class="danger">Delete practice</button>`,'practice-card')).join(''):'<div class="card"><p>No practices recorded yet. Start a practice to track serves and serve receive for this roster.</p></div>'}</div>`;
  $('teamLineups')?.addEventListener('click',()=>go(team.id,null,'lineups'));
  $('teamStats').onclick=()=>go(team.id,null,'stats');
  $('exportTeam').onclick=()=>exportTeam(team);
  document.querySelector('[data-start]')?.addEventListener('click',()=>matchSetup(team));
  $('startPractice')?.addEventListener('click',()=>save(async()=>{
   const practice=createPractice(teams.find(t=>t.id===team.id),identity());
   await withFreshStore(()=>store.createPractice(practice));
   busy=false;
   location.href=`./practice.html?id=${encodeURIComponent(practice.id)}`;
  }));
  document.querySelector('[data-edit]')?.addEventListener('click',()=>editTeam(teams.find(t=>t.id===team.id)));
  document.querySelectorAll('[data-match]').forEach(b=>b.onclick=()=>go(team.id,b.dataset.match));
  document.querySelectorAll('[data-match-summary]').forEach(b=>b.onclick=()=>showMatchSummary(team,team.matches.find(m=>m.id===b.dataset.matchSummary)));
  document.querySelectorAll('[data-rotation-report]').forEach(b=>b.onclick=()=>showRotationReportPicker(team,team.matches.find(m=>m.id===b.dataset.rotationReport)));
  document.querySelectorAll('[data-export-match]').forEach(b=>b.onclick=()=>exportMatch(team,team.matches.find(m=>m.id===b.dataset.exportMatch)));
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
 const optionalThird=match.bestOf===3&&next===3&&match.sets.length===2&&Boolean(match.winner);
 const canStartNext=team.editable&&!match.inProgress&&match.bestOf&&next<=match.bestOf&&(!match.winner||optionalThird);
 bar(match.opponent,[team.name,match.date].filter(Boolean).join(' · '),{label:team.name,action:()=>go(team.id)});
 $('content').innerHTML=`<div class="card match-summary" style="--team-color:${team.color}"><p class="set-score">Sets ${match.wins.us}–${match.wins.them}</p><p>${match.winner?`<strong class="match-result">${match.winner==='us'?'Match won':'Match lost'}</strong> · `:''}${match.bestOf?`Best of ${match.bestOf}`:'Match format not set'}</p></div>
  <div class="toolbar">${canStartNext?`<button id="nextSet" class="primary" ${team.players.length<6?'disabled':''}>${optionalThird?'Record optional set 3':match.sets.length?`Set up set ${next}`:'Set up set 1'}</button>`:''}${team.editable?'<button id="editMatchDetails">Edit match details</button>':''}<button id="deleteMatch" class="danger">Delete match</button></div>
  ${match.inProgress?`<p class="muted">${match.winner?'Official result decided; finish the exhibition set in progress to complete its stats.':'Finish the set in progress before starting another set in this match.'}</p>`:''}
  ${match.sets.length?'<h2 class="list-title">Sets</h2>':''}
  <div class="list">${match.sets.map((r,i)=>{const state=replaySet(r),n=r.config.setNumber??i+1,exhibition=isExhibitionSet(r,match.sets),canCorrectServe=n===1||n===match.bestOf;return item(team.color,`<h3>Set ${n}${exhibition?' · Exhibition':''}</h3><p class="set-score">${state.score.us}–${state.score.them}</p><p>${state.status==='ended'?'Finished':'In progress'} · to ${r.config.rules.target} · ${r.config.firstServe==='us'?esc(team.name):esc(match.opponent||'Opponent')} served first${exhibition?' · statistics count; excluded from match result':''}</p>`,
   `<button data-resume="${esc(r.config.id)}" class="primary">${state.status==='ended'?'Open set':'Resume set'}</button>${canCorrectServe?`<button data-correct-first-serve="${esc(r.config.id)}">Correct first serve</button>`:''}${i===match.sets.length-1?`<button data-delete-set="${esc(r.config.id)}" class="danger">Delete set</button>`:''}`,'set-card');}).join('')}</div>
  ${match.sets.length?'':`<div class="card"><p>Not started · ${esc(match.date)} · Best of ${match.bestOf}. Choose Set up set 1 to change the details or pick the lineup and first serve.</p></div>`}
  ${match.sets.length>1?'<p class="muted">Only the latest set can be deleted, so set numbers and first serve stay in order.</p>':''}`;
 $('deleteMatch').onclick=()=>deleteMatch(team,match);
 $('editMatchDetails')?.addEventListener('click',()=>go(team.id,match.id,'edit-match'));
 document.querySelectorAll('[data-correct-first-serve]').forEach(button=>button.onclick=()=>{
  const record=match.sets.find(set=>set.config.id===button.dataset.correctFirstServe);
  if(record)editSetFirstServe(team,match,record);
 });
 document.querySelector('[data-delete-set]')?.addEventListener('click',()=>remove(`Delete set ${match.sets.length} vs ${match.opponent} and all of its rallies?`,
  {teamId:team.id,setId:match.sets.at(-1).config.id},()=>{if(match.sets.length>1)home();else go(team.id);notice(`Set ${match.sets.length} deleted.`);}));
 $('nextSet')?.addEventListener('click',()=>matchSetup(team,match));
 document.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>save(async()=>{await withFreshStore(()=>store.activateSet(b.dataset.resume,expected()));busy=false;location.href='./index.html';}));
}
window.addEventListener('hashchange',()=>{notice();home();});
function editTeam(team){
 const defaultTheme=COLOR_THEMES[0].id;
 const draft=team?structuredClone(team):{id:identity(),schemaVersion:1,revision:0,name:'',level:'Jr High',season:String(new Date().getFullYear()),teamTheme:defaultTheme,color:colorTheme(defaultTheme).accent,logo:null,players:[]};
 notice();bar(team?'Edit roster':'Create team',team?.name??'',{label:team?team.name:'Teams',action:home});
 $('content').innerHTML=`<form id="teamForm"><p class="help">Save your roster here. Choose starters, setters, and liberos for each match.</p><div class="grid"><label>Team name<input id="teamName" required maxlength="100" value="${esc(draft.name)}" autocomplete="organization"></label><label>Level<select id="level">${['Jr High','JV','Varsity','Club','Other'].map(v=>`<option ${v===draft.level?'selected':''}>${v}</option>`).join('')}</select></label><label>Season / year<input id="season" required maxlength="100" value="${esc(draft.season)}"></label><div class="team-theme-field"><label for="teamTheme">Team theme<select id="teamTheme">${COLOR_THEMES.map(t=>`<option value="${t.id}" ${draft.teamTheme===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label><div id="teamThemePreview" class="team-theme-preview" aria-live="polite"></div><p class="muted">Choose a palette for this team and its live sets.</p></div></div><div class="team-logo-field"><div><h2>Team logo</h2><p class="muted">Upload an SVG, PNG, or JPG image up to 512 KB.</p></div><div class="team-logo-preview" id="teamLogoPreview">${draft.logo?logoMarkup(draft.logo,draft.name||'Team','team-logo-large'):'<span>No logo selected</span>'}</div><label class="upload-label">Choose logo<input id="teamLogoFile" type="file" accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg"></label><button type="button" id="removeTeamLogo" class="danger" ${draft.logo?'':'hidden'}>Remove logo</button></div><div class="section-head"><h2>Players</h2><button type="button" id="addPlayer">Add player</button></div><p class="muted">Jersey numbers 0–99 must be unique within this team. Changing a number keeps recorded stats with that player.</p><div id="players"></div><div class="actions form-actions"><button type="submit" class="primary">Save team</button><button type="button" id="cancel">Cancel</button></div></form>`;
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
  save(async()=>{const valid=validateTeam(input);await withFreshStore(()=>store.saveTeam(valid,team?.revision??null));dirty=false;await load();go(valid.id);notice(`${valid.name} saved.`);});
 };
 $('teamName').focus();
}
function lineupLibrary(team){
 $('content').innerHTML=`<div class="toolbar"><button id="newLineup" class="primary" ${team.players.length<6?'disabled':''}>Create lineup</button></div>
  <p class="help">Save different R1 lineups for ${esc(team.name)}. Choose one and its starting rotation before each set.</p>
  <div class="list">${team.lineups.length?team.lineups.map(l=>{const issue=lineupIssue(team,l),name=esc(l.name),setters=l.setters.map((id,i)=>{const p=team.players.find(p=>p.id===id);return p?`S${i+1} #${esc(p.jersey)}${i===1&&!l.starters.includes(id)?' (bench)':''}`:`S${i+1} missing`;}).join(' · ');return item(team.color,`<h3>${name}</h3><p>${l.system} · Setters: ${setters}</p><p>R1: ${l.starters.map(id=>{const p=team.players.find(p=>p.id===id);return p?'#'+esc(p.jersey):'Missing player';}).join(' · ')}</p>${issue?`<p class="lineup-warning">Needs review: ${esc(issue)}</p>`:''}`,
   `<button data-lineup-edit="${esc(l.id)}" class="primary" aria-label="Edit ${name}">Edit</button><button data-lineup-copy="${esc(l.id)}" aria-label="Copy ${name}">Copy</button><button data-lineup-delete="${esc(l.id)}" class="danger" aria-label="Delete ${name}">Delete</button>`,'three');}).join(''):'<div class="card"><p>No saved lineups yet. Create your first lineup here, or save one during set setup.</p></div>'}</div>`;
 $('newLineup').onclick=()=>editLineup(team);
 document.querySelectorAll('[data-lineup-edit]').forEach(b=>b.onclick=()=>editLineup(team,team.lineups.find(l=>l.id===b.dataset.lineupEdit)));
 document.querySelectorAll('[data-lineup-delete]').forEach(b=>b.onclick=()=>{
  const l=team.lineups.find(l=>l.id===b.dataset.lineupDelete);
  if(!confirm(`Delete the saved lineup ${l.name}? Sets already played with it keep their lineup.\n\nThis cannot be undone.`))return;
  save(async()=>{await withFreshStore(()=>store.saveTeam({...team,revision:team.revision+1,lineups:team.lineups.filter(x=>x.id!==l.id)},team.revision));await load();home();notice(`${l.name} deleted.`);});
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
  await withFreshStore(()=>store.saveTeam(updated,team.revision));dirty=false;await load();home();notice(`${value.name} saved.`);
 });};
 $('lineupName').focus();
}
function launchSetSetup(teamId,matchId){
 location.href=`./index.html?setup=1&team=${encodeURIComponent(teamId)}&match=${encodeURIComponent(matchId)}`;
}
function matchSetup(team,match=null){
 team=teams.find(t=>t.id===team.id);
 if(match){launchSetSetup(team.id,match.id);return;}
 notice();
 const today=new Date(),date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
 bar('New match',team.name,{label:team.name,action:()=>go(team.id)});
 $('content').innerHTML=`<form id="newMatchForm"><p class="help">Enter the match details first. Choose your lineup and first server when the live set opens.</p>
  <div class="grid"><label>Opponent<input id="newMatchOpponent" required maxlength="100" autocomplete="off"></label>
   <label>Match date<input id="newMatchDate" type="date" required value="${date}"></label>
   <label>Match format<select id="newMatchBestOf"><option value="3">Best of 3</option><option value="5">Best of 5</option></select></label></div>
  <div class="actions form-actions"><button type="submit" class="primary">Create match · choose lineup</button><button type="button" id="cancelNewMatch">Cancel</button></div></form>`;
 $('cancelNewMatch').onclick=()=>go(team.id);
 $('newMatchForm').onsubmit=e=>{e.preventDefault();
  const opponent=$('newMatchOpponent').value.trim();
  if(!opponent){$('newMatchOpponent').setCustomValidity('Enter the opponent name.');$('newMatchOpponent').reportValidity();$('newMatchOpponent').setCustomValidity('');return;}
  if(!$('newMatchDate').reportValidity())return;
  save(async()=>{
   const entry={id:identity(),opponent,date:$('newMatchDate').value,bestOf:Number($('newMatchBestOf').value)};
   const updated=validateTeam({...team,revision:team.revision+1,plannedMatches:[...team.plannedMatches,entry]});
   await withFreshStore(()=>store.saveTeam(updated,team.revision));
   dirty=false;location.href=`./index.html?setup=1&team=${encodeURIComponent(team.id)}&match=${encodeURIComponent(entry.id)}`;
  });
 };
 $('newMatchOpponent').focus();
}
window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
// Let committed navigation leave normally.
window.addEventListener('pagehide',()=>store?.close());
try{notice('Opening saved teams…');store=await openSetStore();notice('Reading saved teams…');await load();home();notice();}catch(e){notice(e.message,true);$('content').innerHTML='<button id="retry">Retry loading teams</button>';$('retry').onclick=()=>location.reload();}
