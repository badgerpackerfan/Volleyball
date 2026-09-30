import { orderMatchSets } from '../teams/match-model.mjs';
import { FORMATIONS } from './formations.mjs';
import { checkCommand, replaySet } from '../engine/set-engine.mjs';
import { receiveLayoutError } from '../engine/receive-layout.mjs';
import { openSetStore, StorageConflict } from '../storage/indexeddb.mjs';
import { SetSession } from './session.mjs';
import { registerApp, keepAwake } from './pwa.mjs';
registerApp();
import { rotationReport, lineupSheet, editRallies, fixScore, matchSummary, settingsSheet } from './team-menu.mjs';
import { loadSettings, applyColorTheme, saveSettings } from './themes.mjs';
let session, store, saving = false, failedCommand = null, MATCH_RECORDS = [];
let SETTINGS = loadSettings();
let ACTIVE_THEME = null;

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
  ACTIVE_THEME=c.teamTheme||savedTeam?.teamTheme||SETTINGS.theme;
  SYSTEM=c.system;SUB_LIMIT=c.rules.substitutionLimit;SET_TARGET=c.rules.target;
  TEAM_NAMES={us:c.teamName || '8th Grade',them:c.opponentName || 'West Fargo'};
  playerNumbers=new Map(c.players.map(p=>[p.id,Number(p.jersey)]));
  ROSTER=Object.fromEntries(c.players.map(p=>[Number(p.jersey),{id:p.id,n:esc(p.name || LEGACY_ROSTER[p.jersey]?.n || `Player ${p.jersey}`),r:p.position || LEGACY_ROSTER[p.jersey]?.r || 'OH',available:p.available}]));
  LIBEROS=c.liberos.map(numberFor);SETTERS={[SYSTEM]:c.setters.map(numberFor)};
  SLOTS=Object.fromEntries(c.slots.map(slot=>{const start=numberFor(slot.playerId);return [slot.id,{start,
    role:c.setters.includes(slot.playerId)?'set':ROSTER[start].r==='MB'?'mid':'oh',
    ...(slot.plan?{plan:{front:numberFor(slot.plan.frontPlayerId),back:numberFor(slot.plan.backPlayerId)}}:{})}];}));
  $('teamMenu').innerHTML=`${savedTeam?.logo?`<img class="team-logo-mini" src="${esc(savedTeam.logo)}" alt="">`:''}<span>${esc(TEAM_NAMES.us)}</span><span class="caret">▾</span>`;
  document.querySelector('#padThem h2').textContent=TEAM_NAMES.them;
  $('liveTitle').textContent=c.teamName ? 'Live set' : 'Live set · sample roster';
  $('matchLink').href='./teams.html#'+new URLSearchParams({team:c.teamId,match:c.matchId});
  $('matchLink').textContent=`Match · Set ${c.setNumber??1}`;
  for(const id of ['pastSetsUs','pastSetsThem']) $(id).setAttribute('aria-label',`Previous sets, ${TEAM_NAMES.us}–${TEAM_NAMES.them} score order`);
}
let PAST_SETS = [];
const setsRecord = () => `${PAST_SETS.filter(s => s.us > s.them).length}–${PAST_SETS.filter(s => s.us < s.them).length}`;
const pastSetsStr = () => PAST_SETS.map(s => `${s.us}–${s.them}`).join(' · ');

const EARNED = ['SA', 'K', 'BK'];
const ERRORS = ['SE', 'HE', 'BKE', 'SrE', 'BHE', 'DigE', 'NET', 'VIO'];
const WORD = {
  K: 'Kill', BK: 'Block', SA: 'Ace', HE: 'Hitting<br>Error', SE: 'Serve<br>Error', SrE: 'Receive<br>Error',
  BKE: 'Block<br>Error', BHE: 'Ball<br>Handling<br>Error', DigE: 'Dig<br>Error', NET: 'Net /<br>Line', VIO: 'Other<br>Violation',
};
const words = () => document.body.classList.contains('words');
const codeName = c => (words() ? WORD[c].replaceAll('<br>', ' ') : c);
const LABEL = {
  K: 'Kill', BK: 'Block', SA: 'Ace', HE: 'Hitting err', SE: 'Serve err', SrE: 'Receive err',
  BKE: 'Block err', BHE: 'Ball handling', DigE: 'Dig err', NET: 'Net / line', VIO: 'Other violation',
};

/* Serving and serve-receive spots copied from volleyball-rotations.html ("Where do I go?").
   Same 360 x 360 grid: x across, y back from the net, attack line at y = 120;
   a coordinate is the top-left of a 48-unit player dot. Rotations come in
   pairs keyed by where the back-row setter stands (P1, P6, P5). "start" says
   which role stands in which rotational position, so we can map each role to
   the player actually standing there. */
const RECEIVE_KEY = { 1: '1,4', 6: '2,5', 5: '3,6' };   // back-row setter position -> pair
const PASS_LABEL = { OH: 'OH passes', RS: 'RS passes' };
const PASS_RATINGS = [[3,'Perfect','All attack options'],[2,'Playable','Some attack options'],
  [1,'High ball','Limited attack'],[0,'No play','Ace or no playable pass']];
const SERVE_TIP = 'Server steps behind the end line. The other five cover the court.';

