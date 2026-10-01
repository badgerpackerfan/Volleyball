/** Pure set engine. All IDs and timestamps are supplied by the caller.
 * No DOM, storage, network, clock, or random-number dependencies.
 */
import { receiveLayoutError } from './receive-layout.mjs';
export const SCHEMA_VERSION = 1;
export const DEFAULT_RULES = Object.freeze({
  target: 25, winBy: 2, cap: null, substitutionLimit: 18,
  timeoutsPerTeam: 2, liberoMayServe: true, liberoRalliesBetweenEntries: 1,
});
export const ACTION_CODES = Object.freeze({
  K: 'earned', BK: 'earned', SA: 'earned', HE: 'error', BKE: 'error',
  SE: 'error', SrE: 'error', BHE: 'error', DigE: 'error', NET: 'error', VIO: 'error',
});
const POSITIONS = [1, 2, 3, 4, 5, 6];
const BACK = [5, 6, 1];
const FRONT = [4, 3, 2];
const TYPES = new Set(['rally', 'substitution', 'libero.in', 'libero.out',
  'libero.switch', 'timeout', 'set.end', 'undo', 'receive.edit', 'receive.select', 'receive.rating', 'libero.plan',
  'rally.edit', 'correction']);
// Historical edits and scoresheet corrections are allowed after the set has ended.
const AFTER_END = new Set(['undo', 'rally.edit', 'correction']);
const own = (obj, key) => Object.hasOwn(obj, key);
const other = team => team === 'us' ? 'them' : 'us';
const front = position => FRONT.includes(position);

export class EngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}
function requireThat(condition, code, message, details) {
  if (!condition) throw new EngineError(code, message, details);
}
function object(value, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_INPUT', `${label} must be an object.`);
}
function json(value) {
  // Reject data that would change meaning when serialized and restored.
  const ancestors = new Set();
  function check(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v) || (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)))) {
      requireThat(!ancestors.has(v), 'INVALID_INPUT', 'Records cannot contain circular references.');
      ancestors.add(v);
      if (Array.isArray(v)) { for (const item of v) check(item); }
      else Object.values(v).forEach(check);
      ancestors.delete(v); return;
    }
    throw new EngineError('INVALID_INPUT', 'Records must contain only JSON data.');
  }
  check(value);
  return JSON.parse(JSON.stringify(value));
}
function id(value, label) {
  requireThat(typeof value === 'string' && value.trim().length > 0,
    'INVALID_INPUT', `${label} must be a nonempty string ID.`);
}
function integer(value, min, label) {
  requireThat(Number.isSafeInteger(value) && value >= min,
    'INVALID_INPUT', `${label} must be an integer of at least ${min}.`);
}
function team(value) {
  requireThat(value === 'us' || value === 'them', 'INVALID_TEAM', 'Team must be us or them.');
}
function unique(values, label) {
  requireThat(new Set(values).size === values.length, 'DUPLICATE', `${label} must be unique.`);
}
function player(config, playerId) {
  const found = config.players.find(p => p.id === playerId);
  requireThat(found, 'UNKNOWN_PLAYER', `Unknown roster entry: ${playerId}.`);
  return found;
}
function available(config, playerId) {
  requireThat(player(config, playerId).available, 'UNAVAILABLE_PLAYER', `Player ${playerId} is unavailable.`);
}
function slot(config, slotId) {
  const found = config.slots.find(s => s.id === slotId);
  requireThat(found, 'UNKNOWN_SLOT', `Unknown lineup slot: ${slotId}.`);
  return found;
}
export function positionOf(state, slotId) {
  const index = state.order.indexOf(slotId);
  requireThat(index !== -1, 'UNKNOWN_SLOT', `Unknown lineup slot: ${slotId}.`);
  return index + 1;
}
export function playerAt(state, position) {
  requireThat(POSITIONS.includes(position), 'INVALID_POSITION', 'Court position must be 1–6.');
  return state.onCourt[state.order[position - 1]];
}
export function setterPosition(config, state) {
  const positions = POSITIONS.filter(p => config.setters.includes(playerAt(state, p)));
  return positions.find(p => config.system === '5-1' || (config.system === '4-2' ? front(p) : !front(p))) ?? null;
}

