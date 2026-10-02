// Team-menu screens on the live page: rotation report, lineup, edit rallies,
// scoresheet corrections, match summary, and settings. Every change goes through
// the same journal as scoring, so it is saved, replayed, and undoable.
import { ACTION_CODES, getSetStats, replaySet, setterPosition } from '../engine/set-engine.mjs';
import { COLOR_THEMES } from './themes.mjs';
import { matchSetLineups } from '../teams/stats-model.mjs';
export { COLOR_THEMES, DEFAULT_SETTINGS, loadSettings } from './themes.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CODES = Object.keys(ACTION_CODES);
const WORDS = { K: 'Kill', BK: 'Block', SA: 'Ace', HE: 'Hitting error', SE: 'Serve error', SrE: 'Receive error',
  BKE: 'Block error', BHE: 'Ball handling', DigE: 'Dig error', NET: 'Net / line', VIO: 'Other violation' };
const pct = x => x === null ? '—' : `${Math.round(x * 100)}%`;
const signed = n => n > 0 ? `+${n}` : String(n);
const COURT = [4, 3, 2, 5, 6, 1];
const rotated = (order, r) => [...order.slice(r - 1), ...order.slice(0, r - 1)];
// Scoring pads share data-team/data-code attributes, so every lookup stays inside the sheet.
const sheet = () => document.getElementById('sheetCard');

export const TIP_CATEGORIES = [['timeout', 'Timeouts and runs'], ['passing', 'Passing and libero'], ['attacking', 'Attacking'],
  ['serving', 'Serving'], ['rotation', 'Rotations'], ['management', 'Subs and other']];
function people(config, currentRoster = []) {
  const byId = new Map(config.players.map(p => [p.id, p]));
  currentRoster.forEach(player => byId.set(player.id, player));
  return { jersey: id => byId.get(id)?.jersey ?? '', name: id => esc(byId.get(id)?.name || `#${byId.get(id)?.jersey ?? '?'}`) };
}
function miniCourt(config, order, onCourt, { serving = false, label = '', roster = [] } = {}) {
  const { jersey, name } = people(config, roster);
  return `<div class="mini-court" aria-label="${esc(label)}">${COURT.map(pos => {
    const id = onCourt[order[pos - 1]];
    return `<div class="${pos === 1 && serving ? 'srv' : ''}${[5, 6, 1].includes(pos) ? ' back' : ''}"><small>P${pos}</small><b>${esc(jersey(id))}</b><span>${name(id)}</span></div>`;
  }).join('')}</div>`;
}
function setterAt(config, order, onCourt) { return setterPosition(config, { order, onCourt }); }

