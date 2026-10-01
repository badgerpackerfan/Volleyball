import { replaySet } from '../engine/set-engine.mjs';
import { colorTheme, inferColorTheme } from '../app/themes.mjs';

// Standard match rules: every set goes to 25 except the deciding set (3 of a
// best-of-3, 5 of a best-of-5), which goes to 15. First serve is chosen for set 1
// and the deciding set; other sets alternate from the set before.
export function setPlan({bestOf,setNumber,previousSet}) {
  if(![3,5].includes(bestOf))throw new Error('Choose best of 3 or best of 5.');
  if(!Number.isSafeInteger(setNumber)||setNumber<1||setNumber>bestOf)throw new Error(`A best-of-${bestOf} match has at most ${bestOf} sets.`);
  const deciding=setNumber===bestOf,chooseServe=setNumber===1||deciding;
  if(!chooseServe&&!previousSet)throw new Error('The previous set is needed to alternate first serve.');
  return {deciding,target:deciding?15:25,
    firstServe:chooseServe?null:previousSet.config.firstServe==='us'?'them':'us'};
}
export const matchWinner=(wins,bestOf)=>bestOf?(['us','them'].find(side=>wins[side]>bestOf/2)??null):null;

export function orderMatchSets(records) {
  return [...records].sort((a,b)=>(a.config.setNumber??1)-(b.config.setNumber??1)
    || (a.actions[0]?.occurredAt??'').localeCompare(b.actions[0]?.occurredAt??'')
    || a.config.id.localeCompare(b.config.id));
}

// Existing records already have team/match identities. Group those identities,
// never names or dates: two matches against the same opponent stay separate.
export function teamHierarchy(teams, records) {
  const groups=new Map(teams.map(team=>[team.id,{...team,editable:true,
    matches:(team.plannedMatches??[]).map(p=>({id:p.id,teamId:team.id,sets:[],planned:p}))}]));
  for(const record of records) {
    const c=record.config;
    if(!groups.has(c.teamId)){
      const palette=c.teamTheme?colorTheme(c.teamTheme):inferColorTheme(c.teamColor||'#438893');
      groups.set(c.teamId,{id:c.teamId,name:c.teamName||'8th Grade (sample)',
        color:palette.accent,teamTheme:palette.id,logo:null,players:[],editable:false,matches:[]});
    }
    const group=groups.get(c.teamId);
    let match=group.matches.find(m=>m.id===c.matchId);
    if(!match){match={id:c.matchId,teamId:c.teamId,sets:[]};group.matches.push(match);}
    match.sets.push(record);
  }
  for(const team of groups.values()) {
    for(const match of team.matches) {
      match.sets=orderMatchSets(match.sets);
      // Once a set exists its saved snapshot is authoritative; before that, the saved schedule.
      const first=match.sets[0]?.config;
      match.opponent=first?(first.opponentName||'West Fargo'):match.planned.opponent;
      match.date=first?(first.matchDate||''):match.planned.date;
      match.bestOf=match.sets.find(r=>r.config.bestOf)?.config.bestOf??(first?null:match.planned.bestOf);
      match.wins={us:0,them:0};match.inProgress=false;
      for(const record of match.sets){const state=replaySet(record);if(state.status==='ended')match.wins[state.winner]++;else match.inProgress=true;}
      match.winner=matchWinner(match.wins,match.bestOf);
    }
    team.matches.sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  }
  return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

export function validateSetAddition(record, existing) {
  const c=record.config;
  const sameMatch=existing.filter(r=>r.config.matchId===c.matchId);
  if(sameMatch.some(r=>r.config.teamId!==c.teamId))throw new Error('This match belongs to another team.');
  const siblings=orderMatchSets(sameMatch);
  if((c.setNumber??1)!==siblings.length+1)throw new Error('The match changed. Reload its sets before starting the next set.');
  if(siblings.some(r=>replaySet(r).status!=='ended'))throw new Error('Finish the current set before starting the next set in this match.');
  if(c.bestOf){
    if(siblings.some(r=>r.config.bestOf&&r.config.bestOf!==c.bestOf))throw new Error('A new set must keep the match format.');
    const wins={us:0,them:0};for(const r of siblings)wins[replaySet(r).winner]++;
    const optionalThirdSet=c.bestOf===3&&(c.setNumber??1)===3&&siblings.length===2;
    if(matchWinner(wins,c.bestOf)&&!optionalThirdSet)throw new Error('This match is already decided.');
    const plan=setPlan({bestOf:c.bestOf,setNumber:c.setNumber??1,previousSet:siblings.at(-1)});
    if(c.rules.target!==plan.target||(plan.firstServe&&c.firstServe!==plan.firstServe))
      throw new Error('The set target or first serve does not follow the match format.');
  }
  if(c.startingRotationSource?.mode==='carry'){
    const previous=siblings.at(-1),source=c.startingRotationSource;
    if(!previous||previous.config.id!==source.setId||previous.actions.length!==source.revision
      ||replaySet(previous).rotation!==c.startingRotation)
      throw new Error('The previous set changed. Review its ending rotation before starting this set.');
  }
  if(siblings.length){const first=siblings[0].config;
    if(c.opponentName!==first.opponentName||c.matchDate!==first.matchDate)
      throw new Error('A new set must keep the match’s opponent and date.');
  }
}
