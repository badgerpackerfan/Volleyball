import { lineupConfig, startingRotation } from './lineup-model.mjs';
import { createSet } from '../engine/set-engine.mjs';
import { setPlan } from './match-model.mjs';
import { COLOR_THEMES, colorTheme, inferColorTheme } from '../app/themes.mjs';
export const POSITIONS = ['S','OH','MB','RS','L','DS'];
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const text=(value,label,max=100)=>{need(typeof value==='string' && value.trim().length>0 && value.trim().length<=max,`${label} is required (up to ${max} characters).`);return value.trim();};
export function validateTeam(input) {
  const t=structuredClone(input);
  need(t.schemaVersion===1,'Unsupported team version.');
  t.id=text(t.id,'Team ID');t.name=text(t.name,'Team name');
  t.level=text(t.level,'Level');t.season=text(t.season,'Season');
  if (!t.teamTheme) t.teamTheme=inferColorTheme(t.color).id;
  need(COLOR_THEMES.some(theme=>theme.id===t.teamTheme),'Choose a team theme.');
  const palette=colorTheme(t.teamTheme);
  t.color=palette.accent;
  t.logo ??= null;
  need(t.logo===null||(typeof t.logo==='string'&&t.logo.length<=720000
    &&/^data:image\/(?:png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(t.logo)),'Choose a valid team logo (PNG, JPG, or SVG) up to 512 KB.');
  need(Number.isSafeInteger(t.revision)&&t.revision>=1,'Invalid team revision.');
  need(Array.isArray(t.players)&&t.players.length>0,'Add at least one player to save the team.');
  const jerseys=new Set(),ids=new Set(),athletes=new Set();
  t.players=t.players.map(p=>{
    p.id=text(p.id,'Player ID');p.athleteId=text(p.athleteId,'Athlete ID');p.name=text(p.name,'Player name');
    need(typeof p.jersey==='string' && /^\d{1,2}$/.test(p.jersey.trim()),`Enter a jersey number from 0 to 99 for ${p.name}.`);
    p.jersey=String(Number(p.jersey));
    need(!jerseys.has(p.jersey),`Jersey #${p.jersey} is used more than once. Each player needs a unique number.`);
    need(!ids.has(p.id)&&!athletes.has(p.athleteId),'A player cannot appear twice on the roster.');
    need(POSITIONS.includes(p.position),'Choose a primary position for every player.');
    jerseys.add(p.jersey);ids.add(p.id);athletes.add(p.athleteId);return p;
  });
  t.lineups ??= [];
  need(Array.isArray(t.lineups),'Saved lineups must be a list.');
  const lineupIds=new Set(),lineupNames=new Set();
  for(const lineup of t.lineups){
    lineup.id=text(lineup.id,'Lineup ID');lineup.name=text(lineup.name,'Lineup name');
    need(!lineupIds.has(lineup.id)&&!lineupNames.has(lineup.name.toLowerCase()),'Use a different name for each saved lineup.');
    need(['6-2','5-1','4-2'].includes(lineup.system)&&Array.isArray(lineup.starters)&&lineup.starters.length===6
      && Array.isArray(lineup.setters)&&Array.isArray(lineup.liberos),'Invalid saved lineup.');
    lineupIds.add(lineup.id);lineupNames.add(lineup.name.toLowerCase());
  }
  // Matches saved ahead of time (a season schedule). Set 1 later uses the same match ID.
  t.plannedMatches ??= [];
  need(Array.isArray(t.plannedMatches),'Saved matches must be a list.');
  const matchIds=new Set();
  t.plannedMatches=t.plannedMatches.map(m=>{
    const match={id:text(m.id,'Match ID'),opponent:text(m.opponent,'Opponent name'),date:m.date,bestOf:m.bestOf};
    need(/^\d{4}-\d{2}-\d{2}$/.test(match.date)&&Number.isFinite(Date.parse(match.date)),'Choose the match date.');
    need([3,5].includes(match.bestOf),'Choose best of 3 or best of 5.');
    need(!matchIds.has(match.id),'A saved match appears twice.');matchIds.add(match.id);
    return match;
  });
  return t;
}
export function makeMatchSet(team, choices, identity) {
  const t=validateTeam(team);
  const opponent=text(choices.opponent,'Opponent name');
  need(/^\d{4}-\d{2}-\d{2}$/.test(choices.date)&&Number.isFinite(Date.parse(choices.date)),'Choose the match date.');
  need(Array.isArray(choices.starters)&&choices.starters.length===6,'Choose six starters.');
  const setNumber=identity.setNumber ?? 1;
  need(Number.isSafeInteger(setNumber)&&setNumber>=1,'Invalid set number.');
  const bestOf=choices.bestOf ?? 3;
  const plan=setPlan({bestOf,setNumber,previousSet:choices.previousSet});
  const firstServe=plan.firstServe ?? choices.firstServe;
  need(['us','them'].includes(firstServe),'Choose who serves first.');
  if(choices.lineupId)need(t.lineups.some(l=>l.id===choices.lineupId),'Choose a saved lineup from this team.');
  const mode=choices.rotationMode??'auto';
  const rotation=startingRotation({mode,firstServe,rotation:choices.rotation,previousSet:choices.previousSet});
  if(mode==='carry')need(choices.previousSet.config.teamId===t.id&&choices.previousSet.config.matchId===identity.matchId,'Carry rotation only from the previous set of this team’s match.');
  return createSet({setNumber,bestOf,rules:{target:plan.target},id:identity.setId,matchId:identity.matchId,teamId:t.id,teamRevision:t.revision,
    teamName:t.name,teamColor:t.color,teamTheme:t.teamTheme,opponentName:opponent,matchDate:choices.date,
    firstServe,startingRotation:rotation,
    startingRotationSource:{mode,...(mode==='carry'?{setId:choices.previousSet.config.id,revision:choices.previousSet.actions.length}:{})},
    ...(choices.lineupId?{lineupTemplate:{id:choices.lineupId,name:t.lineups.find(l=>l.id===choices.lineupId)?.name??'Custom'}}:{}),
    ...lineupConfig(t,choices),
  });
}
