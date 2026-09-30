import { openSetStore } from '../storage/indexeddb.mjs';
import { practiceStats, practiceEventLabel, recordPracticeResult, undoPracticeResult } from './practice-model.mjs';
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
  const events=practice.events.slice(-12).reverse();
  const stats=new Map(practiceStats(practice).map(row=>[row.player.id,row]));
  $('content').innerHTML=`<div class="practice-intro"><h2>${esc(practice.teamName)} practice</h2><span class="muted">${practice.events.length} results saved on this device</span></div>
    <p class="practice-hint">Tap a result to log it. Aces count as serves in.</p>
    <section class="player-practice-list" aria-label="Player practice tracking">${practice.players.map(p=>{
      const {serves,passes}=stats.get(p.id);
      const attempts=serves.ace+serves.in+serves.error;
      const successful=serves.ace+serves.in;
      const passAverage=passes.total?(passes.sum/passes.total).toFixed(2):'—';
      const servePercent=attempts?`${Math.round(successful*100/attempts)}%`:'—';
      const label=`#${esc(p.jersey)} · ${esc(p.name)}`;
      const canUndo=practice.events.some(event=>event.playerId===p.id);
      return `<article class="player-practice card">
        <div class="player-practice-heading"><h2>${label}</h2><button type="button" class="player-undo" data-undo-player="${esc(p.id)}" ${canUndo?'':'disabled'} aria-label="Undo latest result for ${label}">Undo</button></div>
        <div class="player-summary"><span>Pass avg <strong>${passAverage}</strong><small>n=${passes.total}</small></span><span>Serve in <strong>${servePercent}</strong><small>n=${attempts}</small></span></div>
        <div class="player-skills">
          <section class="player-skill"><h3>Serving</h3><div class="result-buttons serve-buttons" aria-label="Serving results for ${label}">
            <button type="button" data-skill="serve" data-player="${esc(p.id)}" data-result="ace" aria-label="Record ace for ${label}">Ace</button>
            <button type="button" data-skill="serve" data-player="${esc(p.id)}" data-result="in" aria-label="Record serve in for ${label}">In</button>
            <button type="button" data-skill="serve" data-player="${esc(p.id)}" data-result="error" aria-label="Record serve error for ${label}">Error</button>
          </div></section>
          <section class="player-skill"><h3>Serve receive</h3><div class="result-buttons pass-buttons" aria-label="Serve receive ratings for ${label}">
            ${[3,2,1,0].map(rating=>`<button type="button" data-skill="pass" data-player="${esc(p.id)}" data-result="${rating}" aria-label="Record pass ${rating} for ${label}">${rating}</button>`).join('')}
          </div></section>
        </div>
      </article>`;
    }).join('')}</section>
    <details class="practice-history"><summary>Recent results (${practice.events.length})</summary>${events.length?`<div class="practice-events">${events.map(event=>{
      const p=player(event.playerId);
      return `<div class="practice-event"><strong>#${esc(p.jersey)} · ${esc(p.name)}</strong><span>${esc(practiceEventLabel(event))}</span><time>${formatTime(event.occurredAt)}</time></div>`;
    }).join('')}</div>`:'<p class="muted">Results you record will appear here.</p>'}</details>`;
  document.querySelectorAll('[data-skill][data-player][data-result]').forEach(button=>button.onclick=()=>record({skill:button.dataset.skill,playerId:button.dataset.player,result:button.dataset.result}));
  document.querySelectorAll('[data-undo-player]').forEach(button=>button.onclick=()=>undo(button.dataset.undoPlayer));
  $('backButton').onclick=returnToTeam;
  $('teamsLink').onclick=returnToTeam;
}

function record(action){
  actionQueue.push({...action,result:action.skill==='pass'?Number(action.result):action.result});
  void processQueue();
}

function undo(playerId){
  actionQueue.push({undo:true,playerId});
  void processQueue();
}

async function processQueue(){
  if(busy)return;
  busy=true;
  try{
    while(actionQueue.length){
      const action=actionQueue.shift();
      if(action.undo){
        if(!practice.events.some(event=>event.playerId===action.playerId))continue;
        notice('Saving undo…');
        const next=undoPracticeResult(practice,action.playerId);
        await withFreshStore(()=>store.savePractice(next,practice.revision));
        practice=next;render();
      }else{
        notice('Saving result…');
        const next=recordPracticeResult(practice,action);
        await withFreshStore(()=>store.savePractice(next,practice.revision));
        practice=next;render();
      }
    }
    notice('Saved on this device.');
  }catch(error){
    actionQueue.length=0;
    render();
    notice(error.message,true);
  }finally{
    busy=false;
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
$('teamsLink').onclick=returnToTeam;
$('reloadPractice').onclick=reloadPractice;
window.addEventListener('pagehide',()=>store?.close());
start();
