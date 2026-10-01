import { getSetStats, replaySet } from '../engine/set-engine.mjs';
import { practiceStats } from '../practice/practice-model.mjs';
import { lineupConfig } from './lineup-model.mjs';

const zero = () => ({ passing: { count: 0, sum: 0 }, serving: { attempts: 0, in: 0, aces: 0, errors: 0 } });
function add(target, source) {
  target.passing.count += source.passing.count;
  target.passing.sum += source.passing.sum;
  target.serving.attempts += source.serving.attempts;
  target.serving.in += source.serving.in;
  target.serving.aces += source.serving.aces;
  target.serving.errors += source.serving.errors;
}
function profile(player) {
  return { id: player.id, name: player.name || '', jersey: String(player.jersey ?? '?') };
}
function fromPractice(row) {
  const { serves, passes } = row;
  return {
    passing: { count: passes.total, sum: passes.sum },
    serving: { attempts: serves.ace + serves.in + serves.error, in: serves.ace + serves.in,
      aces: serves.ace, errors: serves.error },
  };
}
function rowsForPractice(practice) {
  return practiceStats(practice).map(row => ({ player: profile(row.player), stats: fromPractice(row) }));
}
function rowsForSet(record) {
  const state = replaySet(record), stats = getSetStats(state);
  const players = new Map(record.config.players.map(player => [player.id, profile(player)]));
  return Object.entries(stats.players).map(([id, row]) => ({
    player: players.get(id) || { id, name: '', jersey: '?' },
    stats: {
      passing: { count: row.passing?.count ?? 0, sum: row.passing?.sum ?? 0 },
      serving: { attempts: row.serving?.attempts ?? 0, in: row.serving?.in ?? 0,
        aces: row.serving?.aces ?? 0, errors: row.serving?.errors ?? 0 },
    },
  })).filter(row => row.stats.passing.count || row.stats.serving.attempts);
}
function ordered(rows) {
  return [...rows].sort((a, b) => Number(a.player.jersey) - Number(b.player.jersey)
    || a.player.name.localeCompare(b.player.name));
}
function combineRows(rows) {
  const combined = new Map();
  for (const row of rows) {
    let current = combined.get(row.player.id);
    if (!current) {
      current = { player: row.player, stats: zero() };
      combined.set(row.player.id, current);
    }
    add(current.stats, row.stats);
  }
  return ordered(combined.values());
}

/** Aggregate practice events and match-set ratings for one team's saved season. */
export function buildTeamStats(team, allPractices) {
  const teamPractices = allPractices.filter(practice => practice.teamId === team.id)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const practices = teamPractices.map(practice => ({
    id: practice.id, date: practice.date, createdAt: practice.createdAt,
    resultCount: practice.events.length, rows: rowsForPractice(practice),
  }));

  const seasonRows = new Map();
  const ensure = player => {
    let row = seasonRows.get(player.id);
    if (!row) {
      row = { player: profile(player), practice: zero(), matches: zero(), total: zero() };
      seasonRows.set(player.id, row);
    }
    return row;
  };
  for (const player of team.players || []) ensure(player);

  for (const practice of practices) for (const row of practice.rows) {
    const season = ensure(row.player);
    add(season.practice, row.stats);
    add(season.total, row.stats);
  }

  let setCount = 0;
  const matches = team.matches.map(match => {
    const sets = match.sets.map(record => {
      setCount++;
      const state = replaySet(record), rows = rowsForSet(record);
      for (const row of rows) {
        const season = ensure(row.player);
        add(season.matches, row.stats);
        add(season.total, row.stats);
      }
      return {
        id: record.config.id, number: record.config.setNumber ?? 1,
        score: state.score, status: state.status, target: record.config.rules.target,
        rows,
      };
    });
    return {
      id: match.id, opponent: match.opponent, date: match.date, wins: match.wins,
      winner: match.winner, inProgress: match.inProgress, sets, rows: combineRows(sets.flatMap(set => set.rows)),
    };
  });

  const players = ordered([...seasonRows.values()].map(row => ({
    player: row.player, practice: row.practice, matches: row.matches, total: row.total,
  })));
  return {
    players, practices, matches,
    counts: { practices: practices.length, matches: matches.length, sets: setCount,
      practiceResults: practices.reduce((sum, practice) => sum + practice.resultCount, 0) },
  };
}