// Rotational position of a point on the 360 grid (row by the attack line, column by thirds).
function gridPos(x, y) {
  const col = x < 120 ? 0 : x < 240 ? 1 : 2;
  return y < 120 ? [4, 3, 2][col] : [5, 6, 1][col];
}

// The formation for the current moment: serve receive when they serve, the
// serving spots when we serve. slot -> { left, top } (% of the court, center
// of the dot). The formation is looked up even when the coach has flipped to
// rotation spots, so the bar can still offer the passer choice.
function formation() {
  // Those frames have the setter releasing from the back row, so they fit a 6-2
  // and the three 5-1 rotations where the setter is back. Front-row setting
  // (4-2, or a 5-1 setter in 4/3/2) has no formation yet: show rotation spots.
  const key = RECEIVE_KEY[setterPos()];
  if (!key) return { none: true };
  const rot = FORMATIONS[key];
  const receiving = S.serving === 'them';
  let frame, tip, options = [], passer = null;
  if (receiving) {
    options = Object.keys(rot.passing);
    passer = options.includes(ui.passer) ? ui.passer : (options.includes('OH') ? 'OH' : options[0]);
    frame = rot.passing[passer].receive;
    tip = rot.passing[passer].passers;
  } else {
    frame = rot.serve;
    tip = SERVE_TIP;
  }
  const spots = {};
  for (const id in frame) {
    const [sx, sy] = rot.start[id];
    const [x, y0] = frame[id];
    const y = Math.min(y0, 336);   // server just behind the end line (keeps the court large)
    spots[slotAt(gridPos(sx, sy))] = { left: (x + 24) / 360 * 100, top: (y + 24) / 360 * 100 };
  }
  const editKey = `${SYSTEM}:${rotNum()}:${setterPos()}:${passer}`;
  if (receiving && receiveEdits[editKey]) {
    for (let pos = 1; pos <= 6; pos++) spots[slotAt(pos)] = { ...receiveEdits[editKey][pos] };
  }
  return { receiving, options, passer, tip, spots, editKey };
}

