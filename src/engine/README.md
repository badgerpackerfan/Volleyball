# Set engine

`set-engine.mjs` is a pure ES module for one set. It runs in a browser or Node without dependencies. It does not read the DOM, save data, generate IDs, or read the clock. The persistent app at `index.html` uses this engine; the approved HTML mockup retains its original demo engine.

Run the tests from the project root with `npm test` (Node 22.8+). No dependency installation is needed.

## Create and use a set

```js
import { createSet, dispatch, replaySet, checkCommand, getSetStats } from './set-engine.mjs';

let record = createSet({
  id: 'set-1', teamId: 'team-1', matchId: 'match-1',
  system: '6-2', firstServe: 'them',
  players: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'L', 'M'].map((id, i) => ({
    id, athleteId: `athlete-${id}`, jersey: String(i + 1), available: true,
  })),
  // Stable slot identities, initially ordered P1 through P6.
  slots: ['A', 'B', 'C', 'D', 'E', 'F'].map((playerId, i) => ({
    id: `slot-${i + 1}`, playerId,
    ...(i === 4 ? { plan: { frontPlayerId: 'G', backPlayerId: 'E' } } : {}),
  })),
  setters: ['A', 'D'], liberos: ['L', 'M'],
  rules: { target: 25, winBy: 2, substitutionLimit: 18, timeoutsPerTeam: 2 },
});

const result = dispatch(record, {
  type: 'rally', payload: { team: 'us', code: 'K', playerId: 'B' },
}, {
  id: 'action-1', occurredAt: '2026-09-29T18:00:00.000Z', expectedRevision: 0,
});
record = result.record;

// R1 receives the side-out point; the next server is B in R2.
console.log(result.state.score, result.state.rotation, result.state.serverId);
console.log(result.state.rallies[0].rotation); // 1
console.log(result.state.prompts); // Planned G-for-E substitution, not yet applied.

// In the app, save record atomically before confirming the action as saved.
const restored = JSON.parse(JSON.stringify(record));
const state = replaySet(restored);
const stats = getSetStats(state);
```

Players are **team roster-entry IDs**, not jersey numbers or athlete IDs. Athletes remain separate identities so another team can use a different roster entry. Set/team/match IDs are references here; the Teams screen manages rosters and snapshots their display data into each new set. The journal uses stable roster IDs, not editable jersey numbers.

Opponent substitutions are observational events recorded with `opponent.substitution` and `{ outJersey, inJersey }`. They save the current score and our rotation for context, but do not alter our lineup or apply our team's substitution rules. Together with the rally history, these events preserve the opponent's player changes for later rotation reconstruction.

The optional `order` field specifies the lineup’s base R1 slot order at P1–P6. `startingRotation` (1–6, default 1 for legacy records) rotates that base order to initialize the actual court and rotation label. `state.rotations` counts side-outs during this set; `state.rotation` is the current R1–R6 label. New set setup defaults to R1 when serving and R6 when receiving, with manual and previous-set ending rotation choices. Six regular starters are required; enter a libero as an explicit action before the first rally if needed. Planned setter pairs may include a player currently on the bench; the active setter label is null until the appropriate designated setter is actually on court.

## Commands

Every `dispatch(record, command, meta)` returns a new `{ record, state, action }`. The input is never mutated. Metadata requires a unique string ID and valid timestamp; provide `expectedRevision` to reject stale UI commands. `updatedAt` equals `occurredAt` on immutable action records. Replay order is the recorded sequence, not a timestamp sort.

| Type | Payload | Behavior |
|---|---|---|
| `rally` | `{ team, code, playerId? }` | One terminal action, one point; captures pre-rotation context. SA/SE automatically identify our server. Our earned points require a player; other errors can be unattributed. |
| `substitution` | `{ slotId, outPlayerId, inPlayerId, planned?, override? }` | Validates the current occupant, bench eligibility, limits, and partner locks. Planned swaps also validate the current plan/row. |
| `libero.in` | `{ slotId, outPlayerId, inPlayerId, override? }` | Back-row replacement by a designated libero; validates rally interval and serving rules. |
| `libero.out` | `{ outPlayerId }` | Restores the covered player; validates the current libero. |
| `libero.switch` | `{ outPlayerId, inPlayerId }` | Direct switch between designated liberos, preserving the covered player. |
| `timeout` | `{ team }` | Deducts from that team's allowance and records score/rotation context. |
| `set.end` (legacy) | `{ score: { us, them } }` | Retained only to replay older journals that required confirmation. New winning rallies end the set automatically. |
| `receive.edit` | `{ key, positions }` | Saves a validated six-position diagram for the current system/rotation/setter and OH/RS choice. `positions: null` resets that diagram. |
| `receive.select` | `{ passer: 'OH' or 'RS' }` | Persists the chosen receive diagram; unavailable while serving or with a front-row setter. |
| `receive.rating` | `{ playerId, rating: 0–3 }` | Records an on-court player's serve-receive rating while the opponent is serving. |
| `libero.plan` | `{ role: 'mid', 'oh', or 'none' }` | Records the coach's libero-plan choice. |
| `undo` | `{}` | Appends an undo reference to the latest active action and replays the remainder. |

