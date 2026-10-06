const POSITIONS=['P1','P2','P3','P4','P5','P6'];
const OFFENSES=['5-1','6-2','4-2','other','unsure'];
const DEFENSES=['perimeter','rotational','middle-up','other','unsure'];
const EMPTY_SIX=()=>Object.fromEntries(POSITIONS.map(position=>[position,'']));

export function emptyOpponentScout(){
 return {moment:'start',offense:'',defense:'',setters:[],six:{start:EMPTY_SIX(),mid:EMPTY_SIX()}};
}
function jersey(value,label='Jersey number'){
 const result=String(value??'').trim();
 if(!result)return '';
 if(!/^\d{1,2}$/.test(result))throw new Error(`${label} must be a number from 0 to 99.`);
 return String(Number(result));
}
export function normalizeOpponentScout(input){
 if(input==null)return null;
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Opponent scouting data is invalid.');
 const scout=emptyOpponentScout();
 scout.moment=input.moment==='mid'?'mid':'start';
 scout.offense=OFFENSES.includes(input.offense)?input.offense:'';
 scout.defense=DEFENSES.includes(input.defense)?input.defense:'';
 for(const snapshot of ['start','mid']){
  const source=input.six?.[snapshot]??{};
  for(const position of POSITIONS)scout.six[snapshot][position]=jersey(source[position],`${position} jersey number`);
  const filled=POSITIONS.map(position=>scout.six[snapshot][position]).filter(Boolean);
  if(new Set(filled).size!==filled.length)throw new Error('A player cannot occupy two positions in the same six.');
 }
 const setters=Array.isArray(input.setters)?input.setters:[];
 scout.setters=setters.map(item=>({jersey:jersey(item?.jersey,'Setter jersey number'),snapshot:item?.snapshot==='mid'?'mid':'start'})).filter(item=>item.jersey);
 if(scout.setters.some((item,index)=>scout.setters.findIndex(other=>other.jersey===item.jersey&&other.snapshot===item.snapshot)!==index))
  throw new Error('A setter is already listed for that lineup.');
 return scout;
}
export function opponentScoutHasInfo(input){
 const scout=normalizeOpponentScout(input);if(!scout)return false;
 return Boolean(scout.offense||scout.defense||scout.setters.length||Object.values(scout.six).some(six=>Object.values(six).some(Boolean)));
}
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const option=(value,label,selected)=>`<option value="${value}"${selected===value?' selected':''}>${label}</option>`;
export function opponentScoutEditorMarkup(input){
 const scout=normalizeOpponentScout(input)??emptyOpponentScout(),moment=scout.moment;
 const six=scout.six[moment],setters=scout.setters.filter(item=>item.snapshot===moment).map(item=>item.jersey).join(', ');
 const positionInputs=['P4','P3','P2','P5','P6','P1'].map(position=>`<label class="scout-position"><span>${position}</span><input data-scout-position="${position}" type="text" inputmode="numeric" maxlength="2" value="${esc(six[position])}" aria-label="Opponent player at ${position}"></label>`).join('');
 return `<div class="opponent-scout-editor">
  <label class="scout-moment-label">When are you entering this?<select data-scout-field="moment">${option('start','Starting six · before the set',moment)}${option('mid','Current six · entering mid-set',moment)}</select></label>
  <p class="scout-help">Enter jersey numbers by court position. Leave unknown players blank; you do not need to know their rotation.</p>
  <div class="scout-court" aria-label="Opponent court positions">${positionInputs}</div>
  <label>Offensive system<select data-scout-field="offense">${option('','Not known',scout.offense)}${option('5-1','5–1',scout.offense)}${option('6-2','6–2',scout.offense)}${option('4-2','4–2',scout.offense)}${option('other','Other',scout.offense)}${option('unsure','Unsure',scout.offense)}</select></label>
  <label>Setters you have identified<input data-scout-field="setters" type="text" inputmode="numeric" value="${esc(setters)}" placeholder="For example: 7, 12" autocomplete="off"></label>
  <label>Base defense<select data-scout-field="defense">${option('','Not known',scout.defense)}${option('perimeter','Perimeter',scout.defense)}${option('rotational','Rotational',scout.defense)}${option('middle-up','Middle-up',scout.defense)}${option('other','Other',scout.defense)}${option('unsure','Unsure',scout.defense)}</select></label>
  <p class="scout-help">Setter numbers apply to the lineup currently shown. Add or update them when you learn more.</p>
  <div class="sheet-row"><button type="button" class="cancel" id="shCancel">Cancel</button><button type="button" class="pill" id="scoutSave">Save scouting</button></div>
 </div>`;
}
export function readOpponentScoutEditor(root, prior){
 const scout=normalizeOpponentScout(prior)??emptyOpponentScout();
 const moment=root.querySelector('[data-scout-field="moment"]').value;
 scout.moment=moment==='mid'?'mid':'start';
 const snapshot=scout.moment;
 for(const position of POSITIONS)scout.six[snapshot][position]=root.querySelector(`[data-scout-position="${position}"]`).value.trim();
 scout.offense=root.querySelector('[data-scout-field="offense"]').value;
 scout.defense=root.querySelector('[data-scout-field="defense"]').value;
 scout.setters=scout.setters.filter(item=>item.snapshot!==snapshot);
 const raw=root.querySelector('[data-scout-field="setters"]').value;
 const numbers=raw.split(/[\s,;]+/).map(value=>value.trim()).filter(Boolean);
 for(const value of numbers)scout.setters.push({jersey:jersey(value,'Setter jersey number'),snapshot});
 return normalizeOpponentScout(scout);
}
export function mountOpponentScoutEditor(root, initial, onSave){
 let draft=normalizeOpponentScout(initial)??emptyOpponentScout();
 const draw=()=>{
  root.innerHTML=opponentScoutEditorMarkup(draft);
  const moment=root.querySelector('[data-scout-field="moment"]');
  moment.onchange=()=>{
   const selected=moment.value;moment.value=draft.moment;
   try{draft=readOpponentScoutEditor(root,draft);draft.moment=selected;draw();}
   catch(error){moment.value=draft.moment;const note=root.querySelector('.scout-help');note.textContent=error.message;note.classList.add('scout-error');}
  };
  root.querySelector('#scoutSave').onclick=async()=>{
   try{const value=readOpponentScoutEditor(root,draft);await onSave(value);}
   catch(error){const note=root.querySelector('.scout-help');note.textContent=error.message;note.classList.add('scout-error');}
  };
 };
 draw();
}