function normalizeConfig(input) {
  object(input, 'Set configuration');
  const c = json(input);
  for (const key of ['id', 'teamId', 'matchId']) id(c[key], key);
  requireThat(['5-1', '6-2', '4-2'].includes(c.system), 'INVALID_SYSTEM', 'Choose 5-1, 6-2, or 4-2.');
  team(c.firstServe);
  c.startingRotation ??= 1;
  requireThat(Number.isInteger(c.startingRotation) && c.startingRotation >= 1 && c.startingRotation <= 6,
    'INVALID_ROTATION', 'Starting rotation must be R1 through R6.');
  requireThat(Array.isArray(c.players), 'INVALID_ROSTER', 'A roster is required.');
  for (const p of c.players) {
    object(p, 'Roster entry'); id(p.id, 'Roster entry ID'); id(p.athleteId, 'Athlete ID');
    requireThat(typeof p.jersey === 'string' && p.jersey.trim().length > 0,
      'INVALID_ROSTER', 'Jersey numbers must be nonempty strings.');
    p.available ??= true;
    requireThat(typeof p.available === 'boolean', 'INVALID_ROSTER', 'Availability must be boolean.');
  }
  unique(c.players.map(p => p.id), 'Roster IDs');
  unique(c.players.map(p => p.athleteId), 'Athletes on this team');
  unique(c.players.map(p => p.jersey), 'Jersey numbers');
  requireThat(Array.isArray(c.slots) && c.slots.length === 6, 'INVALID_LINEUP', 'Six lineup slots are required.');
  for (const s of c.slots) { object(s, 'Slot'); id(s.id, 'Slot ID'); available(c, s.playerId); }
  unique(c.slots.map(s => s.id), 'Slot IDs'); unique(c.slots.map(s => s.playerId), 'Starting players');
  c.order ??= c.slots.map(s => s.id); // Base R1 order at P1 to P6; startingRotation selects the initial turn.
  requireThat(Array.isArray(c.order) && c.order.length === 6, 'INVALID_LINEUP', 'Order must contain six slots.');
  unique(c.order, 'Ordered slots'); c.order.forEach(s => slot(c, s));
  c.liberos ??= [];
  requireThat(Array.isArray(c.liberos) && c.liberos.length <= 2, 'INVALID_LIBEROS', 'Designate at most two liberos.');
  unique(c.liberos, 'Liberos'); c.liberos.forEach(p => available(c, p));
  requireThat(!c.slots.some(s => c.liberos.includes(s.playerId)), 'INVALID_LIBEROS',
    'Start with six regular players; enter the libero with a separate action.');
  const slotPlayers = new Map();
  for (const s of c.slots) {
    const ids = new Set([s.playerId]);
    if (s.plan != null) {
      object(s.plan, 'Planned swap');
      const { frontPlayerId: f, backPlayerId: b } = s.plan;
      available(c, f); available(c, b);
      requireThat(f !== b && [f, b].includes(s.playerId), 'INVALID_PLAN',
        'A plan needs different front/back players and must include the starter.');
      ids.add(f); ids.add(b);
    }
    for (const p of ids) {
      requireThat(!c.liberos.includes(p), 'INVALID_PLAN', 'Libero replacements are not planned substitutions.');
      requireThat(!slotPlayers.has(p), 'INVALID_PLAN', `Player ${p} is assigned to more than one slot.`);
      slotPlayers.set(p, s.id);
    }
  }
  requireThat(Array.isArray(c.setters) && c.setters.length === (c.system === '5-1' ? 1 : 2),
    'INVALID_SETTERS', 'Designate one setter for 5-1, or two for 6-2/4-2.');
  unique(c.setters, 'Setters');
  c.setters.forEach(p => {
    available(c, p);
    requireThat(slotPlayers.has(p), 'INVALID_SETTERS', 'Each setter must belong to a lineup slot or its plan.');
  });
  if (c.setters.length === 2) {
    const [a, b] = c.setters.map(p => c.order.indexOf(slotPlayers.get(p)));
    requireThat(Math.abs(a - b) === 3, 'INVALID_SETTERS', 'The setters must occupy opposite slots.');
  }
  object(c.rules ?? {}, 'Rules');
  for (const k of Object.keys(c.rules ?? {})) requireThat(own(DEFAULT_RULES, k), 'INVALID_RULES', `Unknown rule: ${k}.`);
  c.rules = { ...DEFAULT_RULES, ...c.rules };
  for (const k of ['target', 'winBy']) integer(c.rules[k], 1, k);
  for (const k of ['substitutionLimit', 'timeoutsPerTeam', 'liberoRalliesBetweenEntries']) integer(c.rules[k], 0, k);
  if (c.rules.cap !== null) integer(c.rules.cap, c.rules.target, 'cap');
  requireThat(typeof c.rules.liberoMayServe === 'boolean', 'INVALID_RULES', 'liberoMayServe must be boolean.');
  return c;
}

