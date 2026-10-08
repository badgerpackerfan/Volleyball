import { matchWinner, orderMatchSets, isExhibitionSet, setPlan, teamHierarchy } from '../teams/match-model.mjs';
import { FORMATIONS } from './formations.mjs';
import { checkCommand, lineupSetupLocked, replaySet } from '../engine/set-engine.mjs';
import { receiveLayoutError } from '../engine/receive-layout.mjs';
import { openSetStore, StorageConflict } from '../storage/indexeddb.mjs';
import { SetSession } from './session.mjs';
import { makeMatchSet, validateTeam } from '../teams/team-model.mjs';
import { lineupFromSet, lineupIssue, startingRotation, validateLineup } from '../teams/lineup-model.mjs';
import { mountLineupEditor } from '../teams/lineup-editor.mjs';
import { registerApp, keepAwake } from './pwa.mjs';
registerApp();
import { rotationReport, lineupSheet, editRallies, fixScore, matchSummary, settingsSheet } from './team-menu.mjs';
import { loadSettings, applyColorTheme, saveSettings } from './themes.mjs';
import { normalizeOpponentScout, opponentScoutHasInfo, mountOpponentScoutEditor } from '../teams/opponent-scout.mjs';
let session, store, saving = false, failedCommand = null, MATCH_RECORDS = [];
let setupLocked = false, setupContext = null;
let SETTINGS = loadSettings();
let ACTIVE_THEME = null;
let OPPONENT_SCOUT = null;

/* ---------------- Demo data ---------------- */
let TEAM_NAMES = { us: '8th Grade', them: 'West Fargo' };
let ROSTER = {
  5:  { n: 'Avery K.',  r: 'S'   },
  25: { n: 'Maya R.',   r: 'RS'  },
  2:  { n: 'Jordan L.', r: 'MB'  },
  29: { n: 'Tess H.',   r: 'MB'  },
  1:  { n: 'Riley P.',  r: 'OH'  },
  12: { n: 'Kenzie D.', r: 'DS'  },
  8:  { n: 'Sam W.',    r: 'OH'  },
  22: { n: 'Brooke N.', r: 'L'   },
  3:  { n: 'Ella M.',   r: 'L'   },
  14: { n: 'Nora B.',   r: 'OH'  },
  17: { n: 'Paige T.',  r: 'MB'  },
  9:  { n: 'Lily C.',   r: 'DS'  },
};
let LIBEROS = [22, 3];
// Offensive system decides which setter is "the setter" right now:
//   5-1: the one setter, wherever she is (S1-S6)
//   6-2: two setters opposite each other; the back-row one sets (S1, S6, S5)
//   4-2: two setters opposite each other; the front-row one sets (S4, S3, S2)
let SYSTEM = '6-2';
let SETTERS = { '5-1': [5], '6-2': [5, 25], '4-2': [5, 25] };
// Lineup slot = starting position. Color by the slot's role; opposite slots share one.
let SLOTS = {
  1: { start: 5,  role: 'set' },
  2: { start: 1,  role: 'oh'  },
  3: { start: 2,  role: 'mid' },
  4: { start: 25, role: 'set' },
  5: { start: 12, role: 'oh',  plan: { front: 8, back: 12 } },
  6: { start: 29, role: 'mid' },
};
let SUB_LIMIT = 18;
// Names for records created by the first sample-only build, which stored no display names.
const LEGACY_ROSTER = structuredClone(ROSTER);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let playerNumbers=new Map();
const numberFor=id=>playerNumbers.get(id);
const playerId=number=>ROSTER[number]?.id;
function configureLive(record, savedTeam=null) {
  const c=record.config;
  ACTIVE_THEME=savedTeam?.teamTheme||c.teamTheme||'evergreen';
  SYSTEM=c.system;SUB_LIMIT=c.rules.substitutionLimit;SET_TARGET=c.rules.target;
  TEAM_NAMES={us:c.teamName || '8th Grade',them:c.opponentName || 'West Fargo'};
  OPPONENT_SCOUT=normalizeOpponentScout(c.opponentScout);
  playerNumbers=new Map(c.players.map(p=>[p.id,Number(p.jersey)]));
  ROSTER=Object.fromEntries(c.players.map(p=>[Number(p.jersey),{id:p.id,n:esc(p.name || LEGACY_ROSTER[p.jersey]?.n || `Player ${p.jersey}`),r:p.position || LEGACY_ROSTER[p.jersey]?.r || 'OH',available:p.available}]));
  LIBEROS=c.liberos.map(numberFor);SETTERS={[SYSTEM]:c.setters.map(numberFor)};
  SLOTS=Object.fromEntries(c.slots.map(slot=>{const start=numberFor(slot.playerId);return [slot.id,{start,
    role:c.setters.includes(slot.playerId)?'set':ROSTER[start].r==='MB'?'mid':'oh',
    ...(slot.plan?{plan:{front:numberFor(slot.plan.frontPlayerId),back:numberFor(slot.plan.backPlayerId)}}:{})}];}));
  $('teamMenu').innerHTML=`${savedTeam?.logo?`<img class="team-logo-mini" src="${esc(savedTeam.logo)}" alt="">`:''}<span>${esc(TEAM_NAMES.us)}</span><span class="caret">▾</span>`;
  const opponentMenu=$('opponentMenu');
  if(opponentMenu)opponentMenu.innerHTML=`<span>${esc(TEAM_NAMES.them)}</span><span class="caret">▾</span>`;
  for(const id of ['pastSetsUs','pastSetsThem']) $(id).setAttribute('aria-label',`Previous sets, ${TEAM_NAMES.us}–${TEAM_NAMES.them} score order`);
}
let PAST_SETS = [];
const setsRecord = () => `${PAST_SETS.filter(s => s.us > s.them).length}–${PAST_SETS.filter(s => s.us < s.them).length}`;
const pastSetsStr = () => PAST_SETS.map(s => `${s.us}–${s.them}`).join(' · ');

const EARNED = ['SA', 'K', 'BK'];
const ERRORS = ['SE', 'HE', 'OE', 'SrE', 'NET', 'VIO'];
const WORD = {
  K: 'Kill', BK: 'Block', SA: 'Ace', HE: 'Hitting<br>Error', SE: 'Serve<br>Error', OE: 'Other<br>Error', SrE: 'Receive<br>Error',
  BKE: 'Block<br>Error', BHE: 'Ball<br>Handling<br>Error', DigE: 'Dig<br>Error', NET: 'Net /<br>Line', VIO: 'Other<br>Violation',
};
const words = () => document.body.classList.contains('words');
const codeName = c => (words() ? WORD[c].replaceAll('<br>', ' ') : c);
const LABEL = {
  K: 'Kill', BK: 'Block', SA: 'Ace', HE: 'Hitting err', SE: 'Serve err', OE: 'Other error', SrE: 'Receive err',
  BKE: 'Block err', BHE: 'Ball handling', DigE: 'Dig err', NET: 'Net / line', VIO: 'Other violation',
};

/* Serving and serve-receive spots copied from volleyball-rotations.html ("Where do I go?").
   Same 360 x 360 grid: x across, y back from the net, attack line at y = 120;
   a coordinate is the top-left of a 48-unit player dot. Rotations come in
   pairs keyed by where the back-row setter stands (P1, P6, P5). "start" says
   which role stands in which rotational position, so we can map each role to
   the player actually standing there. */
const RECEIVE_KEY = { 1: '1,4', 6: '2,5', 5: '3,6' };   // back-row setter position -> pair
// Court-positioning pairs each rotation with the one opposite it after a lap.
const ROTATION_KEY = { 1: '1,4', 4: '1,4', 2: '2,5', 5: '2,5', 3: '3,6', 6: '3,6' };
const PASS_LABEL = { OH: 'OH passes', RS: 'RS passes' };
const PASS_RATINGS = [[3,'Perfect','All attack options'],[2,'Playable','Some attack options'],
  [1,'High ball','Limited attack'],[0,'No play','Overpass or forced free ball']];
const SERVE_TIP = 'Server steps behind the end line. The other five cover the court.';

// Rotational position of a point on the 360 grid (row by the attack line, column by thirds).
function gridPos(x, y) {
  const col = x < 120 ? 0 : x < 240 ? 1 : 2;
  return y < 120 ? [4, 3, 2][col] : [5, 6, 1][col];
}

function mappedSpots(rot, frame) {
  const spots = {};
  for (const id in frame) {
    const [sx, sy] = rot.start[id], [x, y0] = frame[id];
    const y = Math.min(y0, 336); // the serving spot sits just behind the end line
    spots[slotAt(gridPos(sx, sy))] = { left: (x + 24) / 360 * 100, top: (y + 24) / 360 * 100 };
  }
  return spots;
}

function baseDefenseLayout() {
  const activeSetterPos=setterPos();
  const backRowSetterPos=activeSetterPos && isFront(activeSetterPos)
    ? (activeSetterPos + 2) % 6 + 1 : activeSetterPos;
  const key = RECEIVE_KEY[backRowSetterPos] || ROTATION_KEY[rotNum()];
  const rot = FORMATIONS[key];
  return rot?.base ? { key, spots: mappedSpots(rot, rot.base) } : null;
}

// The formation for the current moment: serve receive when they serve, the
// serving spots when we serve. slot -> { left, top } (% of the court, center
// of the dot). The formation is looked up even when the coach has flipped to
// rotation spots, so the bar can still offer the passer choice.
function formation(forceReceive = false) {
  // Live receive spots are defined for back-row setters. In timeout planning,
  // forceReceive can use the matching opposite-rotation diagram as well.
  const base = baseDefenseLayout();
  const key = RECEIVE_KEY[setterPos()] || (forceReceive ? base?.key : null);
  if (!key) return { none: true, base };
  const rot = FORMATIONS[key];
  const receiving = forceReceive || S.serving === 'them';
  let frame, tip, options = [], passer = null;
  if (receiving) {
    options = Object.keys(rot.passing);
    const selectedPasser = forceReceive && ui.timeoutMode ? ui.timeoutPasser : ui.passer;
    passer = options.includes(selectedPasser) ? selectedPasser : (options.includes('RS') ? 'RS' : options[0]);
    frame = rot.passing[passer].receive;
    tip = rot.passing[passer].passers;
  } else {
    frame = rot.serve;
    tip = SERVE_TIP;
  }
  const spots = mappedSpots(rot, frame);
  const editKey = `${SYSTEM}:${rotNum()}:${setterPos()}:${passer}`;
  if (receiving && receiveEdits[editKey]) {
    for (let pos = 1; pos <= 6; pos++) spots[slotAt(pos)] = { ...receiveEdits[editKey][pos] };
  }
  return { receiving, options, passer, tip, spots, editKey, base };
}

function timeoutSpots(form, view = ui.timeoutView) {
  const defaults = view === 'defense' ? form.base?.spots : form.spots;
  return defaults ? { ...defaults, ...(ui.timeoutPositions?.[view] || {}) } : null;
}

// Timeout receive layouts are keyed by lineup slot for drawing, while the
// receive legality rules are expressed in current court positions (P1–P6).
function timeoutReceiveLayout(spots) {
  return Object.fromEntries([1, 2, 3, 4, 5, 6].map(pos => [pos, { ...spots[slotAt(pos)] }]));
}
function timeoutReceiveError(spots, slot, target) {
  const layout = timeoutReceiveLayout(spots);
  layout[posOf(Number(slot))] = target;
  return receiveLayoutError(layout);
}

/* ---------------- State ---------------- */
let S, history, ui;
let receiveEdits = {};
let editingReceive = false, receiveDrag = null, tacticalDrag = null, attackReturnTimer = null;
async function saveReceiveEdits() {
  const key = formation().editKey;
  return perform({ type: 'receive.edit', payload: { key, positions: receiveEdits[key] || null } }, false);
}

const clone = o => JSON.parse(JSON.stringify(o));
const other = t => (t === 'us' ? 'them' : 'us');
const posOf = slot => S.order.indexOf(+slot) + 1;
const slotAt = pos => S.order[pos - 1];
const isFront = pos => pos >= 2 && pos <= 4;
const server = () => S.onCourt[slotAt(1)];
const rotNum = () => S.rotation;
// Court position of whoever is setting under the current system, or null.
function setterPos() {
  const at = SETTERS[SYSTEM]
    .map(p => Object.keys(S.onCourt).find(k => S.onCourt[k] === p))
    .filter(Boolean).map(posOf);
  if (SYSTEM === '5-1') return at[0] || null;
  return at.find(pos => (SYSTEM === '6-2') !== isFront(pos)) || null;
}
const rotLabel = () => `R${rotNum()} · ${setterPos() ? 'S' + setterPos() : 'S–'}`;


/* ---------------- Engine ---------------- */
function command(type, payload, clear = true) { return perform({type, payload}, clear); }
async function selectReceive(passer) {
  if(receiveDrag) return;
  ui={...ui,pendingCode:null,pendingSlot:null,pendingAttackResult:null,attackPlayerSlot:null,attackTargetZone:null,
    themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false};
  if(await command('receive.select',{passer})) {ui.showBase=false;render();}
}
function commit(team, code, player, details = {}) {
  return command('rally', {team, code, playerId: player == null ? null : playerId(player), ...details});
}
function recordOurAttack(result, slot=ui.attackPlayerSlot) {
  const targetZone=ui.attackTargetZone;
  if(slot==null)return;
  const jersey=S.onCourt[slot], rosterId=playerId(jersey);
  if(!rosterId)return;
  if(result==='in') return command('attack.attempt',{team:'us',playerId:rosterId,
    ...(targetZone==null?{}:{targetZone})});
  return commit('us',result==='kill'?'K':'HE',jersey,
    targetZone==null?{}:{attackTargetZone:targetZone});
}
function recordOpponentAttack(result, sourceZone=ui.themAttackSourceZone, targetZone=ui.themAttackTargetZone) {
  if(sourceZone==null)return;
  if(result==='in') return command('attack.attempt',{team:'them',sourceZone,
    ...(targetZone==null?{}:{targetZone})});
  return commit('them',result==='kill'?'K':'HE',null,{attackSourceZone:sourceZone,
    ...(targetZone==null?{}:{attackTargetZone:targetZone})});
}
function recordOpponentReceiveError(serveTargetZone) {
  return commit('them','SrE',null,{serveTargetZone});
}
function doSub(slot, pIn, reason, planned = false) {
  return command('substitution', {slotId:String(slot), outPlayerId:playerId(S.onCourt[slot]), inPlayerId:playerId(pIn), planned,
    ...(reason ? {override:{reason}} : {})});
}
function subBlocked(pIn, pOut) {
  const slot = Object.keys(S.onCourt).find(k => S.onCourt[k] === pOut);
  return checkCommand(session.record, {type:'substitution',payload:{slotId:slot,outPlayerId:playerId(pOut),inPlayerId:playerId(pIn)}}).error?.message || null;
}
function liberoIn(slot, lib) {
  return command('libero.in', {slotId:String(slot),outPlayerId:playerId(S.onCourt[slot]),inPlayerId:playerId(lib)});
}
function liberoOut() { return command('libero.out', {outPlayerId:playerId(S.libero.player)}); }
function liberoSwitch(lib) { return command('libero.switch', {outPlayerId:playerId(S.libero.player),inPlayerId:playerId(lib)}); }