const rotationAnalysisZero = () => ({
  rallies: 0, won: 0, lost: 0, served: 0, received: 0, wonServing: 0, wonReceiving: 0,
  completed: { rallies: 0, won: 0, lost: 0, served: 0, received: 0, wonServing: 0, wonReceiving: 0 },
  bestRun: 0, longestRunAllowed: 0,
  passing: { count: 0, sum: 0, ratings: { 0: 0, 1: 0, 2: 0, 3: 0 }, linked: 0, sideoutWins: 0 },
});
const playerAnalysisZero = player => ({
  player: profile(player),
  passing: { count: 0, sum: 0, ratings: { 0: 0, 1: 0, 2: 0, 3: 0 }, linked: 0, sideoutWins: 0 },
  serving: { attempts: 0, in: 0, aces: 0, errors: 0, pointsWon: 0, pointsLost: 0 },
});
const addPass = (target, rating) => {
  target.count++; target.sum += rating.rating; target.ratings[rating.rating]++;
};
const scoreBeforeRally = rally => ({
  us: rally.score.us - (rally.winner === 'us' ? 1 : 0),
  them: rally.score.them - (rally.winner === 'them' ? 1 : 0),
});

/* Ratings are logged before the rally. Match the active rating action to the
   next active rally, checking the score and rotation so corrections cannot
   attach a pass to a different point. */
function passesByRally(record, state) {
  const active = new Set(state.activeActionIds ?? []);
  const ratings = new Map((state.receiveRatings ?? []).map(pass => [pass.actionId, pass]));
  const rallies = new Map(state.rallies.map(rally => [rally.actionId, rally]));
  const linked = new Map();
  let waiting = [];
  for (const action of record.actions) {
    if (!active.has(action.id)) continue;
    if (action.type === 'receive.rating') {
      const rating = ratings.get(action.id);
      if (rating) waiting.push(rating);
    } else if (action.type === 'rally') {
      const rally = rallies.get(action.id);
      if (rally?.servingTeam === 'them') {
        const before = scoreBeforeRally(rally);
        for (const rating of waiting) {
          if (rating.rotation === rally.rotation
            && rating.score?.us === before.us && rating.score?.them === before.them)
            linked.set(rating.actionId, rally);
        }
      }
      waiting = [];
    }
  }
  return linked;
}

function lineupDescription(record) {
  const c = record.config, slots = new Map(c.slots.map(slot => [slot.id, slot]));
  const starters = (c.order ?? c.slots.map(slot => slot.id)).map(id => slots.get(id)?.playerId ?? null);
  const plans = c.slots.filter(slot => slot.plan).map(slot => [slot.id, slot.plan.frontPlayerId, slot.plan.backPlayerId]);
  const signature = JSON.stringify({ system: c.system, starters, setters: c.setters, liberos: c.liberos, plans });
  const templateId = c.lineupTemplate?.id ?? 'custom';
  const players = new Map(c.players.map(player => [player.id, profile(player)]));
  const starterLabel = starters.map(id => {
    const player = players.get(id);
    return player ? `#${player.jersey}` : 'missing';
  }).join(' · ');
  const setterLabel = c.setters.map((id, index) => {
    const player = players.get(id);
    const bench = !starters.includes(id);
    return `S${index + 1} ${player ? `#${player.jersey}` : 'missing'}${bench ? ' (bench)' : ''}`;
  }).join(' · ');
  return {
    key: JSON.stringify([templateId, signature]),
    id: templateId,
    name: c.lineupTemplate?.name || 'Custom lineup',
    system: c.system,
    starterLabel,
    setterLabel,
    players,
  };
}