/** Returns a JSON-serializable record. The caller owns saving it. */
export function createSet(config) {
  return { schemaVersion: SCHEMA_VERSION, config: normalizeConfig(config), actions: [] };
}
function initialState(c) {
  return {
    setId: c.id, status: 'live', order: [...c.order.slice(c.startingRotation - 1), ...c.order.slice(0, c.startingRotation - 1)],
    onCourt: Object.fromEntries(c.slots.map(s => [s.id, s.playerId])),
    score: { us: 0, them: 0 }, servingTeam: c.firstServe, rotation: c.startingRotation, rotations: 0,
    substitutionsUsed: 0, timeoutsRemaining: { us: c.rules.timeoutsPerTeam, them: c.rules.timeoutsPerTeam },
    partners: Object.fromEntries(c.players.map(p => [p.id, []])),
    libero: null, lastLiberoExit: Object.fromEntries(c.liberos.map(p => [p, null])),
    rallies: [], substitutions: [], liberoReplacements: [], timeouts: [], overrides: [], corrections: [],
    pendingSetWinner: null, winner: null, receiveEdits: {}, receivePasser: null, receiveRatings: [], liberoFor: 'mid',
  };
}
function winnerAt(score, rules) {
  const high = Math.max(score.us, score.them), margin = Math.abs(score.us - score.them);
  return margin > 0 && ((high >= rules.target && margin >= rules.winBy) || (rules.cap !== null && high >= rules.cap))
    ? (score.us > score.them ? 'us' : 'them') : null;
}
function checkOverride(payload) {
  if (payload.override === undefined) return;
  object(payload.override, 'Override');
  requireThat(typeof payload.override.reason === 'string' && payload.override.reason.trim().length > 0,
    'OVERRIDE_REASON_REQUIRED', 'An override requires a reason.');
}
function allowViolations(state, action, violations) {
  checkOverride(action.payload);
  if (violations.length && !action.payload.override) {
    throw new EngineError(violations[0].code, violations[0].message, { violations });
  }
  if (action.payload.override) state.overrides.push({
    actionId: action.id, reason: action.payload.override.reason, violations: json(violations),
  });
}
function context(state, action) {
  return { actionId: action.id, timestamp: action.occurredAt, score: { ...state.score }, rotation: state.rotation };
}
function checkIncoming(c, state, playerId) {
  available(c, playerId);
  requireThat(!Object.values(state.onCourt).includes(playerId), 'PLAYER_ALREADY_ON_COURT', 'Player is already on court.');
  requireThat(state.libero?.replacedPlayerId !== playerId, 'PLAYER_COVERED_BY_LIBERO',
    'This player is already assigned to the slot covered by the libero.');
}
function expectedOccupant(c, state, payload) {
  slot(c, payload.slotId);
  requireThat(state.onCourt[payload.slotId] === payload.outPlayerId, 'STALE_LINEUP',
    'The player in this slot changed. Refresh the selection before applying it.');
}