/* ---------------- State ---------------- */
let S, history, ui;
let receiveEdits = {};
let editingReceive = false, receiveDrag = null;
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
function command(type, payload) { return perform({type, payload}); }
async function selectReceive(passer) {
  if(receiveDrag) return;
  if(await command('receive.select',{passer})) {ui.showBase=false;render();}
}
function commit(team, code, player) {
  return command('rally', {team, code, playerId: player == null ? null : playerId(player)});
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
  S = { order:s.order.map(Number), onCourt:Object.fromEntries(Object.entries(s.onCourt).map(([k,v])=>[k,numberFor(v)])),
    libero:s.libero ? {slot:Number(s.libero.slotId), player:numberFor(s.libero.playerId),replaced:numberFor(s.libero.replacedPlayerId)} : null,
    partner:Object.fromEntries(Object.entries(s.partners).map(([k,v])=>[numberFor(k),v.length===1 ? numberFor(v[0]) : null])),
    rotations:s.rotations, rotation:s.rotation, serving:s.servingTeam, us:s.score.us, them:s.score.them,
    subs:s.substitutionsUsed, toUs:s.timeoutsRemaining.us, toThem:s.timeoutsRemaining.them, liberoFor:s.liberoFor,
    rallies:s.rallies.map(r=>({rot:`R${r.rotation} · S${r.setterPosition ?? '–'}`,rotN:r.rotation,srv:r.servingTeam,
      sv:r.serverId===null ? null : numberFor(r.serverId),bk:r.backRowPlayerIds.map(numberFor),team:r.team,code:r.code,
      player:r.playerId===null ? null : numberFor(r.playerId),us:r.score.us,them:r.score.them,winner:r.winner})),
    banners:s.prompts.filter(p=>p.type==='planned-swap').map(p=>({kind:'swap',slot:Number(p.slotId),in:numberFor(p.inPlayerId),
      out:numberFor(p.outPlayerId),text:`Planned swap: #${numberFor(p.inPlayerId)} in for #${numberFor(p.outPlayerId)}`,sub:'Confirm when the players exchange.'})) };
  if (LIBEROS.length && !s.libero && s.liberoFor !== 'none' && SLOTS[S.order[0]].role === s.liberoFor && s.status === 'live')
    S.banners.push({kind:'libero',slot:S.order[0],text:`Libero in for #${S.onCourt[S.order[0]]}?`});
  receiveEdits = clone(s.receiveEdits);
  if(ui) ui.passer=s.receivePasser;
  history = s.activeActionIds.map(id => { const a=session.record.actions.find(a=>a.id===id); return {desc:actionLabel(a)}; });
}
function actionLabel(a) {
  if(a.type==='rally') return `${TEAM_NAMES[a.payload.team]} ${a.payload.code}${a.payload.playerId ? ' #'+numberFor(a.payload.playerId) : ''}`;
  if(a.type==='receive.rating') return `Pass #${numberFor(a.payload.playerId)} · ${a.payload.rating}`;
  return {'substitution':'Substitution','libero.in':'Libero in','libero.out':'Libero out','libero.switch':'Libero switch',
    'timeout':'Timeout','receive.edit':'Receive formation','receive.select':'Receive formation choice','libero.plan':'Libero plan','set.end':'End set',
    'rally.edit':a.payload.delete ? 'Deleted rally' : 'Rally edit','correction':'Score fix'}[a.type] || a.type;
}
function status(message, error=false) {
  $('saveStatus').textContent=message; $('saveStatus').classList.toggle('error',error);
}
async function perform(cmd, clear=true) {
  if(saving || failedCommand) return false;
  if(editingReceive && !cmd.type.startsWith('receive.')) {status('Tap Done before recording another action.',true);return false;}
  saving=true; document.body.classList.add('saving'); status('Saving…');
  const pending = {...ui};
  try {
    await session.run(cmd);
    syncState();
    if(clear) { ui={...ui,pendingCode:null,pendingSlot:null,mode:null}; $('sheet').classList.remove('open'); }
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
  for (const [team, e, er] of [['us', 'usEarned', 'usErr'], ['them', 'thEarned', 'thErr']]) {
    EARNED.forEach(c => $(e).appendChild(codeBtn(team, c)));
    ERRORS.forEach(c => $(er).appendChild(codeBtn(team, c)));
  }
  // Team (no player) fills the ninth spot in our error grid: it finishes an error with no player
  // (e.g., a ball dropping between two players, or a rotation fault logged as Other Violation).
  $('usErr').appendChild($('teamBtn'));
}

function possible(team, code) {
  if (code === 'SA' || code === 'SE') return S.serving === team;
  if (code === 'SrE') return S.serving !== team;
  return true;
}

function render() {
  $('scoreTeamUs').textContent = TEAM_NAMES.us;
  $('scoreTeamThem').textContent = TEAM_NAMES.them;
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
      return `<div class="set-result ${won ? 'won' : 'lost'}" role="listitem" aria-label="Set ${s.number}: ${esc(TEAM_NAMES.us)} ${s.us}, ${esc(TEAM_NAMES.them)} ${s.them}, ${won ? 'won' : 'lost'}"><span class="set-label">Set ${s.number}</span><strong>${s.us}–${s.them}</strong></div>`;
    }).join('');
  }

  // Rotation +/- lives in the Recent rallies bar; colored boxes show runs.
  $('logMeta').innerHTML =
    `<span class="chip ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">R${cur} this set ${net > 0 ? '+' : ''}${net} (${w}–${l})</span>`;
  $('scoreBox').classList.toggle('crunch', crunch());

  // Court
  const court = $('court');
  if (!court.dataset.built) {
    court.innerHTML = '<div class="net"></div><div class="attack-line"></div><span class="court-mark"></span>';
    for (const slot in SLOTS) {
      const z = document.createElement('button');
      z.dataset.slot = slot;
      z.onclick = () => onTile(posOf(slot), +slot);
      court.appendChild(z);
    }
    court.dataset.built = '1';
  }
  const form = formation();
  const rcv = form && !form.none && !ui.showBase ? form : null;
  if (!form.receiving || form.none || ui.showBase) { editingReceive = false; $('receiveStatus').textContent = ''; }
  court.classList.toggle('editing', editingReceive);
  $('editReceive').disabled = !form.receiving || form.none;
  $('editReceive').hidden = !form.receiving || form.none;
  $('editReceive').textContent = editingReceive ? 'Done' : 'Adjust receive';
  $('editReceive').setAttribute('aria-pressed', String(editingReceive));
  $('resetReceive').hidden = !editingReceive;
  const needPlayer = ui.pendingCode || ui.mode;
  [4, 3, 2, 5, 6, 1].forEach((pos, i) => {
    const slot = slotAt(pos), p = S.onCourt[slot], info = ROSTER[p] || { n: '', r: '' };
    const z = court.querySelector(`[data-slot="${slot}"]`);
    const isLib = S.libero && S.libero.slot === slot;
    let cls = `zone ${i < 3 ? 'front' : 'backrow'}`;
    if (rcv) cls += ' rcv';
    if (ui.pendingSlot === slot) cls += ' selected';
    if (needPlayer) cls += canPick(pos, slot) ? ' pick' : ' nopick';
    z.className = cls;
    if (rcv) {
      // Hit area: a square around the dot, centered on the receive spot.
      const c = rcv.spots[slot], h = 9;
      Object.assign(z.style, { left: c.left - h + '%', top: c.top - h + '%', width: 2 * h + '%', height: 2 * h + '%' });
    } else {
      // Tap areas split between the two rows of players (42%), not on the attack line.
      Object.assign(z.style, { left: (i % 3) * 33.333 + '%', top: i < 3 ? '0%' : '42%', width: '33.333%', height: i < 3 ? '42%' : '58%' });
    }
    const disc = `disc ${isLib ? 'lib' : SLOTS[slot].role}${!isFront(pos) && !isLib ? ' back' : ''}`;
    const plan = SLOTS[slot].plan;
    const swapTag = plan && !isLib && !rcv ? `<span class="swap-tag">⇄ #${S.onCourt[slot] === plan.back ? plan.front : plan.back}</span>` : '';
    const serving = pos === 1 && S.serving === 'us';
    z.innerHTML = `<span class="pos">P${pos}</span>
      <span class="dwrap"><span class="${disc}">${p}</span>${formMark(p)}${serving ? '<span class="ball"><svg viewBox="0 0 512 512"><use href="#vb"/></svg></span>' : ''}${swapTag}</span>
      <span class="name">${info.n}<small>${info.r}</small></span>`;
  });

  // Court view (label on the court; controls in the Us pad)
  const mode = S.serving === 'them' ? 'SERVE RECEIVE' : 'SERVING';
  court.querySelector('.court-mark').textContent = `${!rcv ? 'ROTATION SPOTS' : mode} · ${rotLabel().replace(' · ', ' · ')}`;
  const tools = document.querySelector('.court-tools'), inCourt = document.body.classList.contains('tools-in');
  if (inCourt && tools.parentElement !== court) court.appendChild(tools);
  if (!inCourt && tools.parentElement === court) $('courtWrap').appendChild(tools);
  $('courtWrap').classList.toggle('serving', S.serving === 'us');
  $('rcvPassers').innerHTML = form && !form.none && form.options.length > 1
    ? form.options.map(o => `<button class="pill" data-pass="${o}" aria-pressed="${o === form.passer && !ui.showBase}">${PASS_LABEL[o]}</button>`).join('')
    : '';
  $('rcvPassers').querySelectorAll('[data-pass]').forEach(b => b.onclick = () => selectReceive(b.dataset.pass));
  $('rcvToggle').setAttribute('aria-pressed', ui.showBase ? 'true' : 'false');
  $('rcvToggle').disabled = !!(form && form.none);
  $('rcvToggle').title = form && form.none ? 'No formation yet for a front-row setter' : 'Show who is legally where';

  // Pads
  document.querySelectorAll('.code').forEach(b => {
    const team = b.dataset.team, code = b.dataset.code;
    b.disabled = editingReceive || session.state.status==='ended' || !possible(team, code);
    b.classList.toggle('pending', ui.pendingCode === code && team === 'us');
    const auto = team === 'us' && (code === 'SA' || code === 'SE');
    if (auto && !b.querySelector('.auto')) b.insertAdjacentHTML('beforeend', '<span class="auto">AUTO</span>');
  });
  const tb = $('teamBtn');
  const teamOk = ui.pendingCode && !EARNED.includes(ui.pendingCode);
  tb.disabled = !teamOk; tb.classList.toggle('ready', !!teamOk);
  let hint;
  if (ui.mode === 'sub') hint = '<b>Sub:</b> tap the player coming out. <a href="#" id="cx">Cancel</a>';
  else if (ui.mode === 'libero') hint = '<b>Libero:</b> tap the back-row player the libero replaces. <a href="#" id="cx">Cancel</a>';
  else if (ui.pendingCode) hint = `<b>${codeName(ui.pendingCode)}</b> — tap the player on the court${EARNED.includes(ui.pendingCode) ? '' : ', or Team'}. <a href="#" id="cx">Cancel</a>`;
  else if (ui.pendingSlot) hint = `<b>#${S.onCourt[ui.pendingSlot]}</b> selected — now tap a code. <a href="#" id="cx">Cancel</a>`;
  else hint = '';
  $('hintUs').innerHTML = hint;
  const cx = $('cx'); if (cx) cx.onclick = e => { e.preventDefault(); clearUi(); };

  // Actions
  $('actSub').classList.toggle('on', ui.mode === 'sub');
  $('actSub').disabled = editingReceive;
  $('actLib').disabled = editingReceive || !LIBEROS.length;
  $('actLib').classList.toggle('on', ui.mode === 'libero' || !!S.libero);
  $('actLibSm').textContent = S.libero ? `#${S.libero.player} in for #${S.libero.replaced}` : `Off · plan: ${S.liberoFor === 'none' ? 'none' : PAIR_NAME[S.liberoFor]}`;
  $('toUsBtn').disabled = editingReceive || !S.toUs; $('toThemBtn').disabled = editingReceive || !S.toThem;

  // Log
  const log = $('log');
  log.querySelector('.run-track')?.remove();
  const track = document.createElement('div');
  track.className = 'run-track';
  track.setAttribute('aria-label', 'Recent rallies, oldest to newest');
  const last = S.rallies;
  last.forEach((r, i) => {
    const c = document.createElement('div');
    c.className = `rchip${r.winner === 'them' ? ' lost' : ''}${i === last.length - 1 ? ' latest' : ''}`;
    c.setAttribute('aria-label', `${TEAM_NAMES[r.winner]} won the point`);
    const who = r.team === 'us' ? (r.player != null ? `#${r.player}` : TEAM_NAMES.us) : TEAM_NAMES.them;
    c.innerHTML = `<span class="c">${r.code} <small style="font-weight:600;font-size:12px">${esc(who)}</small></span><span class="s">${r.us}–${r.them}</span>`;
    track.appendChild(c);
    if (r.srv === 'them' && r.winner === 'us' && i < last.length - 1) {
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
  fitRecentRallies();

  renderCorner();

  // Undo
  $('undoBtn').disabled = editingReceive || history.length === 0;
  $('undoSm').textContent = history.length ? history[history.length - 1].desc : 'nothing to undo';

  // Banners
  const bn = $('banners'); bn.innerHTML = '';
  S.banners.forEach((b, i) => {
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
  $('calloutBanner').style.display = S.banners.length ? '' : 'none';
  if(session.state.status==='ended') {
    for(const id of ['actSub','actLib','toUsBtn','toThemBtn','teamBtn','editReceive']) $(id).disabled=true;
  }

}

/* ---------------- Libero plan: should she play, and for whom? ----------------
   The libero only ever plays back row, so compare everyone on the same thing:
   back-row passing/defense errors (Receive, Dig, Ball Handling) per back-row
   rally, this season plus tonight. The pair with the worse rate gains the most. */
// Demo only: season-to-date before tonight, [back-row rallies, errors there].
const PAIR_NAME = {mid:'middles',oh:'outsides'};
function openLiberoPlan() {
  const other=LIBEROS.find(l=>l!==S.libero?.player);
  openSheet(`<h4>Libero plan</h4><p>${S.libero ? `#${S.libero.player} is in for #${S.libero.replaced}.` : 'Libero is off the court.'}</p>
    <div class="lib-plan">${['mid','oh','none'].map(role=>`<button class="pill" data-plan="${role}" aria-pressed="${S.liberoFor===role}">${PAIR_NAME[role] || 'No libero'}</button>`).join('')}</div>
    <div class="two">${S.libero ? `<button id="libOut">Libero out</button><button id="libSw" ${other == null ? 'disabled' : ''}>Switch to #${other ?? '—'}</button>` : '<button id="libIn">Put libero in</button>'}</div>
    <button class="cancel" id="shCancel">Close</button>`);
  $('sheetCard').querySelectorAll('[data-plan]').forEach(b=>b.onclick=async()=>{if(await command('libero.plan',{role:b.dataset.plan})) openLiberoPlan();});
  if(S.libero) { $('libOut').onclick=liberoOut; $('libSw').onclick=()=>liberoSwitch(other); }
  else $('libIn').onclick=()=>{closeSheet();ui.mode='libero';render();};
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
  const lt = crunch();
  const f = formation();
  for (const { pos, p } of onCourt) {
    const F = formOf(p);
    // Ride the hot hand.
    if (F.hotHit && ROSTER[p].r !== 'L') {
      const o = frontOutlook(pos);
      out.push({ key: `hot-${p}-${F.kills}`, pri: lt ? 2.5 : 4.5,
        title: o.front ? `Ride #${p}: ${F.lastSw.filter(x => x.r.code === 'K').length} kills in her last ${F.lastSw.length} terminal attacks` : `#${p} is hot but in the back row`,
        why: `Last terminal attacks: ${recent(F.lastSw, 'K')}. ` + (o.front
          ? (o.more === 0 ? 'Front row this rotation only — set her now.' : `Front row for ${o.more} more rotation${o.more === 1 ? '' : 's'}.`)
          : `She's front again after ${o.until} side-out${o.until === 1 ? '' : 's'}.`) });
    }
    // Help the weak link: hitting.
    if (F.coldHit)
      out.push({ key: `coldhit-${p}-${F.errs}`, pri: lt ? 3 : 5.5, title: `#${p}: ${F.last3.filter(x => x.r.code === 'HE').length} hitting errors in her last ${F.last3.length} terminal attacks`,
        why: `Last terminal attacks: ${recent(F.last3, 'K')}. Shots and tips, or set elsewhere for a few.` });
    if (F.weakPass && !LIBEROS.includes(p) && S.serving==='them') {
      const n=F.lastRc.filter(r=>r.code==='SrE' && r.player===p).length;
      out.push({key:`weakpass-${p}-${n}`,pri:lt?2:4,urgent:lt,title:`Review #${p}'s receive position`,
        why:`${n} receive errors in her last ${F.lastRc.length} back-row receiving rallies. Consider adjusting coverage.`});
    }
    // Serving: hot server serving now; cold server serving now or next.
    const servingNow = S.serving === 'us' && pos === 1;
    const servesNext = S.serving === 'them' && pos === 2;   // she rotates to P1 on our side-out
    if (F.hotServe && servingNow)
      out.push({ key: `hotsrv-${p}-${F.serves.length}`, pri: 7, title: `#${p} is serving well: stay aggressive`,
        why: `Last serves: ${F.lastSv.map(r => r.team === 'us' && r.code === 'SA' ? 'ace' : r.team === 'us' && r.code === 'SE' ? 'miss' : 'in').join(', ')}.` });
    if (F.coldServe && (servingNow || servesNext))
      out.push({ key: `coldsrv-${p}-${F.serves.length}`, pri: lt ? 1.8 : 3.8, urgent: lt,
        title: servesNext ? `Heads-up: #${p} serves next` : `#${p} is serving: ${F.lastSv.filter(r => r.code === 'SE').length} misses in her last ${F.lastSv.length}`,
        why: `Last serves: ${F.lastSv.map(r => r.team === 'us' && r.code === 'SA' ? 'ace' : r.team === 'us' && r.code === 'SE' ? 'miss' : 'in').join(', ')}. Remind her: serve it in play.` });
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

  return out.filter(t => !dismissed.has(t.key) && SETTINGS.categories[tipCategory(t)] !== false).sort((a, b) => a.pri - b.pri);
}

function tipCategory(t) {
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
    ? tips.map((t, i) => `<div class="tip${t.urgent ? ' urgent' : ''}${(t.acts || []).length ? ' has-acts' : ''}" data-category="${tipCategory(t)}" data-i="${i}"><b>${t.title}</b><button class="x" data-k="${t.key}" aria-label="Dismiss">×</button><span>${t.why}</span>${
        (t.acts || []).length ? `<div class="acts">${t.acts.map((a, j) => `<button class="pill" data-t="${i}" data-a="${j}">${a.label}</button>`).join('')}</div>` : ''}</div>`).join('')
    : `<div class="quiet">${session.state.status === 'ended' ? `Set complete · ${S.us}–${S.them}` : SETTINGS.corner ? 'Nothing to flag right now.' : 'Coach’s corner is off. Turn it on in Settings.'}</div>`;
  $('corner').classList.toggle('has-more', extra > 0);
  if (extra > 0) {
    $('corner').insertAdjacentHTML('beforeend', `<button class="more-tips" id="moreTips">+${extra} more</button>`);
    // Only the suggestions that aren't already on screen.
    const rest = all.slice(tips.length);
    $('moreTips').onclick = () => {
      openSheet(`<h4>More suggestions</h4>
        ${rest.map((t, i) => `<div class="tip${t.urgent ? ' urgent' : ''}" data-category="${tipCategory(t)}" style="margin-bottom:8px"><b>${t.title}</b><button class="x" data-rk="${t.key}" aria-label="Dismiss">×</button><span style="grid-column:1/-1">${t.why}</span>${
          (t.acts || []).length ? `<div class="acts" style="grid-column:1/-1">${t.acts.map((a, j) => `<button class="pill" data-ri="${i}" data-ra="${j}">${a.label}</button>`).join('')}</div>` : ''}</div>`).join('')}
        <button class="cancel" id="shCancel">Close</button>`);
      $('sheetCard').querySelectorAll('[data-rk]').forEach(b => b.onclick = () => { dismissed.add(b.dataset.rk); closeSheet(); });
      $('sheetCard').querySelectorAll('[data-ra]').forEach(b => b.onclick = () => { closeSheet(); rest[b.dataset.ri].acts[b.dataset.ra].fn(); });
    };
  }
  $('corner').querySelectorAll('button[data-k]').forEach(b => b.onclick = () => { dismissed.add(b.dataset.k); render(); });
  $('corner').querySelectorAll('button[data-a]').forEach(b => b.onclick = e => { e.stopPropagation(); tips[b.dataset.t].acts[b.dataset.a].fn(); });
  $('corner').querySelectorAll('button[data-k]').forEach(b => b.addEventListener('click', e => e.stopPropagation()));
  // Tap a suggestion to read it in full.
  $('corner').querySelectorAll('.tip').forEach(el => el.onclick = () => {
    const t = tips[el.dataset.i];
    openSheet(`<div class="tip${t.urgent ? ' urgent' : ''}" data-category="${tipCategory(t)}"><b>${t.title}</b><span>${t.why}</span></div>
      ${(t.acts || []).length ? `<div class="lib-plan">${t.acts.map((a, j) => `<button class="pill" data-a="${j}">${a.label}</button>`).join('')}</div>` : ''}
      <div class="sheet-row"><button class="cancel" id="shCancel">Close</button><button class="ovr" id="shDismiss">Dismiss</button></div>`);
    $('sheetCard').querySelectorAll('[data-a]').forEach(b => b.onclick = () => { closeSheet(); t.acts[b.dataset.a].fn(); });
    $('shDismiss').onclick = () => { dismissed.add(t.key); closeSheet(); };
  });
  $('toUsBtn').classList.toggle('suggest', all.some(t => t.to) && S.toUs > 0);
}

// ▲ hot (hitting or serving), ▼ weak link (hitting, serving or passing).
function formMark(p) {
  if (!ROSTER[p]) return '';
  const F = formOf(p);
  if (F.coldHit || F.coldServe || F.weakPass) return '<span class="form cold" title="Struggling lately">▼</span>';
  const servingNow = S.serving === 'us' && server() === p;
  const hotServing = F.hotServe && servingNow;
  if (F.hotHit || hotServing) {
    const title = F.hotHit && hotServing ? 'Attacking and serving well lately'
      : F.hotHit ? 'Attacking well lately' : 'Serving well lately';
    return `<span class="form hot" title="${title}" aria-label="${title}">▲</span>`;
  }
  return '';
}

// Keep the newest contiguous history that fits, with dividers only between visible rallies.
// Reconsider all entries when the available width or font metrics change.
function fitRecentRallies() {
  const track = $('log').querySelector('.run-track');
  if (!track) return;
  const nodes = [...track.children];
  nodes.forEach(n => { n.hidden = false; });
  let first = 0;
  while (track.scrollWidth > track.clientWidth && first < nodes.length) {
    nodes[first++].hidden = true;
    while (first < nodes.length && nodes[first].classList.contains('sideout-divider'))
      nodes[first++].hidden = true;
  }
}

function canPick(pos, slot) {
  if (ui.mode === 'libero') return !isFront(pos) && !(S.libero && S.libero.slot === slot);
  return true;
}

function passRatingLoggedForCurrentPoint() {
  if (!session) return false;
  const activeActions = new Set(session.state.activeActionIds);
  const recordedRallies = new Set(session.state.rallies.map(r => r.actionId));
  for (let i = session.record.actions.length - 1; i >= 0; i--) {
    const action = session.record.actions[i];
    if (!activeActions.has(action.id)) continue;
    if (action.type === 'receive.rating') return true;
    if (action.type === 'rally' && recordedRallies.has(action.id)) return false;
  }
  return false;
}

function clearUi() { ui = { ...ui, pendingCode: null, pendingSlot: null, mode: null }; render(); }

/* ---------------- Interaction ---------------- */
function onCode(team, code) {
  if (ui.mode) return;
  if (team === 'them') { commit('them', code, null); return; }
  if (code === 'SA' || code === 'SE') { commit('us', code, server()); return; }
  if (ui.pendingSlot) { commit('us', code, S.onCourt[ui.pendingSlot]); return; }
  ui.pendingCode = ui.pendingCode === code ? null : code;
  render();
}

function onTile(pos, slot) {
  if (editingReceive) return;
  if (ui.mode === 'sub') { ui.mode = null; openBench(slot); return; }
  if (ui.mode === 'libero') {
    if (!canPick(pos, slot)) return;
    const avail = LIBEROS.filter(l => !(S.libero && S.libero.player === l));
    liberoIn(slot, avail[0]); render(); return;
  }
  if (ui.pendingCode) { commit('us', ui.pendingCode, S.onCourt[slot]); return; }
  if (S.serving === 'them') {
    if (!passRatingLoggedForCurrentPoint()) openPassRating(S.onCourt[slot]);
    return;
  }
  ui.pendingSlot = ui.pendingSlot === slot ? null : slot;
  render();
}

function openPassRating(number) {
  const person=ROSTER[number], rosterId=playerId(number);
  if(!person||!rosterId||S.serving!=='them') return;
  openSheet(`<h4>Serve receive · #${number}</h4><p>${person.n} · choose a pass score.</p>
    <div class="pass-rating-grid">${PASS_RATINGS.map(([rating,title,description])=>`<button type="button" data-rating="${rating}" aria-label="Pass score ${rating}: ${title}, ${description}"><b>${rating}</b><span><strong>${title}</strong><small>${description}</small></span></button>`).join('')}</div>
    <button class="cancel" id="shCancel">Cancel</button>`);
  $('sheetCard').querySelectorAll('[data-rating]').forEach(button=>button.onclick=()=>{
    closeSheet();
    void command('receive.rating',{playerId:rosterId,rating:Number(button.dataset.rating)});
  });
}

/* Manual receive editor: only the selected player moves. Validate every proposed
   layout before displaying it. Coordinates describe player-disc centers, not feet. */
$('editReceive').onclick = () => {
  if(receiveDrag) return;
  editingReceive = !editingReceive;
  if (editingReceive) {
    ui.showBase=false; ui.pendingCode=null; ui.pendingSlot=null; ui.mode=null;
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
  if(saving || failedCommand || !editingReceive || !tile || (e.button !== 0 && e.pointerType==='mouse')) return;
  if (receiveDrag) return;
  const form=formation();
  const rect=editCourt.getBoundingClientRect(), spot=form.spots[+tile.dataset.slot];
  receiveDrag={id:e.pointerId, pos:posOf(+tile.dataset.slot), form, context:JSON.stringify([S.order,S.onCourt,S.serving,SYSTEM,ui.passer,ui.showBase]),
    offset:{left:(e.clientX-rect.left)/rect.width*100-spot.left,top:(e.clientY-rect.top)/rect.height*100-spot.top},
    original:receivePositions(form), before:receiveEdits[form.editKey] ? clone(receiveEdits[form.editKey]) : null};
  editCourt.setPointerCapture(e.pointerId); e.preventDefault();
});
editCourt.addEventListener('pointermove', e => {
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
editCourt.addEventListener('pointerup', e=>finishReceiveDrag(e,false));
editCourt.addEventListener('pointercancel', e=>finishReceiveDrag(e,true));
editCourt.addEventListener('lostpointercapture', e=>finishReceiveDrag(e,true));
editCourt.addEventListener('keydown', async e=>{
  const tile=e.target.closest('[data-slot]'), delta={ArrowLeft:[-2,0],ArrowRight:[2,0],ArrowUp:[0,-2],ArrowDown:[0,2]}[e.key];
  if(saving || failedCommand || !editingReceive || !tile || !delta) return;
  e.preventDefault();
  const form=formation(), original=receivePositions(form), pos=posOf(+tile.dataset.slot);
  const result=movedReceive(original,pos,{left:original[pos].left+delta[0],top:original[pos].top+delta[1]});
  const error=receiveLayoutError(result);
  if(!error) {
    receiveEdits[form.editKey]=result;
    $('receiveStatus').textContent=await saveReceiveEdits() ? 'Legal order maintained · formation saved.' : 'Move was not saved; last saved position restored.';
    render();
  } else $('receiveStatus').textContent=`Move blocked: ${error}`;
});

$('rcvToggle').onclick = () => { if(receiveDrag) return; ui.showBase = !ui.showBase; render(); };

$('teamBtn').onclick = () => { if (ui.pendingCode) { commit('us', ui.pendingCode, null); } };

$('undoBtn').onclick = () => command('undo', {});

$('actSub').onclick = () => { ui = { ...ui, pendingCode: null, pendingSlot: null, mode: ui.mode === 'sub' ? null : 'sub' }; render(); };

$('actLib').onclick = () => {
  if (ui.mode === 'libero') { ui = { ...ui, mode: null }; render(); return; }
  openLiberoPlan();
};

function callTimeout(team) { return command('timeout', {team}); }
$('teamMenu').onclick = () => $('menuBtn').onclick();
const TEAM_MENU = [
  ['rotation-report', 'Rotation report', "The paper sheet’s six columns, with +/- per rotation"],
  ['lineup', 'Lineup', "This set’s lineup, planned swaps and libero plan"],
  ['edit-rallies', 'Edit rallies', 'Fix or delete any logged rally'],
  ['fix-score', 'Fix score / rotation / server', 'Match the official scoresheet'],
  ['match-summary', 'Match summary', 'Set scores, key stats, rotation tables'],
  ['switch-team', 'Switch team', 'Keep this set saved and open Teams, rosters, and match setup'],
  ['settings', 'Settings', "Coach’s corner rules, button labels, rule presets"],
];
$('menuBtn').onclick = () => {
  openSheet(`<h4>${esc(TEAM_NAMES.us)} · ${esc(TEAM_NAMES.them)}</h4>
    <div class="menu-list">${TEAM_MENU.map(([id, title, description]) => {
      return `<button data-menu="${id}"><b>${title}</b><span>${description}</span></button>`;
    }).join('')}</div>
    <button class="cancel" id="shCancel">Close</button>`);
  const screens = { 'rotation-report': rotationReport, lineup: lineupSheet, 'edit-rallies': editRallies, 'fix-score': fixScore,
    'match-summary': matchSummary, settings: settingsSheet };
  $('sheetCard').querySelectorAll('[data-menu]').forEach(b => b.onclick = () => {
    if (b.dataset.menu === 'switch-team') { location.href = './teams.html'; return; }
    screens[b.dataset.menu](menuContext);
  });
};
// What the menu screens need from the live page; getters so they always see committed state.
const menuContext = {
  get record() { return session.record; }, get state() { return session.state; }, get teams() { return TEAM_NAMES; },
  matchRecords: () => MATCH_RECORDS.map(r => r.config.id === session.record.config.id ? session.record : r),
  open: (html, wide) => openSheet(html, wide), close: () => closeSheet(),
  command: (type, payload) => command(type, payload), check: cmd => checkCommand(session.record, cmd),
  openLiberoPlan: () => openLiberoPlan(),
  settings: () => ({...SETTINGS,theme:ACTIVE_THEME||SETTINGS.theme}), saveSettings: next => { SETTINGS = next; ACTIVE_THEME=next.theme; saveSettings(next); applySettings(); render(); },
};
function applySettings() {
  applyColorTheme(ACTIVE_THEME||SETTINGS.theme);
  document.body.classList.toggle('words', SETTINGS.labels !== 'codes');
  html.classList.toggle('dark', SETTINGS.appearance === 'dark'); html.classList.toggle('light', SETTINGS.appearance === 'light');
  document.body.classList.toggle('corner-off', !SETTINGS.corner);
}

$('toUsBtn').onclick = () => callTimeout('us');
$('toThemBtn').onclick = () => callTimeout('them');

// More: show the rare team-fault codes; they fold away again after use.

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

function openSheet(html, wide = false) {
  $('sheetCard').innerHTML = html; $('sheetCard').classList.toggle('wide', wide); $('sheet').classList.add('open');
  $('shCancel').onclick = closeSheet;
}
function closeSheet() { $('sheet').classList.remove('open'); clearUi(); }
$('sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };

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
  const avail = window.innerWidth - 36;
  const k = Math.min(1, avail / 1386);
  const sc = $('scaler');
  sc.style.transform = `scale(${k})`;
  sc.style.height = (1024 * k) + 'px';
  document.querySelector('.notes').style.maxWidth = (1366 * k) + 'px';
}
window.addEventListener('resize', fit);
new ResizeObserver(fitRecentRallies).observe($('log'));
document.fonts.ready.then(fitRecentRallies);
// Player dots scale with the court.
new ResizeObserver(([e]) => { $('court').style.setProperty('--cw', e.contentRect.width + 'px'); $('courtWrap').style.setProperty('--cw', e.contentRect.width + 'px'); }).observe($('court'));


async function start() {
  document.body.classList.add('saving');
  try {
    store?.close(); store=await openSetStore();
    let record=await store.loadActive();
    if(!record) {location.replace('./teams.html');return;}
    const [allSets,savedTeams]=await Promise.all([store.listSets(),store.listTeams()]);
    const siblings=orderMatchSets(allSets.filter(r=>r.config.teamId===record.config.teamId&&r.config.matchId===record.config.matchId));
    const currentIndex=siblings.findIndex(r=>r.config.id===record.config.id);MATCH_RECORDS=siblings;
    PAST_SETS=siblings.slice(0,currentIndex).flatMap((r,i)=>{const state=replaySet(r);return state.status==='ended'?[{...state.score,number:r.config.setNumber??i+1}]:[];});
    configureLive(record,savedTeams.find(team=>team.id===record.config.teamId));applySettings();
    $('matchLink').textContent=`Match · Set ${record.config.setNumber??currentIndex+1}`;
    session=new SetSession(store,record); syncState();
    ui={pendingCode:null,pendingSlot:null,mode:null,passer:session.state.receivePasser,showBase:false};
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
$('reloadSaved').onclick=()=>{editingReceive=false;receiveDrag=null;$('sheet').classList.remove('open');start();};
$('exportSet').onclick=()=>{
  if(!session)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(session.record,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='volleyball-set.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
// Prevent keyboard activation as well as pointer input while an action is unresolved.
for(const event of ['click','keydown','pointerdown']) document.addEventListener(event,e=>{
  if((saving || document.body.classList.contains('saving') || failedCommand || document.body.classList.contains('failed')) && e.target.closest('.stage, #teamsLink, #matchLink')) {
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