export function savedLineupAnalysisKey(team, lineup) {
  const c = lineupConfig(team, lineup), starters = c.slots.map(slot => slot.playerId);
  const plans = c.slots.filter(slot => slot.plan).map(slot => [slot.id, slot.plan.frontPlayerId, slot.plan.backPlayerId]);
  const signature = JSON.stringify({ system: c.system, starters, setters: c.setters, liberos: c.liberos, plans });
  return JSON.stringify([lineup.id, signature]);
}

function makeLineupAnalysis(info) {
  return {
    ...info, roster: info.players, matches: new Set(), setsPlayed: 0, setsWon: 0, setsLost: 0,
    rallies: 0, won: 0, lost: 0, completedRallies: 0, completedWon: 0, completedLost: 0,
    rotations: Object.fromEntries([1, 2, 3, 4, 5, 6].map(rotation => [rotation, rotationAnalysisZero()])),
    players: new Map(),
  };
}

function analysisPlayer(lineup, id) {
  let row = lineup.players.get(id);
  if (!row) {
    const player = lineup.roster.get(id) ?? { id, name: '', jersey: '?' };
    row = playerAnalysisZero(player); lineup.players.set(id, row);
  }
  return row;
}

function orderedAnalysisPlayers(players) {
  return [...players].sort((a, b) => {
    const ja = Number(a.player.jersey), jb = Number(b.player.jersey);
    if (Number.isFinite(ja) && Number.isFinite(jb) && ja !== jb) return ja - jb;
    return a.player.name.localeCompare(b.player.name);
  });
}

/** Aggregate match outcomes by the exact saved lineup and rotation used. */
export function buildLineupAnalysis(team) {
  const groups = new Map();
  for (const match of team.matches ?? []) for (const record of match.sets ?? []) {
    const state = replaySet(record), info = lineupDescription(record);
    let lineup = groups.get(info.key);
    if (!lineup) { lineup = makeLineupAnalysis(info); groups.set(info.key, lineup); }
    lineup.matches.add(match.id);
    lineup.setsPlayed++;
    const completed = state.status === 'ended';
    if (completed) lineup[state.winner === 'us' ? 'setsWon' : 'setsLost']++;

    const linkedPasses = passesByRally(record, state);
    for (const pass of state.receiveRatings ?? []) {
      const rotation = lineup.rotations[pass.rotation];
      if (!rotation) continue;
      const player = analysisPlayer(lineup, pass.playerId);
      addPass(rotation.passing, pass); addPass(player.passing, pass);
      const rally = linkedPasses.get(pass.actionId);
      if (rally) {
        rotation.passing.linked++; player.passing.linked++;
        if (rally.winner === 'us') {
          rotation.passing.sideoutWins++; player.passing.sideoutWins++;
        }
      }
    }

    let runRotation = null, teamRun = 0, opponentRun = 0;
    for (const rally of state.rallies) {
      const rotation = lineup.rotations[rally.rotation];
      if (!rotation) continue;
      rotation.rallies++; lineup.rallies++;
      if (rally.winner === 'us') { rotation.won++; lineup.won++; }
      else { rotation.lost++; lineup.lost++; }
      if (completed) {
        rotation.completed.rallies++; lineup.completedRallies++;
        if (rally.winner === 'us') { rotation.completed.won++; lineup.completedWon++; }
        else { rotation.completed.lost++; lineup.completedLost++; }
      }
      if (rally.rotation !== runRotation) { runRotation = rally.rotation; teamRun = 0; opponentRun = 0; }
      if (rally.winner === 'us') {
        teamRun++; opponentRun = 0; rotation.bestRun = Math.max(rotation.bestRun, teamRun);
      } else {
        opponentRun++; teamRun = 0; rotation.longestRunAllowed = Math.max(rotation.longestRunAllowed, opponentRun);
      }
      if (rally.servingTeam === 'us') {
        rotation.served++;
        rotation.wonServing += rally.winner === 'us' ? 1 : 0;
        if (completed) {
          rotation.completed.served++;
          rotation.completed.wonServing += rally.winner === 'us' ? 1 : 0;
        }
        const player = rally.serverId ? analysisPlayer(lineup, rally.serverId) : null;
        if (player) {
          player.serving.attempts++;
          player.serving.pointsWon += rally.winner === 'us' ? 1 : 0;
          player.serving.pointsLost += rally.winner === 'them' ? 1 : 0;
          if (rally.team === 'us' && rally.code === 'SE') player.serving.errors++;
          else player.serving.in++;
          if (rally.team === 'us' && rally.code === 'SA') player.serving.aces++;
        }
      } else {
        rotation.received++;
        rotation.wonReceiving += rally.winner === 'us' ? 1 : 0;
        if (completed) {
          rotation.completed.received++;
          rotation.completed.wonReceiving += rally.winner === 'us' ? 1 : 0;
        }
      }
    }
  }
  return [...groups.values()].map(lineup => ({
    id: lineup.id, key: lineup.key, name: lineup.name, system: lineup.system,
    starterLabel: lineup.starterLabel, setterLabel: lineup.setterLabel,
    matches: lineup.matches.size, setsPlayed: lineup.setsPlayed,
    setsWon: lineup.setsWon, setsLost: lineup.setsLost,
    rallies: lineup.rallies, won: lineup.won, lost: lineup.lost,
    completedRallies: lineup.completedRallies, completedWon: lineup.completedWon, completedLost: lineup.completedLost,
    rotations: Object.fromEntries(Object.entries(lineup.rotations).map(([id, rotation]) => [id, {
      ...rotation,
      sideoutRate: rotation.received ? rotation.wonReceiving / rotation.received : null,
      scoringRate: rotation.served ? rotation.wonServing / rotation.served : null,
    }])),
    players: orderedAnalysisPlayers(lineup.players.values()),
  })).sort((a, b) => b.rallies - a.rallies || a.name.localeCompare(b.name));
}