Team values are `us` and `them`. The UI resolves those IDs to actual names. Codes include the fixed paper legend plus OE (Other Error), NET, and VIO; legacy BKE, BHE, and DigE records remain readable. Configurable code lists remain future work.

Unknown players, duplicate on-court players, unavailable players, front-row libero assignments, stale occupants, and illegal serving/receive code choices are rejected. The engine does not reinterpret the coach's choice of terminal code or infer unrecorded contacts.

An `override` is `{ reason: 'Explanation of the official-record discrepancy' }`. It can bypass substitution limits/partner locks and the libero re-entry interval. It cannot create duplicate players, substitute an unavailable player, put a libero in a front-row slot, or bypass a stale selection. An override and its violated rules are derived into `state.overrides` and retained in the original event payload.

Overridden partner changes preserve **all** historical pairings symmetrically. Players with conflicting pairings require another explicit override for subsequent incompatible substitutions; an override never silently unlocks or rewrites their earlier pair.

`checkCommand(record, command)` returns `{ allowed, error }` through the same validation as dispatch. Use it to explain disabled choices in a bench picker. Always dispatch again on confirmation; a prior eligibility check is not permission to bypass current state.

## State, replay, and undo

`replaySet(record)` validates configuration, action identity/sequence, and each transition. It reconstructs:

- Score, serving side/server, six slot positions, current occupants, and rotation/setter position.
- Rally-time court/back-row snapshots, substitution counts and locks, libero replacements, and timeouts.
- Planned-swap prompts, paused-plan notices, low-sub warnings, automatic set completion, and receive ratings.
- Active action IDs, revision, recorded overrides, receive diagrams/choice, and libero plan.

State snapshots are derived values. `record.config` and the ordered immutable action list are the source of truth. Undo records remain in that list, along with the original actions they reference. Undo applies to the latest active action; undoing a new winning rally reopens the set. Redo and arbitrary historical editing are not implemented yet.

Automatic libero exit when a side-out moves the slot to P4 is recorded as a consequence of that rally in `liberoReplacements`, using the rally's action ID. Undoing the rally reverses the score, rotation, and automatic replacement together. Libero replacements never consume substitutions or establish substitution partner locks.

New rallies carry `automaticSetEnd: true`; a winning rally sets `status: 'ended'` and the winner in the same transition. Further actions are rejected until Undo removes that rally. The target and winning margin must both be reached; an explicitly configured cap is still honored. Match setup offers 25 or 15 with win-by-two rules.

Older journals remain immutable and replay under their original action semantics, including historical `set.end` events. At the end of replay, an older set still awaiting confirmation at a winning score is treated as ended. New commands cannot append points to it. Each set retains its configured rules; match formats and first-serve alternation remain separate work.

`getSetStats(state)` derives code counts, player earned-minus-error totals, serve-receive rating counts and averages, and per-rotation records. Side-out/serving rates use the serving side during each rally, with `null` for an empty denominator. Undo removes inactive actions from all derived statistics.

## Boundaries of this delivery

- The app saves records with IndexedDB; real Firefox tests cover reopen, migration, aborted transactions, conflicts, and undo. Actual iPad force-close/power-loss tests remain pending.
- `rally.edit` replaces or deletes an earlier rally (`{targetActionId, team, code, playerId}` or `{targetActionId, delete: true}`); the active journal is replayed with the latest edit per rally, and an edit that invalidates a later action is rejected with `EDIT_CONFLICT`.
- `correction` sets the official score, rotation, and serving team (`{score, rotation, servingTeam, reason?}`) without touching rallies or statistics; it can end or reopen a set.
- Both are allowed after the set ends, and Undo reverses them like any other action.
- The default rules implement the documented set-level decisions, including direct switching between two liberos and re-entry at P1 to serve. This is not a complete implementation or independent verification of every NFHS/NDHSAA regulation. Team participation limits and any additional association-specific service/replacement restrictions need their own rule work.
- Receive geometry is checked by the shared `receive-layout.mjs`. These are diagram bounds, spacing, and order checks using disc centers, not certification of player feet at serve contact. Diagrams are scoped by their owning set/team/lineup and context key; reuse across lineups is not implemented. Coaching suggestions remain outside this module.
- Dispatch validates/replays the full history for correctness in this first version. Measure actual-device performance before integrating caching or checkpoints; any optimization must retain the replay invariants.