/* Rotation report: the paper sheet's six columns. */
export function rotationReport(ctx) {
  const { record, state } = ctx, c = record.config, { jersey } = people(c, ctx.players), stats = getSetStats(state).rotations;
  const records = ctx.matchRecords?.() ?? [record];
  const index = records.findIndex(item => item.config.id === c.id);
  const lineup = matchSetLineups(records)[index < 0 ? 0 : index]
    ?? { name: c.lineupTemplate?.name || 'Custom lineup', inheritedFromSet: null };
  const starters = Object.fromEntries(c.slots.map(s => [s.id, s.playerId]));
  const played = Object.values(stats).filter(r => r.won + r.lost);
  const best = played.length > 1 ? Math.max(...played.map(r => r.net)) : null, worst = played.length > 1 ? Math.min(...played.map(r => r.net)) : null;
  const columns = [1, 2, 3, 4, 5, 6].map(r => {
    const order = rotated(c.order, r), rallies = state.rallies.filter(x => x.rotation === r), t = stats[r];
    const sp = rallies.at(-1)?.setterPosition ?? setterAt(c, order, state.onCourt);
    const heat = t.won + t.lost && best !== worst ? (t.net === best ? ' best' : t.net === worst ? ' worst' : '') : '';
    return `<section class="rr-col${heat}${r === state.rotation && state.status === 'live' ? ' now' : ''}" data-rotation="${r}">
      <header><b>R${r}</b><span>${sp ? `S${sp}` : 'S–'}</span></header>
      ${miniCourt(c, order, starters, { serving: true, label: `R${r} starting positions`, roster: ctx.players })}
      <table class="rr-log"><colgroup><col class="j"><col><col><col><col></colgroup><thead><tr><th colspan="3">${esc(ctx.teams.us)}</th><th colspan="2">${esc(ctx.teams.them)}</th></tr></thead><tbody>
      ${rallies.map(x => `<tr class="${x.winner === 'us' ? 'won' : 'lost'}${x.edited ? ' edited' : ''}"><td>${x.team === 'us' && x.playerId ? esc(jersey(x.playerId)) : ''}</td><td>${x.team === 'us' ? x.code : ''}</td><td>${x.score.us}</td><td>${x.score.them}</td><td>${x.team === 'them' ? x.code : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No rallies</td></tr>'}
      </tbody></table>
      <dl class="rr-tot"><dt>Won–lost</dt><dd>${t.won}–${t.lost}</dd><dt>+/-</dt><dd>${signed(t.net)}</dd><dt>Rallies</dt><dd>${t.won + t.lost}</dd>
        <dt>Sideout</dt><dd>${pct(t.sideoutRate)}</dd><dt>Point-scoring</dt><dd>${pct(t.scoringRate)}</dd></dl></section>`;
  }).join('');
  const fixes = state.corrections.map(f => `<li>At ${f.from.score.us}–${f.from.score.them} (R${f.from.rotation}): set to ${f.to.score.us}–${f.to.score.them}, R${f.to.rotation}, ${esc(ctx.teams[f.to.servingTeam])} serving${f.reason ? ` · ${esc(f.reason)}` : ''}</li>`).join('');
  ctx.open(`<h4>Rotation report · Set ${c.setNumber ?? 1}</h4>
    <p>${esc(ctx.teams.us)} ${state.score.us}–${state.score.them} ${esc(ctx.teams.them)} · ${c.system} · ${esc(lineup.name)}${lineup.inheritedFromSet ? ` (continued from Set ${lineup.inheritedFromSet})` : ''}. Each rally is listed in the rotation we were in when it was played. Sideout = rallies won when receiving; point-scoring = rallies won when serving.${best !== null && best !== worst ? ' Best and worst rotations are highlighted.' : ''}</p>
    <div class="rr">${columns}</div>
    ${fixes ? `<h5>Scoresheet fixes</h5><ul class="fix-list">${fixes}</ul>` : ''}
    <button class="cancel" id="shCancel">${esc(ctx.closeLabel || 'Close')}</button>`, true);
}

/* Lineup: this set's lineup, current court, planned swaps, libero plan, and substitutions. */
export function lineupSheet(ctx) {
  const { record, state } = ctx, c = record.config, { jersey, name } = people(c, ctx.players);
  const start = Object.fromEntries(c.slots.map(s => [s.id, s.playerId]));
  const initial = rotated(c.order, c.startingRotation ?? 1);
  const plans = c.slots.filter(s => s.plan).map(s => `<li>#${esc(jersey(s.plan.frontPlayerId))} front row ⇄ #${esc(jersey(s.plan.backPlayerId))} back row</li>`).join('');
  const subs = state.substitutions.map(s => `<li>${s.score.us}–${s.score.them} · R${s.rotation}: #${esc(jersey(s.inPlayerId))} in for #${esc(jersey(s.outPlayerId))}${s.planned ? ' (planned)' : ''}${s.overridden ? ' (override)' : ''}</li>`).join('');
  const libero = { mid: 'For the middles', oh: 'For the outsides', none: 'No libero' }[state.liberoFor];
  ctx.open(`<h4>Lineup · Set ${c.setNumber ?? 1}</h4>
    <p>${c.system}${c.lineupTemplate ? ` · ${esc(c.lineupTemplate.name)}` : ''} · Setter${c.setters.length > 1 ? 's' : ''} ${c.setters.map(id => `#${esc(jersey(id))} ${name(id)}`).join(', ')}${c.liberos.length ? ` · Libero${c.liberos.length > 1 ? 's' : ''} ${c.liberos.map(id => `#${esc(jersey(id))} ${name(id)}`).join(', ')}` : ''}</p>
    <div class="two-courts"><div><h5>Started in R${c.startingRotation ?? 1}</h5>${miniCourt(c, initial, start, { serving: c.firstServe === 'us', label: 'Starting court', roster: ctx.players })}</div>
      <div><h5>Now · R${state.rotation}</h5>${miniCourt(c, state.order, state.onCourt, { serving: state.servingTeam === 'us', label: 'Current court', roster: ctx.players })}</div></div>
    <div class="lineup-facts"><div><h5>Planned swaps</h5>${plans ? `<ul>${plans}</ul>` : '<p>None</p>'}</div>
      <div><h5>Libero plan</h5><p>${c.liberos.length ? libero : 'No libero designated'}</p>${c.liberos.length ? '<button class="pill" id="lineupLibero">Change libero plan</button>' : ''}</div>
      <div><h5>Substitutions · ${state.substitutionsUsed} of ${c.rules.substitutionLimit} used</h5>${subs ? `<ul>${subs}</ul>` : '<p>None yet</p>'}</div></div>
    <button class="cancel" id="shCancel">Close</button>`);
  document.getElementById('lineupLibero')?.addEventListener('click', ctx.openLiberoPlan);
}

/* Edit rallies: change the team, code, or player of any rally, or delete it. */
export function editRallies(ctx) {
  const { state, record } = ctx, { jersey } = people(record.config);
  const describe = r => `${esc(ctx.teams[r.team])} ${WORDS[r.code]}${r.team === 'us' && r.playerId ? ` #${esc(jersey(r.playerId))}` : ''}`;
  const rows = [...state.rallies].reverse().map(r => `<button class="rally-row ${r.winner === 'us' ? 'won' : 'lost'}" data-rally="${esc(r.actionId)}">
    <span class="n">${r.seq}</span><b>${r.score.us}–${r.score.them}</b><span>${describe(r)}${r.edited ? ' <em>edited</em>' : ''}</span><small>R${r.rotation}</small></button>`).join('');
  ctx.open(`<h4>Edit rallies</h4><p>${state.rallies.length ? 'Newest first. Tap a rally to change it or delete it. Later score, rotation, serve, and stats update automatically, and Undo reverses the change.' : 'No rallies recorded in this set yet.'}</p>
    <div class="rally-list">${rows}</div><button class="cancel" id="shCancel">Close</button>`);
  sheet().querySelectorAll('[data-rally]').forEach(b => b.onclick = () => editRally(ctx, b.dataset.rally));
}
function editRally(ctx, actionId) {
  const { state, record } = ctx, rally = state.rallies.find(r => r.actionId === actionId), { jersey, name } = people(record.config);
  let draft = { team: rally.team, code: rally.code, playerId: rally.team === 'us' && !['SA', 'SE'].includes(rally.code) ? rally.playerId : null };
  const payload = () => ({ targetActionId: actionId, team: draft.team, code: draft.code, ...(draft.team === 'us' && draft.playerId ? { playerId: draft.playerId } : {}) });
  const draw = () => {
    const serveCode = ['SA', 'SE'].includes(draft.code), earned = ACTION_CODES[draft.code] === 'earned';
    const codeAllowed = code => (!['SA', 'SE'].includes(code) || rally.servingTeam === draft.team) && (code !== 'SrE' || rally.servingTeam !== draft.team);
    const needsPlayer = draft.team === 'us' && !serveCode;
    const unchanged = draft.team === rally.team && draft.code === rally.code && (serveCode || (draft.playerId ?? null) === (rally.team === 'us' ? rally.playerId : null));
    const check = ctx.check({ type: 'rally.edit', payload: payload() });
    const problem = needsPlayer && earned && !draft.playerId ? 'Choose the player who earned the point.' : check.allowed ? '' : check.error.message;
    ctx.open(`<h4>Rally ${rally.seq} · ${rally.score.us}–${rally.score.them}</h4>
      <p>R${rally.rotation} · ${esc(ctx.teams[rally.servingTeam])} served. Recorded as ${esc(ctx.teams[rally.team])} ${WORDS[rally.code]}${rally.team === 'us' && rally.playerId ? ` #${esc(jersey(rally.playerId))}` : ''}.</p>
      <h5>Who made the final contact?</h5><div class="seg">${['us', 'them'].map(t => `<button data-team="${t}" class="${draft.team === t ? 'on' : ''}">${esc(ctx.teams[t])}</button>`).join('')}</div>
      <h5>What happened?</h5><div class="code-grid">${CODES.map(code => `<button data-code="${code}" class="${draft.code === code ? 'on ' : ''}${(ACTION_CODES[code] === 'earned') === (draft.team === 'us') ? 'win' : 'lose'}" ${codeAllowed(code) ? '' : 'disabled'}>${WORDS[code]}</button>`).join('')}</div>
      ${needsPlayer ? `<h5>Player</h5><div class="player-grid">${rally.court.map(p => `<button data-player="${esc(p.playerId)}" class="${draft.playerId === p.playerId ? 'on' : ''}"><b>${esc(jersey(p.playerId))}</b><span>${name(p.playerId)}</span></button>`).join('')}${earned ? '' : `<button data-player="" class="${draft.playerId ? '' : 'on'}"><b>Team</b><span>No player</span></button>`}</div>`
        : draft.team === 'us' ? `<p>The server, #${esc(jersey(rally.serverId))}, is filled in automatically.</p>` : ''}
      <p class="edit-error" role="alert">${esc(unchanged ? '' : problem)}</p>
      <div class="sheet-row"><button class="cancel" id="shBack">Back</button><button class="danger-btn" id="shDelete">Delete rally</button><button class="save-btn" id="shSave" ${unchanged || problem ? 'disabled' : ''}>Save change</button></div>
      <button class="cancel" id="shCancel" hidden>Close</button>`);
    const q = s => sheet().querySelectorAll(s);
    q('[data-team]').forEach(b => b.onclick = () => { draft.team = b.dataset.team; if (!codeAllowed(draft.code)) draft.code = 'K'; draft.playerId = null; draw(); });
    q('[data-code]').forEach(b => b.onclick = () => { draft.code = b.dataset.code; if (ACTION_CODES[draft.code] === 'earned' && !draft.playerId && draft.team === 'us') draft.playerId = null; draw(); });
    q('[data-player]').forEach(b => b.onclick = () => { draft.playerId = b.dataset.player || null; draw(); });
    document.getElementById('shBack').onclick = () => editRallies(ctx);
    document.getElementById('shSave').onclick = async () => { if (await ctx.command('rally.edit', payload())) editRallies(ctx); };
    document.getElementById('shDelete').onclick = async () => {
      const check = ctx.check({ type: 'rally.edit', payload: { targetActionId: actionId, delete: true } });
      if (!check.allowed) { sheet().querySelector('.edit-error').textContent = check.error.message; return; }
      if (confirm(`Delete rally ${rally.seq} (${rally.score.us}–${rally.score.them})? Later scores and rotations will update. Undo can bring it back.`)
        && await ctx.command('rally.edit', { targetActionId: actionId, delete: true })) editRallies(ctx);
    };
  };
  draw();
}

/* Fix score / rotation / server to match the official scoresheet. */
export function fixScore(ctx) {
  const s = ctx.state, draft = { us: s.score.us, them: s.score.them, rotation: s.rotation, servingTeam: s.servingTeam, reason: '' };
  const draw = () => {
    const payload = () => ({ score: { us: draft.us, them: draft.them }, rotation: draft.rotation, servingTeam: draft.servingTeam, ...(draft.reason.trim() ? { reason: draft.reason } : {}) });
    const check = ctx.check({ type: 'correction', payload: payload() });
    const same = draft.us === s.score.us && draft.them === s.score.them && draft.rotation === s.rotation && draft.servingTeam === s.servingTeam;
    ctx.open(`<h4>Fix score / rotation / server</h4>
      <p>Match the official scoresheet. Player and rotation stats keep the rallies as recorded; the fix is saved in the history and Undo reverses it.</p>
      <div class="fix-scores">${['us', 'them'].map(t => `<div><h5>${esc(ctx.teams[t])}</h5><div class="stepper"><button data-step="${t}" data-d="-1" aria-label="${esc(ctx.teams[t])} minus one" ${draft[t] ? '' : 'disabled'}>−</button><b id="fix-${t}">${draft[t]}</b><button data-step="${t}" data-d="1" aria-label="${esc(ctx.teams[t])} plus one">+</button></div></div>`).join('')}</div>
      <h5>Our rotation</h5><div class="seg six">${[1, 2, 3, 4, 5, 6].map(r => `<button data-rot="${r}" class="${draft.rotation === r ? 'on' : ''}">R${r}</button>`).join('')}</div>
      <h5>Serving</h5><div class="seg">${['us', 'them'].map(t => `<button data-serve="${t}" class="${draft.servingTeam === t ? 'on' : ''}">${esc(ctx.teams[t])}</button>`).join('')}</div>
      <h5>Reason (optional)</h5><input id="fixReason" class="fix-reason" maxlength="120" placeholder="e.g. Scorer awarded a point for a rotation fault" value="${esc(draft.reason)}">
      <p class="edit-error" role="alert">${same || check.allowed ? '' : esc(check.error.message)}</p>
      <div class="sheet-row"><button class="cancel" id="shCancel">Cancel</button><button class="save-btn" id="shSave" ${same || !check.allowed ? 'disabled' : ''}>Save fix</button></div>`);
    sheet().querySelectorAll('[data-step]').forEach(b => b.onclick = () => { draft[b.dataset.step] = Math.max(0, draft[b.dataset.step] + Number(b.dataset.d)); draw(); });
    sheet().querySelectorAll('[data-rot]').forEach(b => b.onclick = () => { draft.rotation = Number(b.dataset.rot); draw(); });
    sheet().querySelectorAll('[data-serve]').forEach(b => b.onclick = () => { draft.servingTeam = b.dataset.serve; draw(); });
    document.getElementById('fixReason').oninput = e => { draft.reason = e.target.value; };
    document.getElementById('shSave').onclick = () => ctx.command('correction', payload());
  };
  draw();
}

/* Match summary: set scores, key stats, players, and rotation tables per set. */
export function matchSummary(ctx) {
  const sets = ctx.matchRecords().map(record => { const state = replaySet(record); return { record, state, stats: getSetStats(state) }; });
  const lineups = matchSetLineups(ctx.matchRecords());
  const c = ctx.record.config, won = sets.filter(x => x.state.status === 'ended' && x.state.winner === 'us').length, lost = sets.filter(x => x.state.status === 'ended' && x.state.winner === 'them').length;
  const sum = (st, team, kind) => Object.entries(st.stats.codes[team]).filter(([code]) => ACTION_CODES[code] === kind).reduce((n, [, v]) => n + v, 0);
  const metrics = st => { const ourE = sum(st, 'us', 'earned'), ourX = sum(st, 'us', 'error'), theirE = sum(st, 'them', 'earned'), theirX = sum(st, 'them', 'error');
    return { ourE, ourX, theirE, theirX, given: ourX + theirE ? ourX / (ourX + theirE) : null, free: ourE + theirX ? theirX / (ourE + theirX) : null }; };
  const all = sets.map(metrics), total = all.reduce((a, m) => ({ ourE: a.ourE + m.ourE, ourX: a.ourX + m.ourX, theirE: a.theirE + m.theirE, theirX: a.theirX + m.theirX }), { ourE: 0, ourX: 0, theirE: 0, theirX: 0 });
  total.given = total.ourX + total.theirE ? total.ourX / (total.ourX + total.theirE) : null; total.free = total.ourE + total.theirX ? total.theirX / (total.ourE + total.theirX) : null;
  const players = new Map();
  const currentRoster = new Map((ctx.players ?? []).map(player => [player.id, player]));
  for (const { record, stats } of sets) for (const [id, p] of Object.entries(stats.players)) {
    const who = currentRoster.get(id) ?? record.config.players.find(x => x.id === id), row = players.get(id) ?? { jersey: who?.jersey ?? '?', name: who?.name ?? '', K: 0, BK: 0, SA: 0, HE: 0, errors: 0, net: 0, passCount: 0, passSum: 0, serveAttempts: 0, servesIn: 0 };
    for (const code of ['K', 'BK', 'SA', 'HE']) row[code] += p.codes[code] ?? 0;
    row.errors += p.errors; row.net += p.net;
    row.passCount += p.passing?.count ?? 0; row.passSum += p.passing?.sum ?? 0;
    row.serveAttempts += p.serving?.attempts ?? 0; row.servesIn += p.serving?.in ?? 0;
    players.set(id, row);
  }
  const ranked = [...players.values()].sort((a, b) => b.net - a.net || Number(a.jersey) - Number(b.jersey));
  const errorCounts = {};
  for (const { stats } of sets) for (const [code, n] of Object.entries(stats.codes.us)) if (ACTION_CODES[code] === 'error') errorCounts[code] = (errorCounts[code] ?? 0) + n;
  const topError = Object.entries(errorCounts).sort((a, b) => b[1] - a[1])[0];
  const rotLines = sets.map(({ record, stats }, i) => { const r = Object.entries(stats.rotations).filter(([, x]) => x.won + x.lost); if (r.length < 2) return null;
    const b = r.reduce((m, x) => x[1].net > m[1].net ? x : m), w = r.reduce((m, x) => x[1].net < m[1].net ? x : m);
    return `Set ${record.config.setNumber ?? i + 1}: best R${b[0]} (${signed(b[1].net)}), worst R${w[0]} (${signed(w[1].net)})`; }).filter(Boolean);
  const takeaways = [...rotLines,
    ...(topError ? [`Most common error: ${WORDS[topError[0]]} (${topError[1]})`] : []),
    ...(ranked[0]?.net > 0 ? [`Top player +/-: #${esc(ranked[0].jersey)} ${esc(ranked[0].name)} (${signed(ranked[0].net)})`] : []),
    ...(ranked.length && ranked.at(-1).net < 0 ? [`Struggled most: #${esc(ranked.at(-1).jersey)} ${esc(ranked.at(-1).name)} (${signed(ranked.at(-1).net)})`] : [])];
  const head = sets.map((x, i) => `<th>Set ${x.record.config.setNumber ?? i + 1}</th>`).join('') + '<th>Match</th>';
  const row = (label, f, fmt = v => v) => `<tr><td>${label}</td>${all.map(m => `<td>${fmt(f(m))}</td>`).join('')}<td>${fmt(f(total))}</td></tr>`;
  ctx.open(`<h4>Match summary · ${esc(ctx.teams.us)} vs ${esc(ctx.teams.them)}</h4>
    <p>${esc(c.matchDate || '')}${c.bestOf ? ` · Best of ${c.bestOf}` : ''} · Sets ${won}–${lost}</p>
    <div class="set-chips">${sets.map((x, i) => { const lineup = lineups[i]; return `<div class="${x.state.status === 'ended' ? (x.state.winner === 'us' ? 'won' : 'lost') : 'live'}"><small>Set ${x.record.config.setNumber ?? i + 1}${x.state.status === 'ended' ? '' : ' · in progress'}</small><b>${x.state.score.us}–${x.state.score.them}</b><small class="set-lineup">${esc(lineup.name)}${lineup.inheritedFromSet ? ` · continued from Set ${lineup.inheritedFromSet}` : ''}</small></div>`; }).join('')}</div>
    ${takeaways.length ? `<h5>Takeaways</h5><ul class="fix-list">${takeaways.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}
    <div class="summary-grid"><div><h5>Point source</h5><p>Won = our kills, blocks, or aces; received = opponent errors; gifted = our errors; lost = opponent kills, blocks, or aces.</p><table class="lib-table stat-table"><thead><tr><th></th>${head}</tr></thead><tbody>
      ${row('Won by us · K/BK/SA', m => m.ourE)}${row('Received · opponent errors', m => m.theirX)}${row('Gifted · our errors', m => m.ourX)}${row('Lost · opponent K/BK/SA', m => m.theirE)}
      ${row('Points given away', m => m.given, pct)}${row('Free points received', m => m.free, pct)}</tbody></table>
      <h5>Rotation +/- by set</h5><table class="lib-table stat-table"><thead><tr><th></th>${[1, 2, 3, 4, 5, 6].map(r => `<th>R${r}</th>`).join('')}</tr></thead><tbody>
      ${sets.map((x, i) => `<tr><td>Set ${x.record.config.setNumber ?? i + 1}</td>${[1, 2, 3, 4, 5, 6].map(r => { const t = x.stats.rotations[r]; return `<td class="${t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : ''}">${t.won + t.lost ? signed(t.net) : '—'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      <div><h5>Players · match</h5><table class="lib-table stat-table"><thead><tr><th>Player</th><th>Kills</th><th>Hitting errors</th><th>BK</th><th>Aces</th><th>Serve in</th><th>Err</th><th>Pass avg</th><th>+/-</th></tr></thead><tbody>
      ${ranked.map(p => `<tr><td>#${esc(p.jersey)} ${esc(p.name)}</td><td>${p.K}</td><td>${p.HE}</td><td>${p.BK}</td><td>${p.SA}</td><td>${p.serveAttempts ? `${Math.round(p.servesIn * 100 / p.serveAttempts)}% (${p.servesIn}/${p.serveAttempts})` : '—'}</td><td>${p.errors}</td><td>${p.passCount ? `${(p.passSum / p.passCount).toFixed(2)} (n=${p.passCount})` : '—'}</td><td class="${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${signed(p.net)}</td></tr>`).join('') || '<tr><td colspan="9">No player stats yet</td></tr>'}</tbody></table>
      <p>Serve in counts each rally-ending serve once: aces count in, serve errors count out.</p>
      <p>Player +/- counts kills, blocks, and aces credited to them minus errors credited to them.</p>
      <p>Team errors with no player count in Our errors but not in any player’s row.</p></div></div>
    <button class="cancel" id="shCancel">Close</button>`, true);
}

/* Settings: saved on this device and applied immediately. */
export function settingsSheet(ctx) {
  const draw = () => {
    const st = ctx.settings(), rules = ctx.record.config.rules;
    const seg = (key, options) => `<div class="seg">${options.map(([v, l]) => `<button data-set="${key}" data-v="${v}" class="${String(st[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    ctx.open(`<h4>Settings</h4><p>Saved on this device.</p>
      <h5>Code buttons</h5>${seg('labels', [['words', 'Words'], ['codes', 'Codes']])}
      <h5>Appearance</h5>${seg('appearance', [['device', 'Match device'], ['light', 'Light'], ['dark', 'Dark']])}
      <h5>Color theme</h5><div class="theme-picker">${COLOR_THEMES.map(t => `<button type="button" class="theme-option" data-theme-choice="${t.id}" aria-pressed="${st.theme === t.id}">
        <span class="theme-preview" style="--preview-court:${t.court};--preview-court-2:${t.court2};--preview-accent:${t.accent};--preview-set:${t.set};--preview-oh:${t.oh};--preview-mid:${t.mid};--preview-win:${t.win};--preview-lose:${t.lose}"><span class="theme-preview-roles"><i class="set"></i><i class="oh"></i><i class="mid"></i></span><span class="theme-preview-results"><i class="win"></i><i class="lose"></i><b></b></span></span>
        <span class="theme-copy"><strong>${t.name}</strong><small>${t.description}</small></span></button>`).join('')}</div>
      <h5>Coach’s corner</h5>${seg('corner', [[true, 'On'], [false, 'Off']])}
      <h5>Suggestion types</h5><div class="toggle-grid">${TIP_CATEGORIES.map(([id, label]) => `<button data-cat="${id}" class="${st.categories[id] === false ? '' : 'on'}" aria-pressed="${st.categories[id] !== false}" ${st.corner ? '' : 'disabled'}>${label}</button>`).join('')}</div>
      <h5>Rules for this set</h5><p>To ${rules.target}, win by ${rules.winBy}${rules.cap ? `, cap ${rules.cap}` : ''} · ${rules.substitutionLimit} subs · ${rules.timeoutsPerTeam} timeouts per team · libero ${rules.liberoMayServe ? 'may serve from P1' : 'may not serve'}. Targets come from the match format chosen in Teams.</p>
      <button class="cancel" id="shCancel">Done</button>`);
    sheet().querySelectorAll('[data-set]').forEach(b => b.onclick = () => { const v = b.dataset.v; ctx.saveSettings({ ...ctx.settings(), [b.dataset.set]: v === 'true' ? true : v === 'false' ? false : v }); draw(); });
    sheet().querySelectorAll('[data-theme-choice]').forEach(b => b.onclick = () => { ctx.saveSettings({ ...ctx.settings(), theme: b.dataset.themeChoice }); draw(); });
    sheet().querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { const s = ctx.settings(); ctx.saveSettings({ ...s, categories: { ...s.categories, [b.dataset.cat]: s.categories[b.dataset.cat] === false } }); draw(); });
  };
  draw();
}
