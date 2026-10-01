import { createSet, replaySet } from '../engine/set-engine.mjs';

export function lineupConfig(team, lineup) {
  const slots=lineup.starters.map((playerId,i)=>({id:String(i+1),playerId}));
  const secondSetter=lineup.setters[1],firstSetterIndex=lineup.starters.indexOf(lineup.setters[0]);
  if(lineup.system==='6-2'&&firstSetterIndex>=0&&secondSetter&&!lineup.starters.includes(secondSetter)){
    const oppositeIndex=(firstSetterIndex+3)%6,frontPlayerId=lineup.starters[oppositeIndex];
    slots[oppositeIndex].plan={frontPlayerId,backPlayerId:secondSetter};
  }
  return {
    system:lineup.system,
    players:team.players.map(p=>({id:p.id,athleteId:p.athleteId,jersey:p.jersey,name:p.name,position:p.position,available:true})),
    slots,
    setters:[...lineup.setters],liberos:[...lineup.liberos],
  };
}
export function validateLineup(team, input) {
  if(!input || typeof input.id!=='string' || !input.id.trim())throw new Error('A lineup ID is required.');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100)throw new Error('Enter a lineup name (up to 100 characters).');
  if(!Array.isArray(input.starters)||input.starters.length!==6||!Array.isArray(input.setters)||!Array.isArray(input.liberos))throw new Error('Choose six starters, the setter(s), and any liberos.');
  const ids=new Set(team.players.map(p=>p.id));
  if([...input.starters,...input.setters,...input.liberos].some(id=>!ids.has(id)))throw new Error('Choose roster players for every lineup slot; a saved player may have been removed.');
  createSet({id:'lineup-check',teamId:team.id,matchId:'lineup-check',firstServe:'us',...lineupConfig(team,input)});
  return {id:input.id,name:input.name.trim(),system:input.system,starters:[...input.starters],setters:[...input.setters],liberos:[...input.liberos]};
}
export function lineupIssue(team, lineup) {
  try{validateLineup(team,lineup);return null;}catch(e){return e.message;}
}
export function startingRotation({mode='auto',firstServe,rotation,previousSet}) {
  if(mode==='auto'){
    if(!['us','them'].includes(firstServe))throw new Error('Choose who serves first.');
    return firstServe==='us'?1:6;
  }
  if(mode==='carry'){
    if(!previousSet)throw new Error('There is no previous set in this match.');
    const state=replaySet(previousSet);
    if(state.status!=='ended')throw new Error('Finish the previous set before carrying over its rotation.');
    return state.rotation;
  }
  if(mode!=='manual'||!Number.isInteger(rotation)||rotation<1||rotation>6)throw new Error('Choose a starting rotation from R1 through R6.');
  return rotation;
}
export function lineupFromSet(record) {
  const c=record.config;
  return {system:c.system,starters:c.order.map(id=>c.slots.find(s=>s.id===id).playerId),setters:[...c.setters],liberos:[...c.liberos]};
}