function syncState() {
  const s = session.state;
  SYSTEM = session.record.config.system;
  const actionsById=new Map(session.record.actions.map(action=>[action.id,action]));
  const activeActions=s.activeActionIds.map(id=>actionsById.get(id)).filter(Boolean);
  let lastRallyIndex=-1;
  activeActions.forEach((action,index)=>{if(action.type==='rally')lastRallyIndex=index;});
  const currentRallyActions=activeActions.slice(lastRallyIndex+1);
  const passRatedThisRally=currentRallyActions.some(action=>action.type==='receive.rating');
  // Once either side's first in-play attack is logged, the next touch can
  // come back to us. Keep the court on base defense through the remainder of
  // this rally regardless of which team made that first attack.
  const attackTrackedThisRally=currentRallyActions.some(action=>action.type==='attack.attempt');
  const rallies=s.rallies.map(r=>({rot:`R${r.rotation} · S${r.setterPosition ?? '–'}`,rotN:r.rotation,srv:r.servingTeam,
    sv:r.serverId===null ? null : numberFor(r.serverId),bk:r.backRowPlayerIds.map(numberFor),team:r.team,code:r.code,
    player:r.playerId===null ? null : numberFor(r.playerId),attackSourceZone:r.attackSourceZone??null,
    attackTargetZone:r.attackTargetZone??null,serveTargetZone:r.serveTargetZone??null,
    us:r.score.us,them:r.score.them,winner:r.winner,actionId:r.actionId}));
  const timeouts=s.timeouts.map(t=>({team:t.team,us:t.score.us,them:t.score.them,actionId:t.actionId}));
  const visibleEvents=new Map([
    ...rallies.map(r=>[r.actionId,{kind:'rally',...r}]),
    ...timeouts.map(t=>[t.actionId,{kind:'timeout',...t}]),
  ]);
  const timeline=s.activeActionIds.flatMap(id=>visibleEvents.has(id)?[visibleEvents.get(id)]:[]);
  S = { order:s.order.map(Number), onCourt:Object.fromEntries(Object.entries(s.onCourt).map(([k,v])=>[k,numberFor(v)])),
    libero:s.libero ? {slot:Number(s.libero.slotId), player:numberFor(s.libero.playerId),replaced:numberFor(s.libero.replacedPlayerId)} : null,
    partner:Object.fromEntries(Object.entries(s.partners).map(([k,v])=>[numberFor(k),v.length===1 ? numberFor(v[0]) : null])),
    rotations:s.rotations, rotation:s.rotation, serving:s.servingTeam, us:s.score.us, them:s.score.them,
    subs:s.substitutionsUsed, toUs:s.timeoutsRemaining.us, toThem:s.timeoutsRemaining.them, liberoFor:s.liberoFor,
    liberoPlanChosen:activeActions.some(action=>action.type==='libero.plan'),
    rallies,timeouts,timeline,passRatedThisRally,attackTrackedThisRally,
    banners:s.prompts.filter(p=>p.type==='planned-swap').map(p=>({kind:'swap',slot:Number(p.slotId),in:numberFor(p.inPlayerId),
      out:numberFor(p.outPlayerId),text:`Planned swap: #${numberFor(p.inPlayerId)} in for #${numberFor(p.outPlayerId)}`,sub:'Confirm when the players exchange.'})) };
  if (LIBEROS.length && !s.libero && s.liberoFor !== 'none' && SLOTS[S.order[0]].role === s.liberoFor && s.status === 'live')
    S.banners.push({kind:'libero',slot:S.order[0],text:`Libero in for #${S.onCourt[S.order[0]]}?`});
  receiveEdits = clone(s.receiveEdits);
  if(ui) ui.passer=s.receivePasser;
  history = activeActions.map(action=>({desc:actionLabel(action)}));
}
function actionLabel(a) {
  if(a.type==='rally') {
    const zones=`${a.payload.attackSourceZone?` Z${a.payload.attackSourceZone}`:''}${a.payload.attackTargetZone?` → Z${a.payload.attackTargetZone}`:''}${a.payload.serveTargetZone?` · Serve Z${a.payload.serveTargetZone}`:''}`;
    return `${TEAM_NAMES[a.payload.team]} ${a.payload.code}${a.payload.playerId ? ' #'+numberFor(a.payload.playerId) : ''}${zones}`;
  }
  if(a.type==='receive.rating') return `Pass #${numberFor(a.payload.playerId)} · ${a.payload.rating}`;
  if(a.type==='attack.attempt') {
    const isUs=(a.payload.team??'us')==='us';
    const source=isUs?`#${numberFor(a.payload.playerId)}`:`Z${a.payload.sourceZone}`;
    return `${isUs?'Attack':'Their attack'} ${source}${a.payload.targetZone?` → Z${a.payload.targetZone}`:''} · In play`;
  }
  if(a.type==='opponent.substitution') return `Opponent sub #${a.payload.inJersey} for #${a.payload.outJersey}`;
  return {'substitution':'Substitution','libero.in':'Libero in','libero.out':'Libero out','libero.switch':'Libero switch',
    'timeout':'Timeout','receive.edit':'Receive formation','receive.select':'Receive formation choice','libero.plan':'Libero plan','set.end':'End set',
    'rally.edit':a.payload.delete ? 'Deleted rally' : 'Rally edit','correction':'Score fix'}[a.type] || a.type;
}
function status(message, error=false) {
  $('saveStatus').textContent=message; $('saveStatus').classList.toggle('error',error);
}
function nextSetSetupHref(record) {
  const c=record.config,bestOf=c.bestOf;
  if(!bestOf)return null;
  const siblings=MATCH_RECORDS.map(r=>r.config.id===c.id?record:r);
  const nextSet=(c.setNumber??siblings.length)+1;
  if(nextSet>bestOf)return null;
  const wins={us:0,them:0};
  for(const sibling of siblings){
    const state=replaySet(sibling);
    if(state.status==='ended')wins[state.winner]++;
  }
  const decided=Boolean(matchWinner(wins,bestOf));
  const optionalThird=bestOf===3&&nextSet===3&&siblings.length===2&&decided;
  if(decided&&!optionalThird)return null;
  const route=new URLSearchParams({setup:'1',team:c.teamId,match:c.matchId});
  return `./index.html?${route}`;
}
async function perform(cmd, clear=true) {
  if(saving || failedCommand) return false;
  if(ui.timeoutMode) { status('Choose Done with timeout before recording another action.',true); return false; }
  if(editingReceive && !cmd.type.startsWith('receive.')) {status('Tap Done before recording another action.',true);return false;}
  saving=true; document.body.classList.add('saving'); status('Saving…');
  const pending = {...ui},wasEnded=session.state.status==='ended';
  let nextSetup=null;
  try {
    await session.run(cmd);
    if (cmd.type === 'timeout') {
      ui = { ...ui, pendingCode: null, pendingSlot: null, mode: null, showBase: false,
        pendingPassRating: null, pendingAttackResult: null, attackPlayerSlot: null, attackTargetZone: null,
        themAttackResult: null, themAttackSourceZone: null, themAttackTargetZone: null,pendingServeZone:false,
        timeoutMode: true, timeoutView: S.serving === 'them' ? 'receive' : 'defense',
        timeoutPasser: ui.passer, timeoutPositions: { receive: {}, defense: {} } };
    } else if (cmd.type === 'receive.rating' || cmd.type === 'attack.attempt') {
      ui = { ...ui, showBase: false };
    } else if (cmd.type === 'rally' || cmd.type === 'correction') {
      ui = { ...ui, timeoutMode: false, timeoutView: null, timeoutPasser: null, timeoutPositions: null, showBase: false };
      tacticalDrag = null;
    }
    if (['attack.attempt','rally','correction','substitution','libero.in','libero.out','libero.switch'].includes(cmd.type))
      ui = { ...ui, pendingAttackResult: null, attackPlayerSlot: null, attackTargetZone: null,
        themAttackResult: null, themAttackSourceZone: null, themAttackTargetZone: null };
    syncState();
    if(!wasEnded&&session.state.status==='ended')nextSetup=nextSetSetupHref(session.record);
    if(clear) { ui={...ui,pendingCode:null,pendingSlot:null,mode:null,pendingPassRating:null,pendingAttackResult:null,pendingServeZone:false}; $('sheet').classList.remove('open'); }
    status(session.state.status==='ended' ? 'Set ended · saved on this device' : 'Saved on this device');
    return true;
  } catch(e) {
    ui=pending; receiveEdits=clone(session.state.receiveEdits);
    status(`${e.message} Action not recorded.`,true);
    if(e.name !== 'EngineError') {
      failedCommand={cmd,clear}; document.body.classList.add('failed');
      $('retrySave').hidden=e instanceof StorageConflict;
      $('reloadSaved').hidden=false;
    }
    return false;
  } finally {
    saving=false; document.body.classList.remove('saving'); render();
    if(nextSetup)location.href=nextSetup;
  }
}

/* ---------------- Rendering ---------------- */
const $ = id => document.getElementById(id);

function codeBtn(team, code, kind) {
  const b = document.createElement('button');
  const pointUs = (team === 'us') === EARNED.includes(code);
  b.className = `code ${pointUs ? 'win' : 'lose'} ${EARNED.includes(code) ? 'solid earned' : 'tint'} ${kind || ''}`;
  b.innerHTML = `<b class="abbr">${code}</b><span class="cap">${LABEL[code]}</span><b class="word">${WORD[code]}</b>`;
  b.dataset.team = team; b.dataset.code = code;
  b.onclick = () => onCode(team, code);
  return b;
}

function buildPads() {
  const groups = [
    ['usServeActions', 'us', ['SA', 'SE']], ['usReceiveActions', 'us', ['SrE']],
    ['usOtherActions', 'us', ['BK', 'OE', 'NET', 'VIO']],
    ['themServeActions', 'them', ['SA', 'SE']], ['themReceiveActions', 'them', ['SrE']],
    ['themOtherActions', 'them', ['BK', 'OE', 'NET', 'VIO']],
  ];
  const teamButton = $('teamBtn');
  teamButton.remove();
  for (const [container, team, codes] of groups)
    codes.forEach(code => $(container).appendChild(codeBtn(team, code)));
  $('usOtherActions').appendChild(teamButton);
}

function possible(team, code) {
  if (code === 'SA' || code === 'SE') return S.serving === team;
  if (code === 'SrE') return S.serving !== team;
  return true;
}

