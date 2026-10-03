import { openSetStore } from '../storage/indexeddb.mjs';
import { practiceStats, practiceEventLabel, recordPracticeResult, undoPracticeResult } from './practice-model.mjs';
import { PLAYER_PERFORMANCE_HEADERS, playerPerformanceCells } from '../app/player-performance.mjs';
import { registerApp } from '../app/pwa.mjs';

registerApp();
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id=new URLSearchParams(location.search).get('id');
let store,practice,busy=false;
const actionQueue=[];

function notice(message='',error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('reloadPractice').hidden=!error;}
async function withFreshStore(work){
  try{return await work();}
  catch(error){
    if(error?.name!=='InvalidStateError'||!/database connection is closing/i.test(error.message))throw error;
    store?.close();
    store=await openSetStore();
    return work();
  }
}
function player(playerId){return practice.players.find(p=>p.id===playerId);}
function formatTime(value){return new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
function returnToTeam(){location.href=practice?`./teams.html#team=${encodeURIComponent(practice.teamId)}`:'./teams.html';}

function render(){
  $('pageContext').textContent=practice.teamName;
  $('pageTitle').textContent=`Practice · ${practice.date}`;
  $('backLabel').textContent=practice.teamName;
  document.title=`Practice · ${practice.teamName}`;
  const events=practice.events.slice(-1).reverse();
  const stats=new Map(practiceStats(practice).map(row=>[row.player.id,row]));
  const summaryRows=practice.players.map(p=>{
    const {serves,passes,attacks}=stats.get(p.id);
    const serveAttempts=serves.ace+serves.in+serves.error;
    const cells=playerPerformanceCells({
      passing:{count:passes.total,sum:passes.sum},
      serving:{attempts:serveAttempts,in:serves.ace+serves.in},
      attacking:{kills:attacks.kill,in:attacks.in,error:attacks.error,total:attacks.total},
    });
    return `<tr><th scope="row">#${esc(p.jersey)} ${esc(p.name)}</th>${cells}</tr>`;
  }).join('');
  $('practiceSummaryContent').innerHTML=`<p class="practice-summary-key">Hitting % = (kills − errors) ÷ all attacks, shown in standard volleyball decimal form. In is a non-terminal attempt. Serve-in % includes aces. Pass 0 is pass quality, not an error.</p><div class="practice-summary-table-scroll"><table class="practice-summary-table player-performance-table"><thead><tr><th>Player</th>${PLAYER_PERFORMANCE_HEADERS}</tr></thead><tbody>${summaryRows}</tbody></table></div>`;
  $('content').innerHTML=`<div class="practice-intro"><div class="practice-intro-copy"><h2>${esc(practice.teamName)} practice</h2><span class="muted">${practice.events.length} results saved</span></div><div class="practice-controls"><button type="button" id="practiceSummary">Practice summary</button><button type="button" id="undoPractice" class="undo-practice" ${practice.events.length&&!busy?'':'disabled'}>Undo last</button></div></div>
    <p class="practice-hint">Tap a result to record it. Pass 0 is pass quality only; Attack In records a non-terminal attack.</p>
    <section class="player-practice-list" aria-label="Player practice tracking">${practice.players.map(p=>{
      const label=`#${esc(p.jersey)} · ${esc(p.name)}`;
      return `<article class="player-practice card">
        <div class="player-practice-heading"><h2>${label}</h2></div>
        <div class="player-skills">
          <section class="player-skill"><h3>Serving</h3><div class="result-buttons serve-buttons" aria-label="Serving results for ${label}">
            <button type="button" data-skill="serve" data-player="${esc(p.id)}" data-result="ace" aria-label="Record ace for ${label}">Ace</button>
            <button type="button" data-skill="serve" data-player="${esc(p.id)}" data-result="in" aria-label="Record serve in for ${label}">In</button>
            <button type="button" data-skill="serve" data-player="${esc(p.id)}" data-result="error" aria-label="Record serve error for ${label}">Error</button>
          </div></section>
          <section class="player-skill"><h3>Serve receive</h3><div class="result-buttons pass-buttons" aria-label="Serve receive ratings for ${label}">
            ${[3,2,1,0].map(rating=>`<button type="button" data-skill="pass" data-player="${esc(p.id)}" data-result="${rating}" aria-label="Record pass ${rating} for ${label}">${rating}</button>`).join('')}
          </div></section>
          <section class="player-skill"><h3>Attacking</h3><div class="result-buttons attack-buttons" aria-label="Attacking results for ${label}">
            <button type="button" data-skill="attack" data-player="${esc(p.id)}" data-result="kill" aria-label="Record attack kill for ${label}">Kill</button>
            <button type="button" data-skill="attack" data-player="${esc(p.id)}" data-result="in" aria-label="Record attack in for ${label}">In</button>
            <button type="button" data-skill="attack" data-player="${esc(p.id)}" data-result="error" aria-label="Record attack error for ${label}">Error</button>
          </div></section>
        </div>
      </article>`;
    }).join('')}</section>
    <details class="practice-history"><summary>Last result</summary>${events.length?`<div class="practice-events">${events.map(event=>{
      const p=player(event.playerId);
      return `<div class="practice-event"><strong>#${esc(p.jersey)} · ${esc(p.name)}</strong><span>${esc(practiceEventLabel(event))}</span><time>${formatTime(event.occurredAt)}</time></div>`;
    }).join('')}</div>`:'<p class="muted">Results you record will appear here.</p>'}</details>`;
  document.querySelectorAll('[data-skill][data-player][data-result]').forEach(button=>button.onclick=()=>record({skill:button.dataset.skill,playerId:button.dataset.player,result:button.dataset.result}));
  $('practiceSummary').onclick=()=> $('practiceSummaryDialog').showModal();
  $('undoPractice').onclick=undoLast;
  $('backButton').onclick=returnToTeam;
}