function applyRally(c, s, a) {
  const p = a.payload; team(p.team);
  requireThat(own(ACTION_CODES, p.code), 'INVALID_CODE', `Unknown terminal code: ${p.code}.`);
  const servingCode = p.code === 'SA' || p.code === 'SE';
  requireThat(!servingCode || s.servingTeam === p.team, 'WRONG_SERVING_TEAM', 'Only the serving team can record an ace or serve error.');
  requireThat(p.code !== 'SrE' || s.servingTeam !== p.team, 'NOT_RECEIVING', 'Only the receiving team can record a receive error.');
  let playerId = p.playerId ?? null;
  if (p.team === 'them') requireThat(playerId === null, 'OPPONENT_PLAYER_NOT_TRACKED', 'Opponent players are not tracked.');
  else {
    if (servingCode) {
      requireThat(playerId === null || playerId === playerAt(s, 1), 'WRONG_SERVER', 'Use the current server for an ace or serve error.');
      playerId = playerAt(s, 1);
      requireThat(c.rules.liberoMayServe || !c.liberos.includes(playerId), 'LIBERO_CANNOT_SERVE', 'The configured rules do not allow libero serving.');
    }
    requireThat(ACTION_CODES[p.code] !== 'earned' || playerId !== null, 'PLAYER_REQUIRED', 'Choose a player for an earned point.');
    if (playerId !== null) requireThat(Object.values(s.onCourt).includes(playerId), 'PLAYER_NOT_ON_COURT', 'The terminal player must be on court.');
  }
  const winner = ACTION_CODES[p.code] === 'earned' ? p.team : other(p.team);
  const rally = { ...context(s, a), seq: s.rallies.length + 1,
    team: p.team, code: p.code, playerId, winner, ...(a.edited ? { edited: true } : {}),
    servingTeam: s.servingTeam, serverId: s.servingTeam === 'us' ? playerAt(s, 1) : null,
    setterPosition: setterPosition(c, s), backRowPlayerIds: BACK.map(pos => playerAt(s, pos)),
    court: POSITIONS.map(position => ({ position, slotId: s.order[position - 1], playerId: playerAt(s, position) })),
  };
  s.score[winner]++;
  rally.score = { ...s.score };
  s.rallies.push(rally);
  if (winner !== s.servingTeam) {
    s.servingTeam = winner;
    if (winner === 'us') {
      s.order.push(s.order.shift()); s.rotations++; s.rotation = s.rotation % 6 + 1;
      if (s.libero && positionOf(s, s.libero.slotId) === 4) removeLibero(s, a, 'front-row-rotation');
    }
  }
  s.pendingSetWinner = winnerAt(s.score, c.rules);
  if (a.automaticSetEnd) finishSet(s);
}
// Old journals may contain rallies entered before a separate set.end action.
// Preserve that history; new rallies close the set as part of the same action.
function finishSet(state) {
  if (state.status === 'live' && state.pendingSetWinner) {
    state.status = 'ended'; state.winner = state.pendingSetWinner; state.pendingSetWinner = null;
  }
}
function applySubstitution(c, s, a) {
  const p = a.payload; expectedOccupant(c, s, p); checkIncoming(c, s, p.inPlayerId);
  requireThat(!c.liberos.includes(p.inPlayerId) && !c.liberos.includes(p.outPlayerId), 'USE_LIBERO_REPLACEMENT', 'Use a libero replacement, not a substitution.');
  requireThat(!s.libero || s.libero.slotId !== p.slotId, 'LIBERO_SLOT_ACTIVE', 'Remove the libero before substituting in this slot.');
  if (p.planned !== undefined) requireThat(typeof p.planned === 'boolean', 'INVALID_INPUT', 'planned must be boolean.');
  if (p.planned) {
    const plan = slot(c, p.slotId).plan;
    requireThat(plan && [plan.frontPlayerId, plan.backPlayerId].includes(p.outPlayerId), 'PLAN_PAUSED', 'The original planned pair is not in this slot.');
    const desired = front(positionOf(s, p.slotId)) ? plan.frontPlayerId : plan.backPlayerId;
    requireThat(p.inPlayerId === desired && p.outPlayerId !== desired, 'STALE_PLAN', 'This planned swap no longer applies in the current rotation.');
  }
  const issues = [];
  if (s.substitutionsUsed >= c.rules.substitutionLimit) issues.push({ code: 'SUB_LIMIT', message: 'No substitutions remain.' });
  if (s.partners[p.inPlayerId].some(id => id !== p.outPlayerId) || s.partners[p.outPlayerId].some(id => id !== p.inPlayerId))
    issues.push({ code: 'SUB_PARTNER_LOCK', message: 'These players are locked to a different substitution partner.' });
  allowViolations(s, a, issues);
  // Preserve all historical pairings, including conflicting overridden ones.
  // An override never silently frees a previous partner from their lock.
  for (const [who, partner] of [[p.inPlayerId, p.outPlayerId], [p.outPlayerId, p.inPlayerId]])
    if (!s.partners[who].includes(partner)) s.partners[who].push(partner);
  s.onCourt[p.slotId] = p.inPlayerId; s.substitutionsUsed++;
  s.substitutions.push({ ...context(s, a), slotId: p.slotId, outPlayerId: p.outPlayerId,
    inPlayerId: p.inPlayerId, planned: p.planned ?? false, overridden: !!p.override });
}
function removeLibero(s, a, reason) {
  const replacement = s.libero;
  s.onCourt[replacement.slotId] = replacement.replacedPlayerId;
  s.lastLiberoExit[replacement.playerId] = s.rallies.length;
  s.liberoReplacements.push({ ...context(s, a), type: 'out', ...replacement, reason });
  s.libero = null;
}
function applyLibero(c, s, a) {
  const p = a.payload;
  if (a.type === 'libero.in') {
    expectedOccupant(c, s, p);
    requireThat(!s.libero, 'LIBERO_ALREADY_ACTIVE', 'Remove or switch the current libero first.');
    checkIncoming(c, s, p.inPlayerId);
    requireThat(c.liberos.includes(p.inPlayerId), 'NOT_DESIGNATED_LIBERO', 'Choose a designated libero.');
    const position = positionOf(s, p.slotId);
    requireThat(!front(position), 'LIBERO_FRONT_ROW', 'A libero may only replace a back-row player.');
    const servingNow = position === 1 && s.servingTeam === 'us';
    requireThat(!servingNow || c.rules.liberoMayServe, 'LIBERO_CANNOT_SERVE', 'The configured rules do not allow libero serving.');
    const exited = s.lastLiberoExit[p.inPlayerId];
    const tooSoon = exited !== null && s.rallies.length - exited < c.rules.liberoRalliesBetweenEntries && !servingNow;
    allowViolations(s, a, tooSoon ? [{ code: 'LIBERO_REENTRY', message: 'The libero must sit out the required rally before re-entering.' }] : []);
    s.libero = { slotId: p.slotId, playerId: p.inPlayerId, replacedPlayerId: p.outPlayerId };
    s.onCourt[p.slotId] = p.inPlayerId;
    s.liberoReplacements.push({ ...context(s, a), type: 'in', ...s.libero, overridden: !!p.override });
  } else {
    requireThat(s.libero && s.libero.playerId === p.outPlayerId, 'STALE_LIBERO', 'The selected libero is no longer on court.');
    if (a.type === 'libero.out') removeLibero(s, a, 'coach');
    else {
      requireThat(c.liberos.includes(p.inPlayerId), 'NOT_DESIGNATED_LIBERO', 'Choose a designated libero.');
      checkIncoming(c, s, p.inPlayerId);
      s.lastLiberoExit[p.outPlayerId] = s.rallies.length;
      s.libero.playerId = p.inPlayerId;
      s.onCourt[s.libero.slotId] = p.inPlayerId;
      s.liberoReplacements.push({ ...context(s, a), type: 'switch', ...s.libero, outPlayerId: p.outPlayerId });
    }
  }
}
function apply(c, state, action) {
  requireThat(state.status === 'live' || action.type === 'correction', 'SET_CLOSED', 'Undo the final rally before recording more actions.');
  object(action.payload, 'Action payload');
  checkOverride(action.payload);
  const supportsOverride = ['substitution', 'libero.in'].includes(action.type);
  requireThat(supportsOverride || action.payload.override === undefined, 'OVERRIDE_NOT_SUPPORTED', 'This action does not support an override.');
  switch (action.type) {
    case 'receive.edit': {
      const { key, positions } = action.payload;
      requireThat(typeof key === 'string' && key.startsWith(`${c.system}:${state.rotation}:${setterPosition(c, state)}:`)
        && /:(OH|RS)$/.test(key), 'INVALID_FORMATION_CONTEXT', 'Receive formation must match the current rotation and setter.');
      requireThat(state.servingTeam === 'them', 'NOT_RECEIVING', 'Adjust receive while receiving.');
      requireThat(c.system !== '4-2' && !front(setterPosition(c, state)) && setterPosition(c, state) !== null,
        'INVALID_FORMATION_CONTEXT', 'No receive editor is available for this setter position.');
      if (positions === null) delete state.receiveEdits[key];
      else {
        const error = receiveLayoutError(positions);
        requireThat(!error, 'ILLEGAL_FORMATION', error);
        state.receiveEdits[key] = json(positions);
      }
      break;
    }
    case 'receive.select':
      requireThat(['OH', 'RS'].includes(action.payload.passer), 'INVALID_FORMATION_CONTEXT', 'Choose an available receive formation.');
      requireThat(state.servingTeam === 'them' && c.system !== '4-2' && [1, 5, 6].includes(setterPosition(c, state)),
        'INVALID_FORMATION_CONTEXT', 'Receive formation selection is unavailable in this rotation.');
      state.receivePasser = action.payload.passer;
      break;
    case 'receive.rating': {
      const { playerId, rating } = action.payload;
      requireThat(state.servingTeam === 'them', 'NOT_RECEIVING', 'A pass rating can only be recorded while receiving.');
      id(playerId, 'Player'); player(c, playerId);
      requireThat(Object.values(state.onCourt).includes(playerId), 'PLAYER_NOT_ON_COURT', 'Choose a player who is currently on court.');
      requireThat(Number.isInteger(rating) && rating >= 0 && rating <= 3, 'INVALID_PASS_RATING', 'A pass rating must be from 0 to 3.');
      state.receiveRatings.push({ ...context(state, action), playerId, rating });
      break;
    }
    case 'libero.plan':
      requireThat(['mid', 'oh', 'none'].includes(action.payload.role), 'INVALID_PLAN', 'Choose middles, outsides, or no libero.');
      state.liberoFor = action.payload.role;
      break;
    case 'rally': applyRally(c, state, action); break;
    case 'substitution': applySubstitution(c, state, action); break;
    case 'libero.in': case 'libero.out': case 'libero.switch': applyLibero(c, state, action); break;
    case 'timeout': {
      const t = action.payload.team; team(t);
      requireThat(state.timeoutsRemaining[t] > 0, 'TIMEOUT_LIMIT', 'No timeouts remain for this team.');
      state.timeoutsRemaining[t]--;
      state.timeouts.push({ ...context(state, action), team: t });
      break;
    }
    case 'set.end':
      requireThat(state.pendingSetWinner !== null, 'SET_NOT_FINISHED', 'The score has not reached the configured winning condition.');
      requireThat(action.payload.score?.us === state.score.us && action.payload.score?.them === state.score.them,
        'STALE_SCORE', 'The score changed before set-end confirmation.');
      state.status = 'ended'; state.winner = state.pendingSetWinner;
      break;
    case 'correction': applyCorrection(c, state, action); break;
    default: throw new EngineError('INVALID_ACTION', `Unknown action: ${action.type}.`);
  }
  unique(Object.values(state.onCourt), 'On-court players');
  requireThat(!state.libero || !front(positionOf(state, state.libero.slotId)), 'LIBERO_FRONT_ROW', 'Libero cannot occupy a front-row slot.');
}
// Match the official scoresheet. Only the displayed score, rotation, and server change;
// rallies (and so player and rotation statistics) are untouched, and the original record stays.
function applyCorrection(c, s, a) {
  const p = a.payload;
  object(p.score, 'Corrected score'); integer(p.score.us, 0, 'Our score'); integer(p.score.them, 0, 'Their score');
  requireThat(Number.isInteger(p.rotation) && p.rotation >= 1 && p.rotation <= 6, 'INVALID_ROTATION', 'Rotation must be R1 through R6.');
  team(p.servingTeam);
  requireThat(p.reason === undefined || typeof p.reason === 'string', 'INVALID_INPUT', 'Reason must be text.');
  const from = { score: { ...s.score }, rotation: s.rotation, servingTeam: s.servingTeam };
  requireThat(from.score.us !== p.score.us || from.score.them !== p.score.them || from.rotation !== p.rotation || from.servingTeam !== p.servingTeam,
    'NO_CHANGE', 'Nothing was changed.');
  const at = context(s, a);
  if (s.status === 'ended') { s.status = 'live'; s.winner = null; }
  for (let steps = (p.rotation - s.rotation + 6) % 6; steps > 0; steps--) s.order.push(s.order.shift());
  s.rotation = p.rotation; s.score = { us: p.score.us, them: p.score.them }; s.servingTeam = p.servingTeam;
  s.corrections.push({ ...at, from, to: { score: { ...s.score }, rotation: s.rotation, servingTeam: s.servingTeam }, reason: p.reason?.trim() || null });
  s.pendingSetWinner = winnerAt(s.score, c.rules);
  finishSet(s);
}
function checkEdit(active, a) {
  const p = a.payload;
  id(p.targetActionId, 'Edited rally');
  const target = active.find(x => x.id === p.targetActionId);
  requireThat(target && target.type === 'rally', 'INVALID_EDIT', 'Only a recorded rally can be edited.');
  const latest = active.filter(x => x.type === 'rally.edit' && x.payload.targetActionId === p.targetActionId).at(-1);
  requireThat(!latest?.payload.delete, 'INVALID_EDIT', 'This rally was deleted.');
  if (p.delete !== undefined) requireThat(p.delete === true && Object.keys(p).length === 2, 'INVALID_EDIT', 'A delete only names the rally.');
  else team(p.team);
}
// Replay the active journal with each rally's latest edit applied (or skipped when deleted).
// Later rotation, serve, set end, and statistics follow; later actions are re-validated.
function rebuild(c, active) {
  const edits = new Map();
  for (const a of active) if (a.type === 'rally.edit') edits.set(a.payload.targetActionId, a.payload);
  const state = initialState(c);
  for (const a of active) {
    if (a.type === 'rally.edit') continue;
    const edit = a.type === 'rally' ? edits.get(a.id) : null;
    if (edit?.delete) continue;
    const effective = edit ? { ...a, edited: true, payload: { team: edit.team, code: edit.code, playerId: edit.playerId ?? null } } : a;
    try { apply(c, state, effective); }
    catch (e) {
      if (!(e instanceof EngineError) || !edits.size || edit) throw e;
      const what = a.type === 'rally' ? 'rally' : a.type.startsWith('libero') ? 'libero change' : a.type;
      throw new EngineError('EDIT_CONFLICT', `This change conflicts with a later ${what}: ${e.code === 'SET_CLOSED' ? 'the set would already be over.' : e.message} Undo or edit that action first.`, { cause: e.code, actionId: a.id });
    }
  }
  return state;
}

