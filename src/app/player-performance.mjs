export const PLAYER_PERFORMANCE_HEADERS = '<th>Pass avg</th><th>Serve In %</th><th>Hitting %</th>';

function hittingPercent(attacks) {
  const kills = attacks.kills ?? attacks.kill ?? 0;
  const errors = attacks.hittingErrors ?? attacks.error ?? 0;
  const inPlay = attacks.nonTerminalAttempts ?? attacks.in ?? 0;
  const total = attacks.total ?? kills + errors + inPlay;
  if (!total) return '—';
  return ((kills - errors) / total).toFixed(3).replace(/^(-?)0\./, '$1.');
}

function metric(value, detail, name) {
  return `<td class="player-performance-metric ${name}"><span class="player-stat-value">${value}</span><small class="player-stat-detail">${detail}</small></td>`;
}

/** Shared pass, serve, and attack cells for practice and match player tables. */
export function playerPerformanceCells(stats) {
  const passing = stats.passing ?? {};
  const serving = stats.serving ?? {};
  const attacking = stats.attacking ?? {};
  const passCount = passing.count ?? passing.total ?? 0;
  const passAverage = passCount ? (passing.sum / passCount).toFixed(2) : '—';
  const serveIn = serving.in ?? ((serving.aces ?? 0) + (serving.nonAceIn ?? 0));
  const serveAttempts = serving.attempts ?? (serveIn + (serving.errors ?? 0));
  const servePercent = serveAttempts ? `${Math.round(serveIn * 100 / serveAttempts)}%` : '—';
  const kills = attacking.kills ?? attacking.kill ?? 0;
  const errors = attacking.hittingErrors ?? attacking.error ?? 0;
  const inPlay = attacking.nonTerminalAttempts ?? attacking.in ?? 0;

  return metric(passAverage, `n=${passCount}`, 'passing')
    + metric(servePercent, `n=${serveAttempts}`, 'serving')
    + metric(hittingPercent(attacking), `K ${kills} · In ${inPlay} · E ${errors}`, 'attacking');
}