/** Recommend a currently saved lineup and starting rotation from completed sets. */
export function buildLineupSuggestion(team, historyTeam) {
  const rows = new Map(buildLineupAnalysis(historyTeam).map(row => [row.key, row]));
  const candidates = (team.lineups ?? []).map(lineup => ({
    lineup, stats: rows.get(savedLineupAnalysisKey(team, lineup)),
  })).filter(candidate => candidate.stats?.completedRallies >= 12);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aRate = a.stats.completedWon / a.stats.completedRallies;
    const bRate = b.stats.completedWon / b.stats.completedRallies;
    const aSets = a.stats.setsWon + a.stats.setsLost, bSets = b.stats.setsWon + b.stats.setsLost;
    const aSetRate = aSets ? a.stats.setsWon / aSets : 0;
    const bSetRate = bSets ? b.stats.setsWon / bSets : 0;
    return bRate - aRate || bSetRate - aSetRate || b.stats.completedRallies - a.stats.completedRallies;
  });
  const best = candidates[0];
  const rotations = Object.entries(best.stats.rotations)
    .filter(([, rotation]) => rotation.completed.rallies >= 10)
    .sort(([, a], [, b]) => b.completed.won / b.completed.rallies - a.completed.won / a.completed.rallies
      || (b.completed.won - b.completed.lost) - (a.completed.won - a.completed.lost)
      || b.completed.rallies - a.completed.rallies);
  const rotation = rotations.length ? Number(rotations[0][0]) : null;
  const rotationStats = rotation ? best.stats.rotations[rotation].completed : null;
  return {
    lineup: best.lineup,
    stats: best.stats,
    rotation,
    rotationStats: rotationStats ? {
      ...rotationStats,
      sideoutRate: rotationStats.received ? rotationStats.wonReceiving / rotationStats.received : null,
      scoringRate: rotationStats.served ? rotationStats.wonServing / rotationStats.served : null,
    } : null,
    eligibleLineups: candidates.length,
  };
}
