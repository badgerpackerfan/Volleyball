const need=(ok,message)=>{if(!ok)throw new Error(message);};
const requiredText=(value,label,max=120)=>{
  need(typeof value==='string'&&value.trim().length>0&&value.trim().length<=max,`${label} is required.`);
  return value.trim();
};
const localDate=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

export const SERVE_RESULTS=Object.freeze(['ace','in','error']);
export const PASS_RATINGS=Object.freeze([0,1,2,3]);

export function validatePractice(input){
  const practice=structuredClone(input);
  need(practice.schemaVersion===1,'Unsupported practice version.');
  practice.id=requiredText(practice.id,'Practice ID');
  practice.teamId=requiredText(practice.teamId,'Team ID');
  practice.teamName=requiredText(practice.teamName,'Team name');
  need(/^\d{4}-\d{2}-\d{2}$/.test(practice.date)&&Number.isFinite(Date.parse(practice.date)), 'Invalid practice date.');
  need(typeof practice.createdAt==='string'&&Number.isFinite(Date.parse(practice.createdAt)),'Invalid practice date and time.');
  need(Number.isSafeInteger(practice.revision)&&practice.revision>=0,'Invalid practice revision.');
  need(Array.isArray(practice.players)&&practice.players.length>0,'A practice needs a roster snapshot.');
  const playerIds=new Set();
  practice.players=practice.players.map(player=>{
    player.id=requiredText(player.id,'Player ID');
    player.name=requiredText(player.name,'Player name');
    need(typeof player.jersey==='string'&&/^\d{1,2}$/.test(player.jersey),'Invalid jersey number.');
    need(!playerIds.has(player.id),'A player appears more than once in the practice roster.');
    playerIds.add(player.id);
    return player;
  });
  need(Array.isArray(practice.events),'Practice results must be a list.');
  const eventIds=new Set();
  practice.events=practice.events.map(event=>{
    event.id=requiredText(event.id,'Practice event ID');
    need(!eventIds.has(event.id),'A practice event appears more than once.');
    need(playerIds.has(event.playerId),'A practice event refers to a player outside its roster.');
    need(typeof event.occurredAt==='string'&&Number.isFinite(Date.parse(event.occurredAt)),'Invalid event time.');
    if(event.skill==='serve')need(SERVE_RESULTS.includes(event.result),'Invalid serve result.');
    else if(event.skill==='pass')need(PASS_RATINGS.includes(event.result),'Invalid serve-receive rating.');
    else throw new Error('Unsupported practice skill.');
    eventIds.add(event.id);
    return event;
  });
  return practice;
}

export function createPractice(team,id,now=new Date()){
  need(team&&typeof team.id==='string'&&Array.isArray(team.players)&&team.players.length>0,'Choose a team with players before starting practice.');
  return validatePractice({
    schemaVersion:1,id,teamId:team.id,teamName:team.name,date:localDate(now),createdAt:now.toISOString(),revision:0,
    players:team.players.map(({id:playerId,name,jersey})=>({id:playerId,name,jersey})),events:[],
  });
}

export function recordPracticeResult(input,{skill,playerId,result},id=crypto.randomUUID(),occurredAt=new Date().toISOString()){
  const practice=validatePractice(input);
  return validatePractice({...practice,revision:practice.revision+1,events:[...practice.events,{id,skill,playerId,result,occurredAt}]});
}

export function undoPracticeResult(input,playerId=null){
  const practice=validatePractice(input);
  need(practice.events.length>0,'There is no practice result to undo.');
  let removeAt=practice.events.length-1;
  if(playerId!==null){
    removeAt=-1;
    for(let i=practice.events.length-1;i>=0;i--){if(practice.events[i].playerId===playerId){removeAt=i;break;}}
    need(removeAt>=0,'This player has no result to undo.');
  }
  return validatePractice({...practice,revision:practice.revision+1,events:practice.events.filter((_,i)=>i!==removeAt)});
}

export function practiceStats(input){
  const practice=validatePractice(input);
  const stats=new Map(practice.players.map(player=>[player.id,{
    player,serves:{ace:0,in:0,error:0},passes:{0:0,1:0,2:0,3:0,total:0,sum:0},
  }]));
  for(const event of practice.events){
    const row=stats.get(event.playerId);
    if(event.skill==='serve')row.serves[event.result]++;
    else{row.passes[event.result]++;row.passes.total++;row.passes.sum+=event.result;}
  }
  return [...stats.values()];
}

export function practiceEventLabel(event){
  if(event.skill==='serve')return event.result==='error'?'Serve error':event.result==='ace'?'Ace':'Serve in';
  return `Pass ${event.result}`;
}