/** Rebuild and validate the record, including undone events, on every replay. */
export function replaySet(record) {
  object(record, 'Set record');
  requireThat(record.schemaVersion === SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA', 'Unsupported set-record schema version.');
  const c = normalizeConfig(record.config);
  requireThat(Array.isArray(record.actions), 'INVALID_HISTORY', 'Actions must be an array.');
  const actions = json(record.actions), ids = new Set(), active = [];
  let state = initialState(c);
  actions.forEach((a, index) => {
    object(a, 'Action'); id(a.id, 'Action ID'); object(a.payload, 'Action payload');
    requireThat(!ids.has(a.id), 'DUPLICATE_ACTION', `Duplicate action ID: ${a.id}.`); ids.add(a.id);
    requireThat(a.seq === index + 1 && a.setId === c.id && a.schemaVersion === SCHEMA_VERSION,
      'INVALID_HISTORY', 'Action sequence, set ID, or schema version is invalid.');
    requireThat(typeof a.occurredAt === 'string' && Number.isFinite(Date.parse(a.occurredAt)) && a.updatedAt === a.occurredAt,
      'INVALID_TIMESTAMP', 'An immutable action requires matching valid occurredAt and updatedAt timestamps.');
    requireThat(TYPES.has(a.type), 'INVALID_ACTION', `Unknown action: ${a.type}.`);
    requireThat(a.automaticSetEnd === undefined || (a.type === 'rally' && a.automaticSetEnd === true),
      'INVALID_HISTORY', 'Automatic set completion is a rally attribute.');
    if (a.type === 'undo') {
      requireThat(active.length > 0 && active.at(-1).id === a.payload.targetActionId, 'INVALID_UNDO', 'Undo must target the latest active action.');
      active.pop(); state = rebuild(c, active);
    } else if (a.type === 'rally.edit') {
      checkEdit(active, a); active.push(a); state = rebuild(c, active);
    } else { apply(c, state, a); active.push(a); }
  });
  finishSet(state); // Also close older saved sets awaiting confirmation.
  return { ...state, revision: actions.length, lastEventId: actions.at(-1)?.id ?? null,
    activeActionIds: active.map(a => a.id), setterPosition: setterPosition(c, state),
    serverId: state.servingTeam === 'us' ? playerAt(state, 1) : null,
    prompts: plannedSwaps(c, state), warnings: warnings(c, state),
  };
}
function plannedSwaps(c, s) {
  if (s.status === 'ended') return [];
  const prompts = [];
  for (const entry of c.slots) {
    if (!entry.plan || s.libero?.slotId === entry.id) continue;
    const occupant = s.onCourt[entry.id], plan = entry.plan;
    if (![plan.frontPlayerId, plan.backPlayerId].includes(occupant)) {
      prompts.push({ type: 'plan-paused', slotId: entry.id, playerId: occupant }); continue;
    }
    const desired = front(positionOf(s, entry.id)) ? plan.frontPlayerId : plan.backPlayerId;
    if (desired !== occupant) prompts.push({ type: 'planned-swap', slotId: entry.id,
      outPlayerId: occupant, inPlayerId: desired, planned: true, rotation: s.rotation });
  }
  return prompts;
}
function warnings(c, s) {
  const result = [];
  if (s.substitutionsUsed >= Math.max(0, c.rules.substitutionLimit - 3))
    result.push({ code: 'SUBSTITUTIONS_LOW', used: s.substitutionsUsed, remaining: Math.max(0, c.rules.substitutionLimit - s.substitutionsUsed) });
  return result;
}

/** Dispatch is immutable: rejection never changes record or previously returned state.
 * meta: {id, occurredAt, expectedRevision?}. UI should pass expectedRevision.
 */
export function dispatch(record, command, meta) {
  object(command, 'Command'); object(meta, 'Action metadata');
  const state = replaySet(record);
  if (meta.expectedRevision !== undefined) requireThat(meta.expectedRevision === state.revision,
    'STALE_REVISION', 'The set changed. Refresh before applying this command.');
  const type = command.type;
  requireThat(TYPES.has(type), 'INVALID_ACTION', `Unknown action: ${type}.`);
  requireThat(AFTER_END.has(type) || state.status === 'live', 'SET_CLOSED', 'Undo the final rally before recording more actions.');
  let payload = command.payload ?? {};
  if (type === 'undo') {
    requireThat(state.activeActionIds.length > 0, 'NOTHING_TO_UNDO', 'There are no active actions to undo.');
    payload = { targetActionId: state.activeActionIds.at(-1) };
  }
  const action = json({ id: meta.id, occurredAt: meta.occurredAt, updatedAt: meta.occurredAt, schemaVersion: SCHEMA_VERSION,
    seq: state.revision + 1, setId: record.config.id, type, payload, ...(type === 'rally' ? { automaticSetEnd: true } : {}) });
  const next = { ...json(record), actions: [...json(record.actions), action] };
  return { record: next, action: json(action), state: replaySet(next) };
}

/** The picker and action buttons can use the same dispatch validation, without saving. */
export function checkCommand(record, command) {
  try {
    replaySet(record);
    let candidate = 'validation';
    while (record.actions.some(a => a.id === candidate)) candidate += '-';
    dispatch(record, command, { id: candidate, occurredAt: '2000-01-01T00:00:00.000Z' });
    return { allowed: true, error: null };
  } catch (e) {
    if (!(e instanceof EngineError)) throw e;
    return { allowed: false, error: { code: e.code, message: e.message, details: e.details } };
  }
}

/** Statistics are derived solely from active recorded actions. */
export function getSetStats(state) {
  const rotations = Object.fromEntries(POSITIONS.map(r => [r, {
    won: 0, lost: 0, served: 0, received: 0, wonServing: 0, wonReceiving: 0,
  }]));
  const players = new Map(), codes = { us: {}, them: {} };
  for (const r of state.rallies) {
    const rotation = rotations[r.rotation], won = r.winner === 'us', served = r.servingTeam === 'us';
    rotation[won ? 'won' : 'lost']++; rotation[served ? 'served' : 'received']++;
    if (won) rotation[served ? 'wonServing' : 'wonReceiving']++;
    codes[r.team][r.code] = (codes[r.team][r.code] ?? 0) + 1;
    // Each completed rally is exactly one serve attempt for the recorded server.
    // An ace is in; a serve error is out. Both remain a single attempt.
    if (served && r.serverId !== null && r.serverId !== undefined) {
      const p = players.get(r.serverId) ?? { earned: 0, errors: 0, codes: {} };
      p.serving ??= { attempts: 0, in: 0, aces: 0, errors: 0 };
      p.serving.attempts++;
      if (r.team === 'us' && r.code === 'SE') p.serving.errors++;
      else p.serving.in++;
      if (r.team === 'us' && r.code === 'SA') p.serving.aces++;
      players.set(r.serverId, p);
    }
    if (r.team === 'us' && r.playerId !== null) {
      const p = players.get(r.playerId) ?? { earned: 0, errors: 0, codes: {} };
      p[ACTION_CODES[r.code] === 'earned' ? 'earned' : 'errors']++;
      p.codes[r.code] = (p.codes[r.code] ?? 0) + 1; players.set(r.playerId, p);
    }
  }
  for (const pass of state.receiveRatings ?? []) {
    const p = players.get(pass.playerId) ?? { earned: 0, errors: 0, codes: {} };
    p.passing ??= { count: 0, sum: 0, ratings: { 0: 0, 1: 0, 2: 0, 3: 0 } };
    p.passing.count++; p.passing.sum += pass.rating; p.passing.ratings[pass.rating]++;
    players.set(pass.playerId, p);
  }
  return {
    codes,
    players: Object.fromEntries([...players].map(([id, p]) => [id, { ...p, net: p.earned - p.errors }])),
    rotations: Object.fromEntries(Object.entries(rotations).map(([id, r]) => [id, {
      ...r, net: r.won - r.lost,
      sideoutRate: r.received ? r.wonReceiving / r.received : null,
      scoringRate: r.served ? r.wonServing / r.served : null,
    }])),
  };
}