function record(action){
  actionQueue.push({...action,result:action.skill==='pass'?Number(action.result):action.result});
  void processQueue();
}

function undoLast(){
  actionQueue.push({undo:true});
  void processQueue();
}

async function processQueue(){
  if(busy)return;
  busy=true;
  let savedMessage='Saved on this device.';
  const undoButton=$('undoPractice');
  if(undoButton)undoButton.disabled=true;
  try{
    while(actionQueue.length){
      const action=actionQueue.shift();
      if(action.undo){
        if(!practice.events.length)continue;
        const removedEvent=practice.events[practice.events.length-1];
        notice('Saving undo…');
        const next=undoPracticeResult(practice);
        await withFreshStore(()=>store.savePractice(next,practice.revision));
        const removedPlayer=player(removedEvent.playerId);
        savedMessage=`Undid ${practiceEventLabel(removedEvent)} for #${removedPlayer.jersey} · ${removedPlayer.name}.`;
        practice=next;render();
      }else{
        notice('Saving result…');
        const next=recordPracticeResult(practice,action);
        await withFreshStore(()=>store.savePractice(next,practice.revision));
        const savedEvent=next.events[next.events.length-1];
        const savedPlayer=player(savedEvent.playerId);
        savedMessage=`Saved ${practiceEventLabel(savedEvent)} for #${savedPlayer.jersey} · ${savedPlayer.name}.`;
        practice=next;render();
      }
    }
    notice(savedMessage);
  }catch(error){
    actionQueue.length=0;
    render();
    notice(error.message,true);
  }finally{
    busy=false;
    const undoButton=$('undoPractice');
    if(undoButton)undoButton.disabled=practice.events.length===0;
    if(actionQueue.length)void processQueue();
  }
}

async function start(){
  if(!id){
    $('pageContext').textContent='Practice tracking';$('pageTitle').textContent='Start a practice';
    $('backLabel').textContent='Teams';document.title='Start a practice · Volleyball';
    $('content').innerHTML='<div class="card"><h2>Choose a team to begin</h2><p>Practice results are saved with a team roster. Open a team, then choose New practice.</p><div class="actions"><button id="openTeams" type="button" class="primary">Open Teams</button></div></div>';
    $('openTeams').onclick=()=>{location.href='./teams.html';};
    notice('Open or create a team before starting practice.');return;
  }
  try{store?.close();store=await openSetStore();practice=await withFreshStore(()=>store.getPractice(id));render();notice('Practice ready. Each result saves automatically.');}
  catch(error){notice(error.message,true);}
}
function reloadPractice(){notice('Reloading saved practice…');start();}
$('backButton').onclick=returnToTeam;
$('teamsLink').onclick=()=>{location.href='./teams.html';};
$('reloadPractice').onclick=reloadPractice;
$('closePracticeSummary').onclick=()=> $('practiceSummaryDialog').close();
$('practiceSummaryDialog').addEventListener('click',event=>{
  if(event.target===$('practiceSummaryDialog'))$('practiceSummaryDialog').close();
});
window.addEventListener('pagehide',()=>store?.close());
start();