function render() {
  $('scoreTeamUs').textContent = TEAM_NAMES.us;
  $('scoreTeamThem').textContent = TEAM_NAMES.them;
  const opponentMenu=$('opponentMenu');
  if(opponentMenu){
    opponentMenu.innerHTML=`<span>${esc(TEAM_NAMES.them)}</span><span class="caret">▾</span>`;
    opponentMenu.setAttribute('aria-label',`${TEAM_NAMES.them} opponent scouting${opponentScoutHasInfo(OPPONENT_SCOUT)?', information entered':' not entered'}`);
  }
  // Header
  $('subsVal').textContent = `${S.subs} / ${SUB_LIMIT}`;
  $('subsBar').className = 'bar' + (S.subs >= 15 ? ' warn' : '');
  $('subsBar').firstElementChild.style.width = (S.subs / SUB_LIMIT * 100) + '%';
  $('toU1').className = S.toUs >= 1 ? 'on' : ''; $('toU2').className = S.toUs >= 2 ? 'on' : '';
  $('toT1').className = S.toThem >= 1 ? 'on' : ''; $('toT2').className = S.toThem >= 2 ? 'on' : '';

  // Score
  $('scUs').textContent = S.us; $('scThem').textContent = S.them;
  $('sideUs').classList.toggle('serving', S.serving === 'us');
  $('sideThem').classList.toggle('serving', S.serving === 'them');
  const cur = rotNum();
  const inRot = S.rallies.filter(r => r.rot.startsWith('R' + cur + ' '));
  const w = inRot.filter(r => r.winner === 'us').length, l = inRot.length - w;
  const net = w - l;
  $('setsRec').textContent = setsRecord();
  $('pastSets').textContent = pastSetsStr();
  for (const [id, ourWin] of [['pastSetsUs', true], ['pastSetsThem', false]]) {
    $(id).innerHTML = PAST_SETS.map((s, i) => {
      const won = s.us > s.them;
      if (won !== ourWin) return '';
      return `<button type="button" class="set-result ${won ? 'won' : 'lost'}" data-set-summary-id="${esc(s.id)}" aria-label="View Set ${s.number} summary: ${esc(TEAM_NAMES.us)} ${s.us}, ${esc(TEAM_NAMES.them)} ${s.them}, ${won ? 'won' : 'lost'}"><span class="set-label">Set ${s.number}</span><strong>${s.us}–${s.them}</strong><span class="set-summary-hint" aria-hidden="true">View summary</span></button>`;
    }).join('');
    $(id).querySelectorAll('[data-set-summary-id]').forEach(button=>button.onclick=()=>matchSummary(menuContext,button.dataset.setSummaryId));
  }

  // Rotation +/- lives in the Recent rallies bar; colored boxes show runs.
  $('logMeta').innerHTML =
    `<span class="chip ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">R${cur} this set ${net > 0 ? '+' : ''}${net} (${w}–${l})</span>`;
  $('scoreBox').classList.toggle('crunch', crunch());

  // Court
  const court = $('court');
  if (!court.dataset.built) {
    court.innerHTML = '<div class="opponent-court-half"></div><div class="net"></div><div class="attack-line"></div><div class="attack-line opponent-attack-line"></div><div class="attack-zone-overlay" id="attackZoneOverlay" role="group" aria-label="Optional target zones on the opponent court" hidden></div><div class="attack-zone-overlay" id="themSourceZoneOverlay" role="group" aria-label="Opponent attack source zones" hidden></div><div class="attack-zone-overlay our-target-zone-overlay" id="themTargetZoneOverlay" role="group" aria-label="Optional opponent attack target zones on our court" hidden></div><div class="attack-zone-overlay" id="serveTargetZoneOverlay" role="group" aria-label="Our serve target zones on the opponent court" hidden></div><span class="court-mark"></span><div class="our-court-half"></div>';
    const zoneLabels={1:'back right',6:'back middle',5:'back left',2:'front right',3:'front middle',4:'front left'};
    const addZoneButtons=(overlay,attribute,zones,label)=>zones.forEach(zone=>{
      const button=document.createElement('button');
      button.type='button';button.dataset[attribute]=zone;
      button.setAttribute('aria-label',`${label} ${zone}${zoneLabels[zone]?`, ${zoneLabels[zone]}`:''}`);
      button.textContent=String(zone);
      overlay.appendChild(button);
    });
    addZoneButtons(court.querySelector('#attackZoneOverlay'),'usTarget',[1,6,5,2,3,4],'Target zone');
    addZoneButtons(court.querySelector('#themSourceZoneOverlay'),'themSource',[1,6,5,2,3,4],'Opponent attack source zone');
    addZoneButtons(court.querySelector('#themTargetZoneOverlay'),'themTarget',[4,3,2,5,6,1],'Opponent attack target zone');
    addZoneButtons(court.querySelector('#serveTargetZoneOverlay'),'serveTarget',[1,6,5,2,3,4],'Serve target zone');
    for (const slot in SLOTS) {
      const z = document.createElement('button');
      z.dataset.slot = slot;
      z.onclick = () => onTile(posOf(slot), +slot);
      court.querySelector('.our-court-half').appendChild(z);
    }
    court.dataset.built = '1';
  }
  const timeoutMode = Boolean(ui.timeoutMode), timeoutView = ui.timeoutView || (S.serving === 'them' ? 'receive' : 'defense');
  const form = formation(timeoutMode && timeoutView === 'receive');
  const autoBaseDefense=!timeoutMode&&!ui.showBase&&(S.passRatedThisRally||S.attackTrackedThisRally)&&Boolean(form?.base?.spots);
  const rcv = form && !form.none && !ui.showBase && !autoBaseDefense ? form : null;
  const activeSpots = timeoutMode ? timeoutSpots(form, timeoutView) : autoBaseDefense ? form.base.spots : rcv?.spots;
  const usAttackTargetMode=!timeoutMode&&(ui.pendingAttackResult!==null||ui.attackTargetZone!==null);
  const opponentAttackMode=!timeoutMode&&ui.themAttackResult!==null;
  const serveTargetMode=!timeoutMode&&ui.pendingServeZone;
  const attackTargetMode=usAttackTargetMode||opponentAttackMode||serveTargetMode;
  const wasAttackTargetMode=court.classList.contains('attack-target-mode');
  if(attackTargetMode){
    clearTimeout(attackReturnTimer);attackReturnTimer=null;
    court.classList.remove('attack-returning');
  }else if(wasAttackTargetMode){
    court.classList.add('attack-returning');
    clearTimeout(attackReturnTimer);
    attackReturnTimer=setTimeout(()=>{court.classList.remove('attack-returning');attackReturnTimer=null;},280);
  }
  court.classList.toggle('attack-target-mode',attackTargetMode);
  court.classList.toggle('opponent-attack-mode',opponentAttackMode);
  $('courtWrap').classList.toggle('attack-target-mode',attackTargetMode);
  if (!form.receiving || form.none || ui.showBase || autoBaseDefense) { editingReceive = false; $('receiveStatus').textContent = ''; }
  if (timeoutMode) $('receiveStatus').textContent = timeoutView === 'receive'
    ? 'Timeout · drag players to adjust serve receive. Legal order and spacing are enforced. Tap Done with timeout to return to the set.'
    : 'Timeout · drag players to adjust base defense. Tap Done with timeout to return to the set.';
  court.classList.toggle('editing', editingReceive);
  $('editReceive').disabled = timeoutMode || !form.receiving || form.none || autoBaseDefense;
  $('editReceive').hidden = timeoutMode || !form.receiving || form.none || autoBaseDefense;
  $('editReceive').textContent = editingReceive ? 'Done' : 'Adjust receive';
  $('editReceive').setAttribute('aria-pressed', String(editingReceive));
  $('resetReceive').hidden = timeoutMode || !editingReceive;
  const needPlayer = ui.pendingCode || ui.mode || ui.pendingPassRating !== null || ui.pendingAttackResult !== null || ui.attackTargetZone !== null || ui.attackPlayerSlot != null;
  [4, 3, 2, 5, 6, 1].forEach((pos, i) => {
    const slot = slotAt(pos), p = S.onCourt[slot], info = ROSTER[p] || { n: '', r: '' };
    const z = court.querySelector(`[data-slot="${slot}"]`);
    const isLib = S.libero && S.libero.slot === slot;
    let cls = `zone ${i < 3 ? 'front' : 'backrow'}`;
    if (rcv || timeoutMode) cls += ' rcv';
    if (timeoutMode) cls += ' tactical';
    if (ui.pendingSlot === slot || ui.attackPlayerSlot === slot) cls += ' selected';
    if (needPlayer) cls += canPick(pos, slot) ? ' pick' : ' nopick';
    z.className = cls;
    if (activeSpots) {
      // Hit area: a square around the dot, centered on the receive spot.
      const c = activeSpots[slot], h = 9;
      Object.assign(z.style, { left: c.left - h + '%', top: c.top - h + '%', width: 2 * h + '%', height: 2 * h + '%' });
    } else {
      // Tap areas split between the two rows of players (42%), not on the attack line.
      Object.assign(z.style, { left: (i % 3) * 33.333 + '%', top: i < 3 ? '0%' : '42%', width: '33.333%', height: i < 3 ? '42%' : '58%' });
    }
    const disc = `disc ${isLib ? 'lib' : SLOTS[slot].role}${!isFront(pos) && !isLib ? ' back' : ''}`;
    const plan = SLOTS[slot].plan;
    const swapTag = plan && !isLib && !rcv ? `<span class="swap-tag">⇄ #${S.onCourt[slot] === plan.back ? plan.front : plan.back}</span>` : '';
    const serving = !timeoutMode && !autoBaseDefense && pos === 1 && S.serving === 'us';
    z.innerHTML = `<span class="pos">P${pos}</span>
      <span class="dwrap"><span class="${disc}">${p}</span>${formMark(p,pos)}${serving ? '<span class="ball"><svg viewBox="0 0 512 512"><use href="#vb"/></svg></span>' : ''}${swapTag}</span>
      <span class="name">${info.n}<small>${info.r}</small></span>`;
  });

  // Court view (label on the court; controls in the Us pad)
  const mode = S.serving === 'them' ? 'SERVE RECEIVE' : 'SERVING';
  const viewTitle = timeoutMode ? `TIMEOUT · ${timeoutView === 'receive' ? 'SERVE RECEIVE' : 'BASE DEFENSE'}` : autoBaseDefense ? 'BASE DEFENSE' : !rcv ? 'ROTATION SPOTS' : mode;
  court.querySelector('.court-mark').textContent = `${viewTitle} · ${rotLabel().replace(' · ', ' · ')}`;
  const tools = document.querySelector('.court-tools'), inCourt = document.body.classList.contains('tools-in');
  if (inCourt && tools.parentElement !== court) court.appendChild(tools);
  if (!inCourt && tools.parentElement === court) $('courtWrap').appendChild(tools);
  tools.hidden=attackTargetMode;
  $('courtWrap').classList.toggle('serving', S.serving === 'us');
  $('rcvPassers').innerHTML = form && !form.none && form.options.length > 1
    ? form.options.map(o => `<button class="pill" data-pass="${o}" aria-pressed="${o === form.passer && !ui.showBase}">${PASS_LABEL[o]}</button>`).join('')
    : '';
  $('rcvPassers').querySelectorAll('[data-pass]').forEach(b => b.onclick = () => {
    if (timeoutMode) {
      if (ui.timeoutPasser !== b.dataset.pass) { ui.timeoutPasser = b.dataset.pass; ui.timeoutPositions.receive = {}; render(); }
    } else selectReceive(b.dataset.pass);
  });
  $('rcvPassers').hidden = autoBaseDefense || (timeoutMode && timeoutView !== 'receive');
  $('rcvToggle').hidden = timeoutMode;
  $('rcvToggle').textContent = 'Rotation spots';
  $('rcvToggle').setAttribute('aria-pressed', ui.showBase ? 'true' : 'false');
  $('rcvToggle').disabled = !!(form && form.none) && !timeoutMode && !autoBaseDefense;
  $('rcvToggle').title = autoBaseDefense ? 'Show the rotation spots' : form && form.none ? 'No formation yet for a front-row setter' : 'Show the rotation spots';
  $('timeoutTools').hidden = !timeoutMode;
  $('timeoutTools').querySelectorAll('[data-timeout-view]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.timeoutView === timeoutView));
    button.onclick = () => { ui.timeoutView = button.dataset.timeoutView; ui.pendingSlot = null; render(); };
  });

  // Pads
  for (const [padId, team] of [['padUs','us'],['padThem','them']]) {
    const serving = S.serving === team;
    $(padId).querySelector('.serve-panel').classList.toggle('inactive', !serving);
    $(padId).querySelector('.receive-panel').classList.toggle('inactive', serving);
  }
  document.querySelectorAll('.code').forEach(b => {
    const team = b.dataset.team, code = b.dataset.code;
    b.disabled = timeoutMode || editingReceive || session.state.status==='ended' || !possible(team, code);
    b.classList.toggle('pending', ui.pendingCode === code && team === 'us'
      || ui.pendingServeZone && team === 'them' && code === 'SrE');
  });
  const tb = $('teamBtn');
  const teamOk = ['OE','NET','VIO'].includes(ui.pendingCode);
  tb.disabled = timeoutMode || editingReceive || session.state.status==='ended' || !teamOk; tb.classList.toggle('ready', !!teamOk);
  tb.querySelector('small').textContent=teamOk?'Record without a player':'Select an error first';
  const recordedPass = passRatingForCurrentPoint();
  const passEnabled = S.serving === 'them' && !timeoutMode && !editingReceive
    && session.state.status !== 'ended' && !recordedPass && !ui.mode;
  $('passScoreGrid').innerHTML = PASS_RATINGS.map(([rating,title,description])=>
    `<button type="button" data-rating="${rating}" class="${ui.pendingPassRating===rating?'on':''}" aria-pressed="${ui.pendingPassRating===rating}" aria-label="Pass score ${rating}: ${title}, ${description}" title="${description}" ${passEnabled?'':'disabled'}><b>${rating}</b><span>${title}</span></button>`).join('');
  $('passScoreGrid').querySelectorAll('[data-rating]').forEach(button=>button.onclick=()=>{
    if(!passEnabled)return;
    const rating=Number(button.dataset.rating);
    ui={...ui,pendingCode:null,pendingSlot:null,pendingAttackResult:null,attackPlayerSlot:null,attackTargetZone:null,
      themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false,
      pendingPassRating:ui.pendingPassRating===rating?null:rating};
    render();
  });
  $('passScoreStatus').hidden=!recordedPass;
  if(recordedPass) $('passScoreStatus').textContent=`Recorded: #${numberFor(recordedPass.playerId)} · score ${recordedPass.rating} (Undo to change)`;
  const attackDisabled=timeoutMode||editingReceive||session.state.status==='ended'||!!ui.mode;
  const attackTargetOverlay=$('attackZoneOverlay');
  attackTargetOverlay.hidden=!usAttackTargetMode;
  attackTargetOverlay.querySelectorAll('[data-us-target]').forEach(button=>{
    const selected=Number(button.dataset.usTarget)===ui.attackTargetZone;
    button.setAttribute('aria-pressed',String(selected));
    button.disabled=attackDisabled;
    button.onclick=()=>{
      if(button.disabled)return;
      const zone=Number(button.dataset.usTarget);
      ui={...ui,pendingCode:null,pendingSlot:null,pendingPassRating:null,
        attackTargetZone:ui.attackTargetZone===zone?null:zone};
      render();
    };
  });
  document.querySelectorAll('[data-us-result]').forEach(button=>{
    const selected=button.dataset.usResult===ui.pendingAttackResult;
    button.disabled=attackDisabled;
    button.classList.toggle('pending',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  const theirSource=ui.themAttackSourceZone, theirTarget=ui.themAttackTargetZone;
  const themSourceOverlay=$('themSourceZoneOverlay'), themTargetOverlay=$('themTargetZoneOverlay');
  themSourceOverlay.hidden=!opponentAttackMode;
  themTargetOverlay.hidden=!opponentAttackMode;
  themSourceOverlay.querySelectorAll('[data-them-source]').forEach(button=>{
    button.setAttribute('aria-pressed',String(Number(button.dataset.themSource)===theirSource));
    button.disabled=!opponentAttackMode||attackDisabled;
    button.onclick=()=>{
      if(button.disabled)return;
      const zone=Number(button.dataset.themSource);
      ui={...ui,themAttackSourceZone:zone};
      void recordOpponentAttack(ui.themAttackResult,zone,ui.themAttackTargetZone);
    };
  });
  themTargetOverlay.querySelectorAll('[data-them-target]').forEach(button=>{
    button.setAttribute('aria-pressed',String(Number(button.dataset.themTarget)===theirTarget));
    button.disabled=!opponentAttackMode||attackDisabled;
    button.onclick=()=>{
      if(button.disabled)return;
      const zone=Number(button.dataset.themTarget);
      ui={...ui,themAttackTargetZone:ui.themAttackTargetZone===zone?null:zone};
      render();
    };
  });
  const serveTargetOverlay=$('serveTargetZoneOverlay');
  serveTargetOverlay.hidden=!serveTargetMode;
  serveTargetOverlay.querySelectorAll('[data-serve-target]').forEach(button=>{
    button.disabled=!serveTargetMode||attackDisabled;
    button.onclick=()=>{
      if(button.disabled)return;
      void recordOpponentReceiveError(Number(button.dataset.serveTarget));
    };
  });
  document.querySelectorAll('[data-them-result]').forEach(button=>{
    const selected=button.dataset.themResult===ui.themAttackResult;
    button.disabled=attackDisabled;
    button.classList.toggle('pending',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  let hint;
  if (ui.mode === 'sub') hint = '<b>Sub:</b> tap the player coming out. <a href="#" id="cx">Cancel</a>';
  else if (ui.mode === 'libero') hint = '<b>Libero:</b> tap the back-row player the libero replaces. <a href="#" id="cx">Cancel</a>';
  else if (ui.pendingPassRating !== null) hint = `<b>Pass score ${ui.pendingPassRating}</b> — tap the passer on court. <a href="#" id="cx">Cancel</a>`;
  else if (ui.pendingCode) hint = `<b>${codeName(ui.pendingCode)}</b> — tap the player on the court${EARNED.includes(ui.pendingCode) ? '' : ', or Team'}. <a href="#" id="cx">Cancel</a>`;
  else if (ui.pendingSlot) hint = `<b>#${S.onCourt[ui.pendingSlot]}</b> selected — now tap a code. <a href="#" id="cx">Cancel</a>`;
  else hint = '';
  $('hintUs').innerHTML = hint;
  const cx = $('cx'); if (cx) cx.onclick = e => { e.preventDefault(); clearUi(); };
  $('hintThem').innerHTML=serveTargetMode
    ? '<b>Receive Error:</b> tap the serve target zone on the opponent court. <a href="#" id="cxServeZone">Cancel</a>'
    : '';
  const cxServeZone=$('cxServeZone');
  if(cxServeZone)cxServeZone.onclick=e=>{e.preventDefault();clearUi();};

  // Actions
  $('actSub').classList.toggle('on', ui.mode === 'sub');
  $('actSub').disabled = timeoutMode || editingReceive;
  $('actTheirSub').disabled = timeoutMode || editingReceive || session.state.status==='ended';
  $('actLib').disabled = timeoutMode || editingReceive || !LIBEROS.length;
  $('actLib').classList.toggle('on', ui.mode === 'libero' || !!S.libero);
  $('actLibSm').textContent = S.libero ? `#${S.libero.player} in for #${S.libero.replaced}` : `Off · plan: ${S.liberoFor === 'none' ? 'none' : PAIR_NAME[S.liberoFor]}`;
  $('toUsBtn').disabled = timeoutMode || editingReceive || !S.toUs; $('toThemBtn').disabled = timeoutMode || editingReceive || !S.toThem;

  // Log
  const log = $('log');
  const previousTrack=log.querySelector('.run-track');
  const previousCount=Number(previousTrack?.dataset.itemCount??0);
  const previousScroll=previousTrack?.scrollLeft??0;
  const wasNearEnd=previousTrack
    ? previousTrack.scrollWidth-previousTrack.clientWidth-previousTrack.scrollLeft<=48
    : true;
  previousTrack?.remove();
  const track = document.createElement('div');
  track.className = 'run-track';
  track.tabIndex=0;
  track.setAttribute('role','region');
  track.setAttribute('aria-label', 'Recent point outcomes and timeouts, oldest to newest. Green marks our points; red marks opponent points. Dividers mark our side-outs. Scroll horizontally to review the entire set.');
  const last = S.timeline;
  track.dataset.itemCount=String(last.length);
  last.forEach((event, i) => {
    if(event.kind==='timeout'){
      const marker=document.createElement('div');
      marker.className=`timeout-marker${i===last.length-1?' latest':''}`;
      marker.setAttribute('role','img');
      marker.setAttribute('aria-label',`${TEAM_NAMES[event.team]} timeout at ${event.us}–${event.them}`);
      marker.title=`${TEAM_NAMES[event.team]} timeout · ${event.us}–${event.them}`;
      marker.innerHTML=`<span class="label">${event.team==='us'?'OUR':'THEIR'} TO</span><span class="score">${event.us}–${event.them}</span>`;
      track.appendChild(marker);
      return;
    }
    const r=event;
    const c = document.createElement('div');
    c.className = `rchip${r.winner === 'them' ? ' lost' : ''}${i === last.length - 1 ? ' latest' : ''}`;
    const zones=`${r.attackSourceZone!=null?` from zone ${r.attackSourceZone}`:''}${r.attackTargetZone!=null?` to zone ${r.attackTargetZone}`:''}${r.serveTargetZone!=null?`, serve targeted zone ${r.serveTargetZone}`:''}`;
    c.setAttribute('aria-label', `${r.winner === 'us' ? TEAM_NAMES.us : 'Opponent'} won the point${zones}`);
    const who = r.team === 'us' ? (r.player != null ? `#${r.player}` : TEAM_NAMES.us) : '';
    const whoLabel = who ? ` <small style="font-weight:600;font-size:12px">${esc(who)}</small>` : '';
    const zoneLabel=`${r.attackSourceZone!=null?` Z${r.attackSourceZone}`:''}${r.attackTargetZone!=null?` → Z${r.attackTargetZone}`:''}${r.serveTargetZone!=null?` · Serve Z${r.serveTargetZone}`:''}`;
    const zoneDetail=zoneLabel?`<small>${zoneLabel}</small>`:'';
    c.innerHTML = `<span class="c">${r.code}${whoLabel}${zoneDetail}</span><span class="s">${r.us}–${r.them}</span>`;
    track.appendChild(c);
    if (r.srv === 'them' && r.winner === 'us' && (i < last.length - 1 || session.state.status !== 'ended')) {
      const divider = document.createElement('div');
      divider.className = 'sideout-divider';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', 'vertical');
      divider.setAttribute('aria-label', `${TEAM_NAMES.us} side-out: rotation changes`);
      divider.title = `${TEAM_NAMES.us} side-out · rotation changes`;
      track.appendChild(divider);
    }
  });
  log.appendChild(track);
  if(!previousTrack||(last.length>previousCount&&wasNearEnd))track.scrollLeft=track.scrollWidth;
  else track.scrollLeft=Math.min(previousScroll,Math.max(0,track.scrollWidth-track.clientWidth));

  renderCorner();

  // Undo
  $('undoBtn').disabled = timeoutMode || editingReceive || history.length === 0;
  $('undoSm').textContent = history.length ? history[history.length - 1].desc : 'nothing to undo';

  // Banners
  const bn = $('banners'); bn.innerHTML = '';
  if (!timeoutMode) S.banners.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'banner' + (b.kind === 'info' ? ' info' : '');
    d.innerHTML = `<div class="t">${b.text}${b.sub ? `<small>${b.sub}</small>` : ''}</div>` +
      (b.kind === 'info' ? `<button class="no">OK</button>` : `<button class="no">Skip</button><button class="yes">${b.kind === 'swap' ? 'Swap' : 'Libero in'}</button>`);
    d.querySelector('.no').onclick = () => { S.banners.splice(i, 1); render(); };
    const yes = d.querySelector('.yes');
    if (yes) yes.onclick = () => {
      if (b.kind === 'swap') doSub(b.slot, b.in, null, true);
      if (b.kind === 'libero') liberoIn(b.slot, LIBEROS[0]);
      render();
    };
    bn.appendChild(d);
  });
  $('calloutBanner').style.display = !timeoutMode && S.banners.length ? '' : 'none';
  if(session.state.status==='ended') {
    for(const id of ['actSub','actTheirSub','actLib','toUsBtn','toThemBtn','teamBtn','editReceive']) $(id).disabled=true;
  }

}

/* ---------------- Libero plan: should she play, and for whom? ----------------
   The libero only ever plays back row, so compare everyone on the same thing:
   back-row passing/defense errors (Receive, Dig, Ball Handling) per back-row
   rally, this season plus tonight. The pair with the worse rate gains the most. */
// Demo only: season-to-date before tonight, [back-row rallies, errors there].
const PAIR_NAME = {mid:'middles',oh:'outsides'};
function plannedLiberoEntry() {
  if(!S.liberoPlanChosen)return {warning:'No libero plan selected. Choose Middles or Outsides first.'};
  if(S.liberoFor==='none')return {warning:'The current plan is “No libero”. Choose Middles or Outsides to put the libero in.'};
  const slots=Object.keys(S.onCourt).filter(slot=>SLOTS[slot]?.role===S.liberoFor&&!isFront(posOf(Number(slot))));
  if(slots.length!==1)return {warning:slots.length
    ?`The current rotation has ${slots.length} back-row ${PAIR_NAME[S.liberoFor]} players. The libero entry needs exactly one.`
    :`No back-row ${PAIR_NAME[S.liberoFor]} player is on court in this rotation.`};
  const libero=LIBEROS.find(player=>player!==S.libero?.player&&ROSTER[player]?.available!==false);
  if(libero==null)return {warning:'No designated libero is available to enter.'};
  const slot=slots[0],jersey=S.onCourt[slot];
  const payload={slotId:String(slot),outPlayerId:playerId(jersey),inPlayerId:playerId(libero)};
  const check=checkCommand(session.record,{type:'libero.in',payload});
  if(!check.allowed)return {warning:check.error.message};
  return {slot:Number(slot),jersey,libero};
}
function openLiberoPlan() {
  const other=LIBEROS.find(l=>l!==S.libero?.player);
  const entry=S.libero?null:plannedLiberoEntry();
  const chosen=S.liberoPlanChosen;
  const planNote=!chosen
    ?'No libero plan selected yet. Choose Middles or Outsides before putting the libero in.'
    :'';
  openSheet(`<h4>Libero plan</h4><p>${S.libero ? `#${S.libero.player} is in for #${S.libero.replaced}.` : 'Libero is off the court.'}</p>
    <div class="lib-plan" role="group" aria-label="Choose the libero plan">${['mid','oh','none'].map(role=>{const selected=chosen&&S.liberoFor===role;return `<button type="button" class="pill libero-plan-choice" data-plan="${role}" aria-pressed="${selected}">${PAIR_NAME[role] || 'No libero'}</button>`;}).join('')}</div>
    ${planNote?`<p class="libero-plan-note warning" role="status">${esc(planNote)}</p>`:''}
    <div class="libero-actions${S.libero?' two':''}">${S.libero ? `<button type="button" id="libOut">Libero out</button><button type="button" id="libSw" ${other == null ? 'disabled' : ''}>Switch to #${other ?? '—'}</button>` : `<button type="button" id="libIn" ${entry?.slot==null?'disabled':''}>${entry?.slot==null?'Put libero in':`Put libero in for #${entry.jersey}`}</button>`}</div>
    ${!S.libero&&chosen&&entry?.warning?`<p class="libero-plan-warning" role="alert">${esc(entry.warning)}</p>`:''}
    <button class="cancel" id="shCancel">Close</button>`);
  $('sheetCard').querySelectorAll('[data-plan]').forEach(b=>b.onclick=async()=>{
    if(b.dataset.plan===S.liberoFor||saving)return;
    if(await command('libero.plan',{role:b.dataset.plan},false))openLiberoPlan();
  });
  if(S.libero) { $('libOut').onclick=liberoOut; $('libSw').onclick=()=>liberoSwitch(other); }
  else $('libIn').onclick=async()=>{
    if(saving)return;
    const target=plannedLiberoEntry();
    if(target.slot==null){openLiberoPlan();return;}
    const saved=await liberoIn(target.slot,target.libero);
    if(!saved&&!document.body.classList.contains('failed'))openLiberoPlan();
  };
}

/* ---------------- Form: recent performance by skill ----------------
   Recent rallies count most (half-life of 8 rallies). Small samples are noisy,
   so every flag needs a minimum number of contacts and shows its counts. */
const HALF_LIFE = 8;
const FORM = { hot: { swings: 4, kills: 3 }, coldSwings: 3, coldHE: 2, passWindow: 5, passErr: 2, serveWindow: 3, serveErr: 2, aceWindow: 4, aces: 2 };

function formOf(p) {
  const R = S.rallies, n = R.length;
  const w = i => Math.pow(0.5, (n - 1 - i) / HALF_LIFE);
  // Attacking: her swings that ended the rally.
  const swings = R.map((r, i) => ({ r, i })).filter(({ r }) => r.team === 'us' && r.player === p && (r.code === 'K' || r.code === 'HE'));
  const lastSw = swings.slice(-FORM.hot.swings), last3 = swings.slice(-FORM.coldSwings);
  const attack = swings.reduce((a, { r, i }) => a + (r.code === 'K' ? 1 : -1) * w(i), 0);
  const hotHit = lastSw.length >= FORM.hot.swings && lastSw.filter(x => x.r.code === 'K').length >= FORM.hot.kills && !last3.some(x => x.r.code === 'HE');
  const coldHit = last3.length >= FORM.coldSwings && last3.filter(x => x.r.code === 'HE').length >= FORM.coldHE;
  // Serving: every rally she served.
  const serves = R.filter(r => r.sv === p);
  const lastSv = serves.slice(-FORM.serveWindow), lastSv4 = serves.slice(-FORM.aceWindow);
  const coldServe = lastSv.length >= 2 && lastSv.filter(r => r.team === 'us' && r.code === 'SE').length >= FORM.serveErr;
  const hotServe = lastSv4.filter(r => r.team === 'us' && r.code === 'SA').length >= FORM.aces;
  // Passing: rallies they served while she was in the back row.
  const receives = R.filter(r => r.srv === 'them' && r.bk && r.bk.includes(p));
  const lastRc = receives.slice(-FORM.passWindow);
  const weakPass = lastRc.filter(r => r.team === 'us' && r.code === 'SrE' && r.player === p).length >= FORM.passErr;
  const kills = swings.filter(x => x.r.code === 'K').length, errs = swings.length - kills;
  return { p, attack, hotHit, coldHit, hotServe, coldServe, weakPass, lastSw, last3, lastSv, lastRc, kills, errs, serves };
}
const recent = (list, good) => list.map(x => ((x.r || x).code === good ? '✓' : '✗')).join(' ');

// How many more rotations she stays front (if front), or rotations until she's front (if back).
function frontOutlook(pos) {
  if (isFront(pos)) return { front: true, more: pos - 2 };            // P4: 2 more, P3: 1, P2: 0
  return { front: false, until: { 1: 3, 6: 2, 5: 1 }[pos] };
}

// Every on-court form marker has a matching Coach's Corner note. Build the
// marker and note from the same filtered state so a hidden note never leaves
// an unexplained symbol on the player.
function playerFormTip(p,pos,F=formOf(p)) {
  if(!SETTINGS.corner||session.state.status==='ended')return null;
  const available=category=>SETTINGS.categories[category]!==false;
  const cold=[];
  if(F.coldHit&&available('attacking')) {
    const errors=F.last3.filter(x=>x.r.code==='HE').length;
    cold.push({id:`hit-${errors}`,category:'attacking',label:'hitting',
      note:`${errors} errors in her last ${F.last3.length} attacks. Ask for shots or tips, or set elsewhere briefly.`});
  }
  if(F.weakPass&&available('passing')) {
    const errors=F.lastRc.filter(r=>r.team==='us'&&r.code==='SrE'&&r.player===p).length;
    cold.push({id:`pass-${errors}`,category:'passing',label:'serve receive',
      note:`${errors} errors in her last ${F.lastRc.length} receiving rallies. Adjust her position or coverage.`});
  }
  if(F.coldServe&&available('serving')) {
    const misses=F.lastSv.filter(r=>r.team==='us'&&r.code==='SE').length;
    cold.push({id:`serve-${misses}`,category:'serving',label:'serving',
      note:`${misses} misses in her last ${F.lastSv.length} serves. Ask for a safe serve to a comfortable target.`});
  }
  if(cold.length) {
    return {key:`form-${p}-cold-${cold.map(x=>x.id).join('-')}`,state:'cold',formFlag:true,
      category:cold[0].category,pri:0.5,urgent:crunch()&&cold.some(x=>x.category!=='attacking'),
      title:`#${p} could use support · ${cold.map(x=>x.label).join(' / ')}`,
      why:cold.map(x=>x.note).join(' ')};
  }
  const hot=[];
  if(F.hotHit&&available('attacking')) {
    const o=frontOutlook(pos),kills=F.lastSw.filter(x=>x.r.code==='K').length;
    const advice=o.front?(o.more===0?'Front row this rotation only — set her now.':`Front row for ${o.more} more rotation${o.more===1?'':'s'}.`)
      :`She's front again after ${o.until} side-out${o.until===1?'':'s'}.`;
    hot.push({id:`hit-${kills}`,category:'attacking',label:'attacking',
      note:`${kills} kills in her last ${F.lastSw.length} attacks. ${advice}`});
  }
  if(F.hotServe&&S.serving==='us'&&pos===1&&available('serving')) {
    const serves=F.serves.slice(-FORM.aceWindow),aces=serves.filter(r=>r.team==='us'&&r.code==='SA').length;
    hot.push({id:`serve-${aces}`,category:'serving',label:'serving',
      note:`${aces} aces in her last ${serves.length} serves. Keep her serving aggressively.`});
  }
  if(!hot.length)return null;
  return {key:`form-${p}-hot-${hot.map(x=>x.id).join('-')}`,state:'hot',formFlag:true,
    category:hot[0].category,pri:0.5,title:`#${p} is hot · ${hot.map(x=>x.label).join(' / ')}`,
    why:hot.map(x=>x.note).join(' ')};
}

/* ---------------- Coach's corner: rule-based suggestions ----------------
   Every rule uses only what the app records (terminal contacts, rotations,
   serve, subs, timeouts), explains its evidence, and never acts on its own.
   Thresholds are junior-high defaults; the real app makes them editable. */
const RULES = { run: 3, errWindow: 5, errCount: 3, rotNet: -3, srePlayer: 2, liberoSrE: 2, seTeam: 3, hotK: 4, coldHE: 3, theirErr: 5, subsLeft: 3 };
// Crunch time: either team has reached 20 in a set to 25 (10 in a set to 15),
// and the score is within three points. Rules speak up sooner only while both hold.
const CRUNCH = { ...RULES, run: 2, errWindow: 4, errCount: 2, rotNet: -2, liberoSrE: 1 };
let SET_TARGET = 25;
const crunch = () => Math.max(S.us, S.them) >= SET_TARGET - 5 && Math.abs(S.us - S.them) <= 3;
let dismissed = new Set();

function suggestions() {
  const R = S.rallies, out = [], T = crunch() ? CRUNCH : RULES;
  const timeoutAct = { label: 'Call timeout', fn: () => callTimeout('us') };
  const isErr = r => !EARNED.includes(r.code);
  const byUs = (code, p) => R.filter(r => r.team === 'us' && r.code === code && (p == null || r.player === p));
  const players = [...new Set(R.filter(r => r.team === 'us' && r.player != null).map(r => r.player))];
  const rotNet = n => R.filter(r => r.rotN === n).reduce((a, r) => a + (r.winner === 'us' ? 1 : -1), 0);
  const rotRec = n => { const x = R.filter(r => r.rotN === n); const w = x.filter(r => r.winner === 'us').length; return `${w}–${x.length - w}`; };
  const words = c => (WORD[c] || c).replaceAll('<br>', ' ');

  // Their scoring run.
  let run = 0; for (let i = R.length - 1; i >= 0 && R[i].winner === 'them'; i--) run++;
  if (run >= T.run) {
    const last = R.slice(-run).map(r => r.team === 'us' ? `our ${words(r.code)}` : `their ${words(r.code)}`).join(', ');
    out.push({ key: `run-${R.length - run}-${run >= 5 ? 5 : 3}`, pri: 1, urgent: true, to: true,
      title: S.toUs ? `Timeout? They've scored ${run} straight` : `They've scored ${run} straight (no timeouts left)`,
      why: `${last}.`, acts: S.toUs ? [timeoutAct] : [] });
  }
  // Our own errors piling up.
  const lastN = R.slice(-T.errWindow), ourErr = lastN.filter(r => r.team === 'us' && isErr(r));
  if (ourErr.length >= T.errCount)
    out.push({ key: `errs-${R.length - lastN.length + lastN.indexOf(ourErr[0])}`, pri: 2, urgent: true, to: true,
      acts: S.toUs ? [timeoutAct] : [],
      title: 'Settle them down: we are giving points away',
      why: `${ourErr.length} of the last ${lastN.length} points were our errors (${ourErr.map(r => words(r.code) + (r.player != null ? ' #' + r.player : '')).join(', ')}).` });
  // Current rotation struggling this set.
  const cur = rotNum(), net = rotNet(cur);
  if (net <= T.rotNet) {
    const f = formation(), alt = f && !f.none && f.options.length > 1 && S.serving === 'them' ? f.options.find(o => o !== f.passer) : null;
    out.push({ key: `rot-${cur}-${net}`, pri: 3, title: `R${cur} is ${net} this set (${rotRec(cur)})`,
      why: alt ? `Try switching to ${PASS_LABEL[alt]}, or a sub.` : 'Consider a sub or a timeout to reset this rotation.',
      acts: alt ? [{ label: `Switch to ${PASS_LABEL[alt]}`, fn: () => selectReceive(alt) }] : [] });
  }
  // Heads-up: the rotation we move to after a side-out has been bad.
  if (S.serving === 'them') {
    const nxt = cur % 6 + 1, nn = rotNet(nxt);
    if (nn <= T.rotNet)
      out.push({ key: `next-${nxt}-${nn}`, pri: 3, title: `Heads-up: R${nxt} is next and it's ${nn} this set`,
        why: `Record there so far: ${rotRec(nxt)}. Plan the serve and who's in before it comes up.` });
  }
  // Libero passing trouble: pull her and bring the middle back, or switch liberos.
  if (S.libero) {
    const L = S.libero.player, n = byUs('SrE', L).length;
    const recent = R.slice(-6).filter(r => r.team === 'us' && r.code === 'SrE' && r.player === L).length;
    if (n >= T.liberoSrE && (!crunch() || recent > 0 || n >= RULES.liberoSrE)) {
      const other = LIBEROS.find(l => l !== L);
      out.push({ key: `lib-${L}-${n}`, pri: crunch() ? 1.5 : 3.5, urgent: crunch(),
        title: `Libero #${L} has ${n} receive error${n === 1 ? '' : 's'}`,
        why: `Pull her and put #${S.libero.replaced} back in${other != null ? `, or switch to #${other}` : ''}.`,
        acts: [{ label: `#${S.libero.replaced} back in`, fn: () => { liberoOut(); render(); } },
               ...(other != null ? [{ label: `Libero #${other}`, fn: () => { liberoSwitch(other); render(); } }] : [])] });
    }
  }
  // Form: who's on court now, and what they're doing lately.
  const onCourt = [4, 3, 2, 5, 6, 1].map(pos => ({ pos, p: S.onCourt[slotAt(pos)] })).filter(x => ROSTER[x.p]);
  for (const { pos, p } of onCourt) {
    const F = formOf(p);
    const formTip=playerFormTip(p,pos,F);
    if(formTip)out.push(formTip);
  }
  // Missed serves.
  const se = byUs('SE');
  if (se.length >= T.seTeam) {
    const who = players.map(p => [p, byUs('SE', p).length]).filter(([, n]) => n >= 2).map(([p, n]) => `#${p} ×${n}`);
    out.push({ key: `se-${se.length}`, pri: 5, title: `${se.length} missed serves this set`,
      why: `Call for serves in play.${who.length ? ' Repeat misses: ' + who.join(', ') + '.' : ''}` });
  }
  // They are beating themselves.
  const theirErr = R.filter(r => r.team === 'them' && isErr(r)).length;
  if (theirErr >= T.theirErr && theirErr >= 0.4 * S.us)
    out.push({ key: `their-${Math.floor(theirErr / 5)}`, pri: 8, title: `They've given us ${theirErr} of our ${S.us} points`,
      why: 'Keep the ball in play: tough-but-in serves, no forced swings.' });
  // Running low on subs.
  if (SUB_LIMIT - S.subs <= T.subsLeft)
    out.push({ key: `subs-${S.subs}`, pri: 9, urgent: true, title: `${SUB_LIMIT - S.subs} subs left`,
      why: 'Planned swaps still count; save one for an injury.' });

  return out.filter(t => !dismissed.has(t.key) && (t.formFlag || SETTINGS.categories[tipCategory(t)] !== false)).sort((a, b) => a.pri - b.pri);
}

function tipCategory(t) {
  if(t.category)return t.category;
  const prefix = t.key.split('-')[0];
  if (['run', 'errs'].includes(prefix)) return 'timeout';
  if (['lib', 'libplan', 'weakpass'].includes(prefix)) return 'passing';
  if (['hot', 'coldhit'].includes(prefix)) return 'attacking';
  if (['se', 'hotsrv', 'coldsrv'].includes(prefix)) return 'serving';
  if (['rot', 'next'].includes(prefix)) return 'rotation';
  return 'management';
}

function renderCorner() {
  const all = session.state.status === 'ended' || !SETTINGS.corner ? [] : suggestions(), tips = all.slice(0, 3), extra = all.length - tips.length;
  $('cornerMode').textContent = crunch() ? 'Crunch time' : '';
  $('corner').innerHTML = tips.length
    ? tips.map((t, i) => `<div class="tip${t.formFlag ? ' form-flag' : ''}${t.urgent ? ' urgent' : ''}${(t.acts || []).length ? ' has-acts' : ''}" data-category="${tipCategory(t)}" data-i="${i}"><b>${t.title}</b><button class="x" data-k="${t.key}" aria-label="Dismiss">×</button><span>${t.why}</span>${
        (t.acts || []).length ? `<div class="acts">${t.acts.map((a, j) => `<button class="pill" data-t="${i}" data-a="${j}">${a.label}</button>`).join('')}</div>` : ''}</div>`).join('')
    : `<div class="quiet">${session.state.status === 'ended' ? `Set complete · ${S.us}–${S.them}` : SETTINGS.corner ? 'Nothing to flag right now.' : 'Coach’s corner is off. Turn it on in Settings.'}</div>`;
  $('corner').classList.toggle('has-more', extra > 0);
  if (extra > 0) {
    $('corner').insertAdjacentHTML('beforeend', `<button class="more-tips" id="moreTips">+${extra} more</button>`);
    // Only the suggestions that aren't already on screen.
    const rest = all.slice(tips.length);
    $('moreTips').onclick = () => {
      openSheet(`<h4>More suggestions</h4>
        ${rest.map((t, i) => `<div class="tip${t.formFlag ? ' form-flag' : ''}${t.urgent ? ' urgent' : ''}" data-category="${tipCategory(t)}" style="margin-bottom:8px"><b>${t.title}</b><button class="x" data-rk="${t.key}" aria-label="Dismiss">×</button><span style="grid-column:1/-1">${t.why}</span>${
          (t.acts || []).length ? `<div class="acts" style="grid-column:1/-1">${t.acts.map((a, j) => `<button class="pill" data-ri="${i}" data-ra="${j}">${a.label}</button>`).join('')}</div>` : ''}</div>`).join('')}
        <button class="cancel" id="shCancel">Close</button>`);
      $('sheetCard').querySelectorAll('[data-rk]').forEach(b => b.onclick = () => { dismissed.add(b.dataset.rk); closeSheet(); render(); });
      $('sheetCard').querySelectorAll('[data-ra]').forEach(b => b.onclick = () => { closeSheet(); rest[b.dataset.ri].acts[b.dataset.ra].fn(); });
    };
  }
  $('corner').querySelectorAll('button[data-k]').forEach(b => b.onclick = () => { dismissed.add(b.dataset.k); render(); });
  $('corner').querySelectorAll('button[data-a]').forEach(b => b.onclick = e => { e.stopPropagation(); tips[b.dataset.t].acts[b.dataset.a].fn(); });
  $('corner').querySelectorAll('button[data-k]').forEach(b => b.addEventListener('click', e => e.stopPropagation()));
  // Tap a suggestion to read it in full.
  $('corner').querySelectorAll('.tip').forEach(el => el.onclick = () => {
    const t = tips[el.dataset.i];
    openSheet(`<div class="tip${t.formFlag ? ' form-flag' : ''}${t.urgent ? ' urgent' : ''}" data-category="${tipCategory(t)}"><b>${t.title}</b><span>${t.why}</span></div>
      ${(t.acts || []).length ? `<div class="lib-plan">${t.acts.map((a, j) => `<button class="pill" data-a="${j}">${a.label}</button>`).join('')}</div>` : ''}
      <div class="sheet-row"><button class="cancel" id="shCancel">Close</button><button class="ovr" id="shDismiss">Dismiss</button></div>`);
    $('sheetCard').querySelectorAll('[data-a]').forEach(b => b.onclick = () => { closeSheet(); t.acts[b.dataset.a].fn(); });
    $('shDismiss').onclick = () => { dismissed.add(t.key); closeSheet(); render(); };
  });
  $('toUsBtn').classList.toggle('suggest', all.some(t => t.to) && S.toUs > 0);
}

// ▲ hot hand, ▼ player support note. The matching note is available in
// Coach's Corner; the mark has no hover-only message.
function formMark(p,pos) {
  if (!ROSTER[p]) return '';
  const tip=playerFormTip(p,pos);
  if(!tip||dismissed.has(tip.key))return '';
  const symbol=tip.state==='hot'?'▲':'▼';
  return `<span class="form ${tip.state}" role="img" aria-label="${esc(tip.title)}">${symbol}</span>`;
}

function canPick(pos, slot) {
  if (ui.mode === 'libero') return !isFront(pos) && !(S.libero && S.libero.slot === slot);
  return true;
}

function passRatingForCurrentPoint() {
  if (!session) return null;
  const activeActions = new Set(session.state.activeActionIds);
  for (let i = session.record.actions.length - 1; i >= 0; i--) {
    const action = session.record.actions[i];
    if (!activeActions.has(action.id)) continue;
    if (action.type === 'receive.rating') return { rating: action.payload.rating, playerId: action.payload.playerId };
    if (action.type === 'rally') return null;
  }
  return null;
}

function clearUi() { ui = { ...ui, pendingCode: null, pendingSlot: null, mode: null, pendingPassRating: null, pendingAttackResult:null,
  attackPlayerSlot:null,attackTargetZone:null,themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false }; render(); }

/* ---------------- Interaction ---------------- */
function onCode(team, code) {
  if (ui.mode) return;
  if(team==='them'&&code==='SrE') {
    ui={...ui,pendingCode:null,pendingSlot:null,pendingPassRating:null,pendingAttackResult:null,attackPlayerSlot:null,
      attackTargetZone:null,themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,
      pendingServeZone:!ui.pendingServeZone};
    render();return;
  }
  if (ui.pendingPassRating !== null || ui.pendingAttackResult !== null || ui.attackTargetZone !== null || ui.themAttackResult !== null || ui.pendingServeZone)
    ui={...ui,pendingPassRating:null,pendingAttackResult:null,attackTargetZone:null,
      themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false};
  if (team === 'them') { commit('them', code, null); return; }
  if (code === 'SA' || code === 'SE') { commit('us', code, server()); return; }
  if (ui.pendingSlot) { commit('us', code, S.onCourt[ui.pendingSlot]); return; }
  ui.pendingCode = ui.pendingCode === code ? null : code;
  render();
}

function onTile(pos, slot) {
  if (ui.timeoutMode) return;
  if (ui.pendingServeZone) return;
  if (editingReceive) return;
  if (session.state.status==='ended') return;
  if (ui.mode === 'sub') { ui.mode = null; openBench(slot); return; }
  if (ui.mode === 'libero') {
    if (!canPick(pos, slot)) return;
    const avail = LIBEROS.filter(l => !(S.libero && S.libero.player === l));
    liberoIn(slot, avail[0]); render(); return;
  }
  if (ui.pendingPassRating !== null) {
    const rosterId=playerId(S.onCourt[slot]);
    if(rosterId) void command('receive.rating',{playerId:rosterId,rating:ui.pendingPassRating});
    return;
  }
  if (ui.pendingAttackResult !== null) {
    void recordOurAttack(ui.pendingAttackResult,slot);
    return;
  }
  if (ui.pendingCode) { commit('us', ui.pendingCode, S.onCourt[slot]); return; }
  const clear=ui.attackPlayerSlot===slot;
  ui={...ui,pendingSlot:clear?null:slot,attackPlayerSlot:clear?null:slot};
  render();
}

/* Manual receive editor: only the selected player moves. Validate every proposed
   layout before displaying it. Coordinates describe player-disc centers, not feet. */
$('editReceive').onclick = () => {
  if(receiveDrag) return;
  editingReceive = !editingReceive;
  if (editingReceive) {
    ui.showBase=false; ui.pendingCode=null; ui.pendingSlot=null; ui.mode=null;
    ui.pendingAttackResult=null;ui.attackPlayerSlot=null;ui.attackTargetZone=null;ui.themAttackResult=null;ui.themAttackSourceZone=null;ui.themAttackTargetZone=null;ui.pendingServeZone=false;
  }
  $('receiveStatus').textContent=editingReceive ? 'Drag one player at a time. Other players stay put; illegal moves are blocked.' : '';
  render();
};
$('resetReceive').onclick = async () => {
  if(receiveDrag) return;
  delete receiveEdits[formation().editKey];
  const saved=await saveReceiveEdits();
  $('receiveStatus').textContent=saved ? 'Original formation restored.' : 'Reset was not saved.';
  render();
};
function receivePositions(form) {
  return Object.fromEntries([1,2,3,4,5,6].map(p=>[p,{...form.spots[slotAt(p)]}]));
}
function movedReceive(original, pos, target) {
  return { ...original, [pos]: { left: target.left, top: target.top } };
}
const editCourt=$('court');
editCourt.addEventListener('pointerdown', e => {
  const tile=e.target.closest('[data-slot]');
  if(saving || failedCommand || !tile || (e.button !== 0 && e.pointerType==='mouse')) return;
  if (ui.timeoutMode && !editingReceive) {
    if (tacticalDrag || receiveDrag) return;
    const view=ui.timeoutView, form=formation(view === 'receive'), spots=timeoutSpots(form,view), slot=tile.dataset.slot;
    const spot=spots?.[slot];if(!spot)return;
    const rect=editCourt.getBoundingClientRect();
    tacticalDrag={id:e.pointerId,slot,view,context:JSON.stringify([S.order,S.onCourt,S.rotation,S.serving,SYSTEM,ui.timeoutMode,ui.timeoutView]),
      offset:{left:(e.clientX-rect.left)/rect.width*100-spot.left,top:(e.clientY-rect.top)/rect.height*100-spot.top},
      before:clone(ui.timeoutPositions?.[view] || {}),moved:false,start:{x:e.clientX,y:e.clientY}};
    editCourt.setPointerCapture(e.pointerId);e.preventDefault();return;
  }
  if (!editingReceive) return;
  if (receiveDrag) return;
  const form=formation();
  const rect=editCourt.getBoundingClientRect(), spot=form.spots[+tile.dataset.slot];
  receiveDrag={id:e.pointerId, pos:posOf(+tile.dataset.slot), form, context:JSON.stringify([S.order,S.onCourt,S.serving,SYSTEM,ui.passer,ui.showBase]),
    offset:{left:(e.clientX-rect.left)/rect.width*100-spot.left,top:(e.clientY-rect.top)/rect.height*100-spot.top},
    original:receivePositions(form), before:receiveEdits[form.editKey] ? clone(receiveEdits[form.editKey]) : null};
  editCourt.setPointerCapture(e.pointerId); e.preventDefault();
});
editCourt.addEventListener('pointermove', e => {
  if(tacticalDrag && tacticalDrag.id===e.pointerId) {
    const d=tacticalDrag;
    if(d.context!==JSON.stringify([S.order,S.onCourt,S.rotation,S.serving,SYSTEM,ui.timeoutMode,ui.timeoutView])) {finishTacticalDrag(e,true);return;}
    const rect=editCourt.getBoundingClientRect();
    const target={left:(e.clientX-rect.left)/rect.width*100-d.offset.left,top:(e.clientY-rect.top)/rect.height*100-d.offset.top};
    target.left=Math.max(7,Math.min(93,target.left));target.top=Math.max(7,Math.min(93,target.top));
    if(!d.moved && Math.hypot(e.clientX-d.start.x,e.clientY-d.start.y)>3)d.moved=true;
    if(d.moved) {
      if(d.view==='receive') {
        const form=formation(true), spots=timeoutSpots(form,'receive'), error=timeoutReceiveError(spots,d.slot,target);
        if(error) {$('receiveStatus').textContent=`Move blocked: ${error}`;return;}
      }
      ui.timeoutPositions={...(ui.timeoutPositions||{}),[d.view]:{...(ui.timeoutPositions?.[d.view]||d.before),[d.slot]:target}};
      render();
      if(d.view==='receive')$('receiveStatus').textContent='Legal order maintained · release to keep this position.';
    }
    return;
  }
  if(!receiveDrag || receiveDrag.id!==e.pointerId) return;
  const d=receiveDrag;
  if(d.context !== JSON.stringify([S.order,S.onCourt,S.serving,SYSTEM,ui.passer,ui.showBase])) {
    finishReceiveDrag(e,true); return;
  }
  const rect=editCourt.getBoundingClientRect();
  const target={left:(e.clientX-rect.left)/rect.width*100-d.offset.left,top:(e.clientY-rect.top)/rect.height*100-d.offset.top};
  const result=movedReceive(d.original,d.pos,target);
  const error=receiveLayoutError(result);
  if(!error) {
    receiveEdits[d.form.editKey]=result;
    $('receiveStatus').textContent='Legal order maintained · release to keep this position.';
    render();
  } else $('receiveStatus').textContent=`Move blocked: ${error}`;
});
async function finishReceiveDrag(e, cancel) {
  if(!receiveDrag || receiveDrag.id!==e.pointerId) return;
  const d=receiveDrag; receiveDrag=null;
  cancel = cancel || d.context !== JSON.stringify([S.order,S.onCourt,S.serving,SYSTEM,ui.passer,ui.showBase]) || !!receiveLayoutError(receiveEdits[d.form.editKey] || d.original);
  if(cancel) {
    if(d.before) receiveEdits[d.form.editKey]=d.before; else delete receiveEdits[d.form.editKey];
    $('receiveStatus').textContent='Move canceled.';
  } else $('receiveStatus').textContent=await saveReceiveEdits() ? 'Formation saved in this browser.' : 'Formation was not saved; last saved position restored.';
  if(editCourt.hasPointerCapture(e.pointerId)) editCourt.releasePointerCapture(e.pointerId);
  render();
}
function finishTacticalDrag(e,cancel) {
  if(!tacticalDrag || tacticalDrag.id!==e.pointerId)return;
  const d=tacticalDrag;tacticalDrag=null;
  cancel=cancel||d.context!==JSON.stringify([S.order,S.onCourt,S.rotation,S.serving,SYSTEM,ui.timeoutMode,ui.timeoutView]);
  if(cancel)ui.timeoutPositions={...(ui.timeoutPositions||{}),[d.view]:d.before};
  if(editCourt.hasPointerCapture(e.pointerId))editCourt.releasePointerCapture(e.pointerId);
  render();
}
editCourt.addEventListener('pointerup', e=>tacticalDrag?finishTacticalDrag(e,false):finishReceiveDrag(e,false));
editCourt.addEventListener('pointercancel', e=>tacticalDrag?finishTacticalDrag(e,true):finishReceiveDrag(e,true));
editCourt.addEventListener('lostpointercapture', e=>tacticalDrag?finishTacticalDrag(e,true):finishReceiveDrag(e,true));
editCourt.addEventListener('keydown', async e=>{
  const tile=e.target.closest('[data-slot]'), delta={ArrowLeft:[-2,0],ArrowRight:[2,0],ArrowUp:[0,-2],ArrowDown:[0,2]}[e.key];
  if(saving || failedCommand || !tile || !delta) return;
  e.preventDefault();
  if(ui.timeoutMode) {
    const view=ui.timeoutView,form=formation(view==='receive'),spots=timeoutSpots(form,view),slot=tile.dataset.slot,current=spots?.[slot];
    if(!current)return;
    const target={left:Math.max(7,Math.min(93,current.left+delta[0])),top:Math.max(7,Math.min(93,current.top+delta[1]))};
    if(view==='receive') {
      const error=timeoutReceiveError(spots,slot,target);
      if(error) {$('receiveStatus').textContent=`Move blocked: ${error}`;return;}
    }
    const previous=ui.timeoutPositions?.[view]||{};
    ui.timeoutPositions={...(ui.timeoutPositions||{}),[view]:{...previous,[slot]:target}};
    render();
    if(view==='receive')$('receiveStatus').textContent='Legal order maintained · adjustment retained for this timeout.';
    return;
  }
  if(!editingReceive)return;
  const form=formation(), original=receivePositions(form), pos=posOf(+tile.dataset.slot);
  const result=movedReceive(original,pos,{left:original[pos].left+delta[0],top:original[pos].top+delta[1]});
  const error=receiveLayoutError(result);
  if(!error) {
    receiveEdits[form.editKey]=result;
    $('receiveStatus').textContent=await saveReceiveEdits() ? 'Legal order maintained · formation saved.' : 'Move was not saved; last saved position restored.';
    render();
  } else $('receiveStatus').textContent=`Move blocked: ${error}`;
});

$('rcvToggle').onclick = () => {
  if (receiveDrag || tacticalDrag || ui.timeoutMode) return;
  ui.showBase = !ui.showBase;
  render();
};

$('timeoutDone').onclick = () => {
  if (!ui.timeoutMode || tacticalDrag) return;
  ui = { ...ui, timeoutMode: false, timeoutView: null, timeoutPasser: null, timeoutPositions: null,
    pendingCode: null, pendingSlot: null, mode: null, pendingPassRating: null, showBase: false,
    pendingAttackResult:null,attackPlayerSlot:null,attackTargetZone:null,themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false };
  $('receiveStatus').textContent = '';
  render();status('Timeout ended · ready to continue the set.');
};

$('teamBtn').onclick = () => { if (ui.pendingCode) { commit('us', ui.pendingCode, null); } };

$('undoBtn').onclick = () => command('undo', {});

document.querySelectorAll('[data-us-result]').forEach(button=>button.onclick=()=>{
  if(button.disabled)return;
  const result=button.dataset.usResult;
  if(ui.attackPlayerSlot!=null) { void recordOurAttack(result); return; }
  const deselect=ui.pendingAttackResult===result;
  ui={...ui,pendingCode:null,pendingSlot:null,pendingPassRating:null,
    pendingAttackResult:deselect?null:result,attackTargetZone:deselect?null:ui.attackTargetZone,
    themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false};
  render();
});
document.querySelectorAll('[data-them-result]').forEach(button=>button.onclick=()=>{
  if(button.disabled)return;
  const result=button.dataset.themResult;
  ui={...ui,pendingCode:null,pendingSlot:null,pendingPassRating:null,pendingAttackResult:null,
    attackPlayerSlot:null,attackTargetZone:null,mode:null,
    themAttackResult:ui.themAttackResult===result?null:result,
    themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false};
  render();
});

$('actSub').onclick = () => { ui = { ...ui, pendingCode: null, pendingSlot: null, pendingPassRating: null,
  pendingAttackResult:null,attackPlayerSlot:null,attackTargetZone:null,themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false,mode: ui.mode === 'sub' ? null : 'sub' }; render(); };
$('actTheirSub').onclick = () => { clearUi(); openOpponentSub(); };

$('actLib').onclick = () => {
  if (ui.mode === 'libero') { ui = { ...ui, mode: null, pendingPassRating: null }; render(); return; }
  ui={...ui,pendingCode:null,pendingSlot:null,mode:null,pendingPassRating:null,pendingAttackResult:null,
    attackPlayerSlot:null,attackTargetZone:null,themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false};
  openLiberoPlan();
};

function callTimeout(team) { return command('timeout', {team}); }
const TEAM_MENU = [
  ['rotation-report', 'Rotation report', "The paper sheet’s six columns, with +/- per rotation"],
  ['lineup', 'Lineup', "This set’s lineup, planned swaps and libero plan"],
  ['edit-rallies', 'Edit rallies', 'Fix or delete any logged rally'],
  ['fix-score', 'Fix score / rotation / server', 'Match the official scoresheet'],
  ['match-summary', 'Match summary', 'Set scores, key stats, rotation tables'],
  ['switch-team', 'Switch team', 'Keep this set saved and open Teams, rosters, and match setup'],
  ['settings', 'Settings', "Coach’s corner rules, button labels, rule presets"],
];
$('teamMenu').onclick = () => {
  openSheet(`<h4>${esc(TEAM_NAMES.us)} · ${esc(TEAM_NAMES.them)}</h4>
    <div class="menu-list">${TEAM_MENU.map(([id, title, description]) => {
      return `<button data-menu="${id}"><b>${title}</b><span>${description}</span></button>`;
    }).join('')}</div>
    <button class="cancel" id="shCancel">Close</button>`);
  const screens = { 'rotation-report': rotationReport, lineup: lineupSheet, 'edit-rallies': editRallies, 'fix-score': fixScore,
    'match-summary': matchSummary, settings: settingsSheet };
  $('sheetCard').querySelectorAll('[data-menu]').forEach(b => b.onclick = () => {
    if (b.dataset.menu === 'switch-team') { location.href = './teams.html'; return; }
    if (b.dataset.menu === 'lineup' && menuContext.canEditLineup) { void openCurrentSetLineupSetup(); return; }
    screens[b.dataset.menu](menuContext);
  });
};
if($('opponentMenu'))$('opponentMenu').onclick = () => openOpponentScout();

function openOpponentScout(){
  openSheet(`<h4>${esc(TEAM_NAMES.them)} scouting</h4>
    <p>Tap a court position and enter its jersey number with the in-screen keypad. Mark setters on court or add an off-court setter; set the system and defense as you learn them. No device keyboard opens.</p>
    <div id="opponentScoutEditor"></div>`,true,'scouting');
  mountOpponentScoutEditor($('opponentScoutEditor'),OPPONENT_SCOUT,async scout=>{
    if(saving)throw new Error('Wait for the current save to finish.');
    saving=true;document.body.classList.add('saving');status('Saving opponent scouting…');
    const original=session.record,next=structuredClone(original);
    if(scout)next.config.opponentScout=scout;else delete next.config.opponentScout;
    try{
      await store.updateSetRecord(original,next);
      session.record=next;
      MATCH_RECORDS=MATCH_RECORDS.map(record=>record.config.id===next.config.id?next:record);
      OPPONENT_SCOUT=scout;closeSheet();render();status('Opponent scouting saved on this device');
    }finally{saving=false;document.body.classList.remove('saving');}
  });
  $('opponentScoutEditor').addEventListener('click',event=>{
    if(event.target.closest('#shCancel'))closeSheet();
  });
}
async function openCurrentSetLineupSetup(){
  if(!session||lineupSetupLocked(session.record,session.state))return;
  const teams=await store.listTeams(),team=teams.find(item=>item.id===session.record.config.teamId);
  if(!team){status('The team roster is unavailable. Reload the saved set before continuing.',true);return;}
  const records=await store.listSets(),match=teamHierarchy(teams,records).find(item=>item.id===team.id)
    ?.matches.find(item=>item.id===session.record.config.matchId);
  if(!match){status('This match is unavailable. Reload the saved set before continuing.',true);return;}
  clearUi();
  const setNumber=session.record.config.setNumber??1;
  const previousSet=orderMatchSets(match.sets).filter(record=>(record.config.setNumber??1)<setNumber).at(-1)??null;
  await openSetSetup({initial:false,team,match,previousSet,allSets:records,originalRecord:structuredClone(session.record)});
}
// What the menu screens need from the live page; getters so they always see committed state.
const menuContext = {
  get record() { return session.record; }, get state() { return session.state; }, get teams() { return TEAM_NAMES; },
  get canEditLineup() { return Boolean(session&&!lineupSetupLocked(session.record,session.state)); },
  get exhibition() { return isExhibitionSet(session.record,MATCH_RECORDS); },
  matchRecords: () => MATCH_RECORDS.map(r => r.config.id === session.record.config.id ? session.record : r),
  open: (html, wide) => openSheet(html, wide), close: () => closeSheet(),
  command: (type, payload) => command(type, payload), check: cmd => checkCommand(session.record, cmd),
  openLineupSetup: () => { void openCurrentSetLineupSetup(); },
  openLiberoPlan: () => openLiberoPlan(),
  settings: () => ({...SETTINGS}), saveSettings: next => { SETTINGS = next; saveSettings(next); applySettings(); render(); },
};
function applySettings() {
  applyColorTheme(ACTIVE_THEME||'evergreen');
  document.body.classList.toggle('words', SETTINGS.labels !== 'codes');
  html.classList.toggle('dark', SETTINGS.appearance === 'dark'); html.classList.toggle('light', SETTINGS.appearance === 'light');
  document.body.classList.toggle('corner-off', !SETTINGS.corner);
}

$('toUsBtn').onclick = () => callTimeout('us');
$('toThemBtn').onclick = () => callTimeout('them');

// More: show the rare team-fault codes; they fold away again after use.

function openOpponentSub() {
  openSheet(`<h4>${esc(TEAM_NAMES.them)} substitution</h4>
    <p>Record the jersey numbers at ${S.us}–${S.them}. This is saved with the rally history.</p>
    <div class="opponent-sub-fields">
      <label>New player coming in<input id="opponentSubIn" type="text" inputmode="numeric" maxlength="3" required autocomplete="off"></label>
      <label>Player coming out<input id="opponentSubOut" type="text" inputmode="numeric" maxlength="3" required autocomplete="off"></label>
    </div>
    <div class="sheet-row"><button class="cancel" id="shCancel">Cancel</button><button class="pill" id="recordOpponentSub">Record sub</button></div>`);
  const out=$('opponentSubOut'), incoming=$('opponentSubIn');
  $('recordOpponentSub').onclick=async()=>{
    const outJersey=out.value.trim(),inJersey=incoming.value.trim();
    if(!outJersey){out.reportValidity();return;}
    if(!inJersey){incoming.reportValidity();return;}
    if(outJersey===inJersey){incoming.setCustomValidity('Enter a different jersey number.');incoming.reportValidity();incoming.setCustomValidity('');return;}
    await command('opponent.substitution',{outJersey,inJersey});
  };
  incoming.focus();
}

function openBench(slot, override) {
  const out = S.onCourt[slot];
  if (S.libero && S.libero.slot === slot) { openLiberoPlan(); return; }
  const onCourt = new Set(Object.values(S.onCourt));
  const bench = Object.keys(ROSTER).map(Number)
    .filter(p => ROSTER[p].available && !onCourt.has(p) && !LIBEROS.includes(p) && !(S.libero && S.libero.replaced === p))
    .map(p => ({ p, why: subBlocked(p, out) }))
    .sort((x, y) => (!!x.why - !!y.why) || (S.partner[y.p] === out) - (S.partner[x.p] === out));
  const btns = bench.map(({ p, why }) => {
    const partner = S.partner[p] === out;
    const off = why && !override;
    return `<button data-p="${p}" class="${partner ? 'partner' : ''}${why ? ' blocked' : ''}" ${off ? 'disabled' : ''}>
      <b>${p}</b><span>${ROSTER[p].n} · ${ROSTER[p].r}</span>${partner ? '<em class="ok">Subbed for each other</em>' : ''}${why ? `<em>${esc(why)}</em>` : ''}</button>`;
  }).join('');
  const locked = S.partner[out];
  const lead = locked != null
    ? `#${out} is locked with #${locked} this set, so only #${locked} can come in.`
    : `#${out} hasn't been part of a sub this set, so any eligible player can come in.`;
  openSheet(`<h4>Sub for #${out}</h4><p>${lead} ${SUB_LIMIT - S.subs} subs left.</p>
    <div class="bench">${btns}</div>
    <div class="sheet-row"><button class="cancel" id="shCancel">Cancel</button>
    ${override ? '<label>Override reason <input id="overrideReason" required placeholder="Explain the official’s ruling"></label>' : '<button class="ovr" id="shOverride">Override…</button>'}</div>`);
  $('sheetCard').querySelectorAll('.bench button').forEach(b => b.onclick = () => { const reason=override ? $('overrideReason').value.trim() : null; if(override && !reason){$('overrideReason').reportValidity();return;} doSub(slot, +b.dataset.p, reason); });
  const o = $('shOverride'); if (o) o.onclick = () => openBench(slot, true);
}

function openSheet(html, wide = false, variant = '') {
  $('sheetCard').innerHTML = html; $('sheetCard').classList.toggle('wide', wide);
  $('sheetCard').classList.toggle('scouting',variant==='scouting');
  $('sheetCard').classList.toggle('set-setup',variant==='set-setup'); $('sheet').classList.add('open');
  const cancel=$('shCancel');if(cancel)cancel.onclick = closeSheet;
}
function closeSheet() { if(setupLocked)return; $('sheet').classList.remove('open'); if(setupContext&&!setupContext.initial)setupContext=null; clearUi(); }
$('sheet').onclick = e => { if (e.target.id === 'sheet'&&!setupLocked) closeSheet(); };

/* ---------------- Page chrome ---------------- */
$('optCallouts').onchange = e => document.body.classList.toggle('no-callouts', !e.target.checked);
const html = document.documentElement;
$('optDark').checked = matchMedia('(prefers-color-scheme: dark)').matches;
$('optDark').onchange = e => { html.classList.toggle('dark', e.target.checked); html.classList.toggle('light', !e.target.checked); };
$('optWords').onchange = $('optCodes').onchange = () => { document.body.classList.toggle('words', $('optWords').checked); render(); };
applySettings();
document.body.classList.add('tools-in', 'no-header', 'no-callouts');
document.querySelectorAll('input[name=hdr]').forEach(r => r.onchange = () => document.body.classList.toggle('no-header', r.value === 'none' && r.checked));
document.querySelectorAll('input[name=tools]').forEach(r => r.onchange = () => { document.body.classList.toggle('tools-in', r.value === 'in' && r.checked); render(); });



function fit() {
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const k = Math.min(1, width / 1366, height / 1024);
  const stage = document.querySelector('.stage');
  stage.style.height = `${height}px`;
  const sc = $('scaler');
  sc.style.transform = `scale(${k})`;
  sc.style.left = `${Math.max(0, (width - 1366 * k) / 2)}px`;
  sc.style.top = `${Math.max(0, (height - 1024 * k) / 2)}px`;
  document.querySelector('.notes').style.maxWidth = (1366 * k) + 'px';
}
window.addEventListener('resize', fit);
window.visualViewport?.addEventListener('resize', fit);
// Player dots scale with the court.
new ResizeObserver(([e]) => { $('court').style.setProperty('--cw', e.contentRect.width + 'px'); $('courtWrap').style.setProperty('--cw', e.contentRect.width + 'px'); }).observe($('court'));

function lockLiveSetForSetup(locked){
  setupLocked=locked;
  for(const child of $('ipad').children)if(child!==$('sheet'))child.inert=locked;
  $('sheet').setAttribute('aria-modal',String(locked));
}
function setupLineupOptions(team,selected){
  const usable=team.lineups.filter(lineup=>!lineupIssue(team,lineup));
  return `${usable.map(lineup=>`<option value="${esc(lineup.id)}" ${lineup.id===selected?'selected':''}>${esc(lineup.name)} · ${esc(lineup.system)}</option>`).join('')}<option value="custom" ${selected==='custom'?'selected':''}>Custom lineup</option>`;
}
function setupPreviewMarkup(team,lineup,rotation,firstServe){
  const order=[...lineup.starters.slice(rotation-1),...lineup.starters.slice(0,rotation-1)];
  return '<span class="lineup-net" aria-hidden="true">NET</span><span class="lineup-attack-line" aria-hidden="true"></span>'+[4,3,2,5,6,1].map((pos,index)=>{
    const player=team.players.find(item=>item.id===order[pos-1]);
    const color=player&&lineup.setters.includes(player.id)?'var(--c-set)':player?.position==='MB'?'var(--c-mid)':'var(--c-oh)';
    return `<div class="lineup-player ${[1,5,6].includes(pos)?'back':''} ${player?'':'empty'}" style="--column:${index%3};--row:${Math.floor(index/3)};--player-color:${color}"><small class="lineup-position">P${pos}${pos===1&&firstServe==='us'?' · server':''}</small><span class="lineup-disc"><strong class="lineup-number">${player?esc(player.jersey):'—'}</strong></span><span class="lineup-name">${player?esc(player.name):'Choose a player'}</span></div>`;
  }).join('');
}
function cancelSetSetup(){
  if(setupContext?.initial){
    const params=new URLSearchParams({team:setupContext.team.id,match:setupContext.match.id});
    lockLiveSetForSetup(false);location.href=`./teams.html#${params}`;return;
  }
  setupContext=null;closeSheet();
}
async function openSetSetup(context){
  setupContext=context;
  const {team,match,previousSet,originalRecord}=context;
  const usable=team.lineups.filter(lineup=>!lineupIssue(team,lineup));
  let selected=originalRecord?.config.lineupTemplate?.id;
  if(!selected&&!originalRecord){
    selected=await store.loadLastLineupId(team.id);
    if(!usable.some(lineup=>lineup.id===selected))selected=latestSavedLineupId(team,context.allSets??[]);
    if(!usable.some(lineup=>lineup.id===selected))selected=previousSet?.config.lineupTemplate?.id;
    if(!usable.some(lineup=>lineup.id===selected))selected=usable[0]?.id;
  }
  if(!usable.some(lineup=>lineup.id===selected))selected='custom';
  const customSeed=originalRecord?lineupFromSet(originalRecord)
    :usable.find(lineup=>lineup.id===selected)??(previousSet?lineupFromSet(previousSet):usable[0]??{});
  const setNumber=originalRecord?.config.setNumber??match.sets.length+1;
  const exhibition=Boolean(originalRecord?.config.exhibition
    ??(match.bestOf===3&&setNumber===3&&match.sets.length===2&&match.winner));
  const plan=setPlan({bestOf:match.bestOf,setNumber,previousSet,exhibition});
  const defaultServe=previousSet?(previousSet.config.firstServe==='us'?'them':'us'):'them';
  const chosenServe=plan.firstServe??originalRecord?.config.firstServe??defaultServe;
  const originalMode=originalRecord?.config.startingRotationSource?.mode??'auto';
  const originalRotation=originalRecord?.config.startingRotation??(chosenServe==='us'?1:6);
  if(context.initial)lockLiveSetForSetup(true);
  const serveMarkup=plan.firstServe===null
    ? `<label>First serve<select id="setupFirstServe"><option value="us" ${chosenServe==='us'?'selected':''}>${esc(team.name)} serves</option><option value="them" ${chosenServe==='them'?'selected':''}>${esc(match.opponent)} serves</option></select></label>`
    : `<p class="setup-serve-fixed"><strong>First serve alternates:</strong> ${esc(plan.firstServe==='us'?team.name:match.opponent)} serves this set.</p>`;
  const canCarry=Boolean(previousSet&&replaySet(previousSet).status==='ended');
  const mode=originalMode==='carry'&&canCarry?'carry':originalMode==='manual'?'manual':'auto';
  const rotationOptions=`<option value="auto" ${mode==='auto'?'selected':''}>Automatic · R1 serving / R6 receiving</option><option value="manual" ${mode==='manual'?'selected':''}>Choose a rotation</option><option value="carry" ${mode==='carry'?'selected':''} ${canCarry?'':'disabled'}>${canCarry?`Carry previous set’s ending rotation (R${replaySet(previousSet).rotation})`:'Carry previous set’s ending rotation'}</option>`;
  openSheet(`<form class="set-setup-form" id="setSetupForm"><div class="set-setup-content"><h4>${context.initial?'Choose lineup':`Lineup · Set ${setNumber}`}</h4>
    <p>${esc(team.name)} vs ${esc(match.opponent)} · Set ${setNumber} of ${match.bestOf}${exhibition?' · Exhibition':''}. The court stays locked until this is saved.</p>
    <div class="set-setup-grid"><div class="set-setup-controls">
      <label>Your lineup<select id="setupLineupSelect">${setupLineupOptions(team,selected)}</select></label>
      <p class="muted" id="setupLineupNote"></p>
      ${serveMarkup}
      <details class="setup-advanced"><summary>Starting rotation · automatic</summary><label>Start choice<select id="setupRotationMode">${rotationOptions}</select></label><label id="setupRotationLabel" hidden>Starting rotation<select id="setupRotation">${[1,2,3,4,5,6].map(number=>`<option value="${number}" ${number===originalRotation?'selected':''}>R${number}</option>`).join('')}</select></label><p id="setupRotationNote" class="muted"></p></details>
      <div class="setup-save-lineup" id="setupSaveLineup"><details><summary>Save a custom lineup for later</summary><label>Lineup name<input id="setupLineupName" maxlength="100" placeholder="Standard 6-2"></label><button type="button" id="setupSaveLineupButton">Save lineup</button></details></div>
    </div><div class="set-setup-court"><div id="setupLineupPreview" class="lineup-court lineup-preview"></div><div id="setupLineupFields"></div></div></div>
    </div><p id="setupMessage" class="setup-message" role="status" aria-live="polite"></p>
    <div class="sheet-row"><button type="button" class="cancel" id="setupCancel">Cancel</button><button type="submit" class="primary">${context.initial?'Save lineup & open set':'Save lineup'}</button></div>
  </form>`,true,'set-setup');
  const selector=$('setupLineupSelect'),fields=$('setupLineupFields');
  let currentTeam=team,selectedLineupId=selected;
  const editor=mountLineupEditor(fields,currentTeam,customSeed,()=>{
    if(selector.value!=='custom'){selector.value='custom';selectedLineupId='custom';refreshSetup();}
  });
  function chosenLineup(){return selectedLineupId==='custom'?editor.read():currentTeam.lineups.find(lineup=>lineup.id===selectedLineupId);}
  function refreshSetup(){
    const saved=selectedLineupId!=='custom';
    fields.hidden=saved;
    $('setupSaveLineup').hidden=saved;
    $('setupLineupPreview').hidden=!saved;
    $('setupLineupNote').textContent=saved
      ?`${currentTeam.lineups.find(lineup=>lineup.id===selectedLineupId)?.name??'Saved lineup'} selected.`
      :'Set the six players, system, setters, and liberos for this set.';
    const firstServe=plan.firstServe??$('setupFirstServe')?.value??chosenServe;
    const rotationMode=$('setupRotationMode').value;
    $('setupRotationLabel').hidden=rotationMode!=='manual';
    const rotation=startingRotation({mode:rotationMode,firstServe,rotation:Number($('setupRotation').value),previousSet});
    $('setupRotationNote').textContent=rotationMode==='carry'
      ?`Starts in R${rotation}, where the previous set ended.`
      :rotationMode==='manual'?`Starts in R${rotation}.`:'The starting court is chosen automatically from who serves first.';
    const lineup=chosenLineup();
    if(lineup?.starters?.length===6)$('setupLineupPreview').innerHTML=setupPreviewMarkup(currentTeam,lineup,rotation,firstServe);
    $('setupLineupPreview').setAttribute('aria-label',`Starting court in R${rotation}`);
  }
  selector.onchange=()=>{
    selectedLineupId=selector.value;
    if(selectedLineupId==='custom')editor.write(customSeed);
    else editor.write(currentTeam.lineups.find(lineup=>lineup.id===selectedLineupId)??{});
    refreshSetup();
  };
  $('setupFirstServe')?.addEventListener('change',refreshSetup);
  $('setupRotationMode').onchange=refreshSetup;$('setupRotation').onchange=refreshSetup;
  $('setupCancel').onclick=cancelSetSetup;
  $('setupLineupName').addEventListener('input',()=>{$('setupMessage').textContent='';});
  $('setupSaveLineupButton').onclick=async()=>{
    if(saving)return;
    try{
      const value=validateLineup(currentTeam,{...editor.read(),id:crypto.randomUUID(),name:$('setupLineupName').value});
      const updated=validateTeam({...currentTeam,revision:currentTeam.revision+1,lineups:[...currentTeam.lineups,value]});
      saving=true;document.body.classList.add('saving');status('Saving lineup…');
      await store.saveTeam(updated,currentTeam.revision);
      currentTeam=updated;setupContext.team=updated;
      selector.innerHTML=setupLineupOptions(currentTeam,value.id);selectedLineupId=value.id;editor.write(value);refreshSetup();
      $('setupLineupName').value='';$('setupMessage').textContent=`${value.name} saved and selected.`;
      status('Lineup saved on this device');
    }catch(error){$('setupMessage').textContent=error.message;}
    finally{saving=false;document.body.classList.remove('saving');}
  };
  $('setSetupForm').onsubmit=async event=>{
    event.preventDefault();if(saving)return;
    const message=$('setupMessage');message.textContent='';
    try{
      const lineup=chosenLineup();
      const choices={...lineup,bestOf:match.bestOf,opponent:match.opponent,date:match.date,
        firstServe:plan.firstServe??$('setupFirstServe').value,exhibition,opponentScout:match.opponentScout,
        rotationMode:$('setupRotationMode').value,rotation:Number($('setupRotation').value),previousSet,
        ...(selectedLineupId!=='custom'?{lineupId:selectedLineupId}:{})};
      const identity={setId:originalRecord?.config.id??crypto.randomUUID(),matchId:match.id,setNumber};
      const next=makeMatchSet(currentTeam,choices,identity);
      if(originalRecord)next.actions=structuredClone(originalRecord.actions);
      saving=true;document.body.classList.add('saving');status('Saving lineup…');
      if(originalRecord)await store.updateSetSetup(originalRecord,next,originalRecord.actions.length);
      else await store.startSet(next,context.expectedActive);
      if(selectedLineupId!=='custom'){
        try{await store.saveLastLineupId(currentTeam.id,selectedLineupId);}
        catch{message.textContent='Lineup saved. The default lineup preference could not be updated.';}
      }
      failedCommand=null;document.body.classList.remove('failed');$('reloadSaved').hidden=true;$('retrySave').hidden=true;
      if(context.initial){lockLiveSetForSetup(false);location.replace('./index.html');return;}
      session.record=next;session.state=replaySet(next);configureLive(next,currentTeam);
      MATCH_RECORDS=await store.listSets();
      const siblings=orderMatchSets(MATCH_RECORDS.filter(record=>record.config.teamId===next.config.teamId&&record.config.matchId===next.config.matchId));
      const currentIndex=siblings.findIndex(record=>record.config.id===next.config.id);
      PAST_SETS=siblings.slice(0,currentIndex).flatMap(record=>{const state=replaySet(record);return state.status==='ended'?[{...state.score,id:record.config.id,number:record.config.setNumber??1}]:[];});
      setupContext=null;lockLiveSetForSetup(false);$('sheet').classList.remove('open');
      ui={...ui,pendingCode:null,pendingSlot:null,mode:null,pendingPassRating:null,pendingAttackResult:null,attackPlayerSlot:null,attackTargetZone:null,
        themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false};syncState();render();status('Lineup saved · ready to play');
    }catch(error){
      message.textContent=error.message;status(error.message,error instanceof StorageConflict);
      if(error instanceof StorageConflict){document.body.classList.add('failed');$('retrySave').hidden=true;$('reloadSaved').hidden=false;}
    }finally{saving=false;document.body.classList.remove('saving');}
  };
  refreshSetup();
  $('setupCancel').focus();
}
function latestSavedLineupId(team,records){
  const valid=new Set(team.lineups.filter(lineup=>!lineupIssue(team,lineup)).map(lineup=>lineup.id));
  const latestTimestamp=record=>record.actions.reduce((latest,action)=>action.occurredAt>latest?action.occurredAt:latest,
    `${record.config.matchDate??''}T00:00:00.000Z`);
  return records.filter(record=>record.config.teamId===team.id&&valid.has(record.config.lineupTemplate?.id))
    .sort((a,b)=>latestTimestamp(a).localeCompare(latestTimestamp(b))
      ||(a.config.setNumber??0)-(b.config.setNumber??0)).at(-1)?.config.lineupTemplate.id??null;
}


async function start() {
  document.body.classList.add('saving');
  try {
    store?.close(); store=await openSetStore();
    let record=await store.loadActive();
    const [allSets,savedTeams]=await Promise.all([store.listSets(),store.listTeams()]);
    const params=new URLSearchParams(location.search);
    if(params.get('setup')==='1'){
      const team=savedTeams.find(item=>item.id===params.get('team'));
      const teamSummary=teamHierarchy(savedTeams,allSets).find(item=>item.id===team?.id);
      const match=teamSummary?.matches.find(item=>item.id===params.get('match'));
      if(!team||!teamSummary?.editable||!match)throw new Error('This match is no longer available. Return to Teams and open it again.');
      const nextSet=match.sets.length+1;
      const optionalThird=match.bestOf===3&&nextSet===3&&match.sets.length===2&&Boolean(match.winner);
      if(!match.bestOf||match.inProgress||nextSet>match.bestOf||match.winner&&!optionalThird)
        throw new Error('This match is not ready for another set. Open the match page to review its status.');
      const previousSet=match.sets.at(-1)??null;
      if(previousSet&&replaySet(previousSet).status!=='ended')
        throw new Error('Finish the previous set before choosing a lineup for the next set.');
      setupContext={initial:true,team,match,previousSet,allSets,originalRecord:null,
        exhibition:Boolean(optionalThird),expectedActive:record?{id:record.config.id,revision:record.actions.length}:null};
      await openSetSetup(setupContext);
      fit();status('Choose a lineup before entering the live set');return;
    }
    if(!record) {location.replace('./teams.html');return;}
    const siblings=orderMatchSets(allSets.filter(r=>r.config.teamId===record.config.teamId&&r.config.matchId===record.config.matchId));
    const currentIndex=siblings.findIndex(r=>r.config.id===record.config.id);MATCH_RECORDS=siblings;
    PAST_SETS=siblings.slice(0,currentIndex).flatMap((r,i)=>{const state=replaySet(r);return state.status==='ended'?[{...state.score,id:r.config.id,number:r.config.setNumber??i+1}]:[];});
    configureLive(record,savedTeams.find(team=>team.id===record.config.teamId));applySettings();
    session=new SetSession(store,record); syncState();
    ui={pendingCode:null,pendingSlot:null,mode:null,passer:session.state.receivePasser,showBase:false,
      pendingPassRating:null,pendingAttackResult:null,attackPlayerSlot:null,attackTargetZone:null,themAttackResult:null,themAttackSourceZone:null,themAttackTargetZone:null,pendingServeZone:false,
      timeoutMode:false,timeoutView:null,timeoutPasser:null,timeoutPositions:null};
    failedCommand=null; document.body.classList.remove('failed'); $('reloadSaved').hidden=true; $('retrySave').hidden=true;
    render();fit();status(session.state.status==='ended'?'Set ended · saved on this device':'Saved on this device');
  } catch(e) {status(e.message,true);document.body.classList.add('failed');$('reloadSaved').hidden=false;}
  finally {document.body.classList.remove('saving');}
}
$('retrySave').onclick=async()=>{
  const pending=failedCommand;if(!pending)return;
  failedCommand=null;document.body.classList.remove('failed');$('retrySave').hidden=true;$('reloadSaved').hidden=true;
  await perform(pending.cmd,pending.clear);
};
$('reloadSaved').onclick=()=>{
  editingReceive=false;receiveDrag=null;setupContext=null;lockLiveSetForSetup(false);failedCommand=null;
  $('sheet').classList.remove('open');document.body.classList.remove('failed');$('retrySave').hidden=true;$('reloadSaved').hidden=true;
  void start();
};
// Prevent keyboard activation as well as pointer input while an action is unresolved.
for(const event of ['click','keydown','pointerdown']) document.addEventListener(event,e=>{
  if(setupLocked&&e.target.closest('.ipad')&&!e.target.closest('#sheetCard')) {
    e.preventDefault();e.stopImmediatePropagation();return;
  }
  if((saving || document.body.classList.contains('saving') || failedCommand || document.body.classList.contains('failed')) && e.target.closest('.stage')) {
    e.preventDefault();e.stopImmediatePropagation();
  }
},true);
buildPads();
await start();
// Keep the iPad awake while a set is live; release it once the set ends.
const awake = () => keepAwake(session?.state.status === 'live');
document.addEventListener('visibilitychange', awake);
new MutationObserver(awake).observe($('saveStatus'), { childList: true });
awake();
