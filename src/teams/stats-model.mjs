import { getSetStats, replaySet } from '../engine/set-engine.mjs';
import { practiceStats } from '../practice/practice-model.mjs';

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
