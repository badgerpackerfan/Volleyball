const POSITIONS=['P1','P2','P3','P4','P5','P6'];
// From our end of the court, their positions appear rotated 180°: their net is
// at the bottom, P2/P3/P4 are nearest the net, and P1/P6/P5 are at the back.
const COURT_VIEW=['P1','P6','P5','P2','P3','P4'];
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
export function opponentScoutEditorMarkup(input,selectedPosition=null,entryMode='court',benchEntry='',error=''){
 let scout;
 try{scout=normalizeOpponentScout(input)??emptyOpponentScout();}
 catch{scout=structuredClone(input);}
 const moment=scout.moment;
 const six=scout.six[moment],setters=scout.setters.filter(item=>item.snapshot===moment);
 const positionInputs=COURT_VIEW.map((position,index)=>{
  const number=six[position],setter=Boolean(number&&setters.some(item=>item.jersey===number));
  return `<button type="button" class="scout-position ${selectedPosition===position&&entryMode==='court'?'selected':''} ${setter?'setter':''}" data-scout-cell="${position}" style="--column:${index%3};--row:${Math.floor(index/3)}" aria-label="${position}, jersey ${esc(number||'not entered')}${setter?', setter':''}"><small>${position}</small><strong>${esc(number||'＋')}</strong>${setter?'<span class="setter-tag">SETTER</span>':''}</button><input type="hidden" data-scout-position="${position}" value="${esc(number)}">`;
 }).join('');
 const currentNumber=entryMode==='bench-setter'?benchEntry:selectedPosition?six[selectedPosition]:'';
 const selectedSetter=selectedPosition&&six[selectedPosition]&&setters.some(item=>item.jersey===six[selectedPosition]);
 const setterChips=setters.map(item=>`<button type="button" class="scout-setter-chip" data-scout-remove-setter="${esc(item.jersey)}" aria-label="Remove setter #${esc(item.jersey)}">#${esc(item.jersey)} <span aria-hidden="true">×</span></button>`).join('');
 const selectionDisabled=entryMode==='court'&&!selectedPosition;
 const digitDisabled=selectionDisabled||currentNumber.length>=2;
 const editDisabled=selectionDisabled||!currentNumber;
 const keypad=Array.from({length:9},(_,index)=>`<button type="button" data-scout-digit="${index+1}" ${digitDisabled?'disabled':''}>${index+1}</button>`).join('');
 return `<div class="opponent-scout-editor">
  <div class="scout-moment-row"><label>Lineup<select data-scout-field="moment">${option('start','Starting six · before the set',moment)}${option('mid','Current six · entering mid-set',moment)}</select></label><p class="scout-help">Tap a court position, then use the number pad. Unknown positions can stay blank.</p></div>
  <div class="scout-court-entry">
   <div class="scout-court" role="group" aria-label="Opponent half court, viewed across the net">
    <span class="scout-attack-line" aria-hidden="true"></span><span class="scout-net" aria-hidden="true"><b>NET</b></span>${positionInputs}
   </div>
   <div class="scout-number-panel">
    <div class="scout-number-heading">${entryMode==='bench-setter'?'Bench setter':selectedPosition?`Position ${selectedPosition}`:'Choose a position'}</div>
    <output class="scout-number-display" aria-live="polite">${esc(currentNumber||'—')}</output>
    <div class="scout-number-pad" aria-label="Jersey number keypad">${keypad}<button type="button" data-scout-digit="0" ${digitDisabled?'disabled':''}>0</button><button type="button" data-scout-backspace ${editDisabled?'disabled':''} aria-label="Delete last digit">⌫</button><button type="button" data-scout-clear ${editDisabled?'disabled':''}>Clear</button></div>
    ${entryMode==='bench-setter'?`<button type="button" class="scout-setter-toggle" data-scout-add-setter ${benchEntry?'':'disabled'}>${benchEntry?`Add #${esc(benchEntry)} as setter`:'Enter a number first'}</button>`:`<button type="button" class="scout-setter-toggle" data-scout-toggle-setter ${selectedPosition&&six[selectedPosition]?'':'disabled'}>${selectedSetter?'Remove setter mark':'Mark as setter'}</button>`}
    <button type="button" class="scout-bench-setter" data-scout-bench-mode>+ Add off-court setter</button>
    <div class="scout-setter-list"><span>Identified setters</span>${setterChips||'<small>None yet</small>'}<input type="hidden" data-scout-field="setters" value="${esc(setters.map(item=>item.jersey).join(','))}"></div>
   </div>
  </div>
  <div class="scout-details-grid">
   <label>Offensive system<select data-scout-field="offense">${option('','Not known',scout.offense)}${option('5-1','5–1',scout.offense)}${option('6-2','6–2',scout.offense)}${option('4-2','4–2',scout.offense)}${option('other','Other',scout.offense)}${option('unsure','Unsure',scout.offense)}</select></label>
   <label>Base defense<select data-scout-field="defense">${option('','Not known',scout.defense)}${option('perimeter','Perimeter',scout.defense)}${option('rotational','Rotational',scout.defense)}${option('middle-up','Middle-up',scout.defense)}${option('other','Other',scout.defense)}${option('unsure','Unsure',scout.defense)}</select></label>
  </div>
  <p class="scout-help scout-error" role="status" aria-live="polite" ${error?'':'hidden'}>${esc(error)}</p>
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
 let selectedPosition=null,entryMode='court',benchEntry='',error='';
 const draw=()=>{
  root.innerHTML=opponentScoutEditorMarkup(draft,selectedPosition,entryMode,benchEntry,error);
  const moment=root.querySelector('[data-scout-field="moment"]');
  moment.onchange=()=>{
   draft.moment=moment.value==='mid'?'mid':'start';selectedPosition=null;entryMode='court';benchEntry='';error='';draw();
  };
  for(const field of ['offense','defense'])root.querySelector(`[data-scout-field="${field}"]`).onchange=event=>{draft[field]=event.target.value;};
  root.querySelectorAll('[data-scout-cell]').forEach(button=>button.onclick=()=>{
   selectedPosition=button.dataset.scoutCell;entryMode='court';benchEntry='';error='';draw();
  });
  root.querySelectorAll('[data-scout-digit]').forEach(button=>button.onclick=()=>{
   if(button.disabled)return;
   const digit=button.dataset.scoutDigit;
   if(entryMode==='bench-setter'){
    if(benchEntry.length>=2)return;
    benchEntry+=digit;error='';draw();return;
   }
   if(!selectedPosition)return;
   const six=draft.six[draft.moment],priorNumber=six[selectedPosition]||'';
   const next=priorNumber.length>=2?priorNumber:priorNumber+digit;
   const canonical=String(Number(next));
   const duplicate=POSITIONS.find(position=>position!==selectedPosition&&six[position]&&String(Number(six[position]))===canonical);
   if(duplicate&&next.length===2){error=`#${canonical} is already entered at ${duplicate}.`;draw();return;}
   six[selectedPosition]=next;
   const setter=draft.setters.find(item=>item.snapshot===draft.moment&&item.jersey===priorNumber);
   if(setter&&priorNumber!==next)setter.jersey=next;
   error=duplicate?`#${canonical} is also entered at ${duplicate}. Add another digit or correct it before saving.`:'';draw();
  });
  root.querySelector('[data-scout-clear]').onclick=()=>{
   if(entryMode==='bench-setter')benchEntry='';
   else if(selectedPosition){const old=draft.six[draft.moment][selectedPosition];draft.six[draft.moment][selectedPosition]='';draft.setters=draft.setters.filter(item=>!(item.snapshot===draft.moment&&item.jersey===old));}
   error='';draw();
  };
  root.querySelector('[data-scout-backspace]').onclick=()=>{
   if(entryMode==='bench-setter')benchEntry=benchEntry.slice(0,-1);
   else if(selectedPosition){
    const six=draft.six[draft.moment],old=six[selectedPosition],next=old.slice(0,-1);six[selectedPosition]=next;
    const setter=draft.setters.find(item=>item.snapshot===draft.moment&&item.jersey===old);
    if(setter&&next)setter.jersey=next;
    else if(setter)draft.setters=draft.setters.filter(item=>item!==setter);
   }
   error='';draw();
  };
  root.querySelector('[data-scout-toggle-setter]')?.addEventListener('click',()=>{
   const number=draft.six[draft.moment][selectedPosition];
   if(!number)return;
   const found=draft.setters.some(item=>item.snapshot===draft.moment&&item.jersey===number);
   draft.setters=found?draft.setters.filter(item=>!(item.snapshot===draft.moment&&item.jersey===number)):[...draft.setters,{jersey:number,snapshot:draft.moment}];
   error='';draw();
  });
  root.querySelector('[data-scout-bench-mode]').onclick=()=>{entryMode='bench-setter';selectedPosition=null;benchEntry='';error='';draw();};
  root.querySelector('[data-scout-add-setter]')?.addEventListener('click',()=>{
   const number=String(Number(benchEntry));
   if(!benchEntry||draft.setters.some(item=>item.snapshot===draft.moment&&item.jersey===number)){error='That setter is already listed for this lineup.';draw();return;}
   draft.setters.push({jersey:number,snapshot:draft.moment});entryMode='court';selectedPosition=null;benchEntry='';error='';draw();
  });
  root.querySelectorAll('[data-scout-remove-setter]').forEach(button=>button.onclick=()=>{
   const number=button.dataset.scoutRemoveSetter;
   draft.setters=draft.setters.filter(item=>!(item.snapshot===draft.moment&&item.jersey===number));error='';draw();
  });
  root.querySelector('#scoutSave').onclick=async()=>{
   try{const value=readOpponentScoutEditor(root,draft);await onSave(value);}
   catch(issue){error=issue.message;draw();}
  };
 };
 draw();
}
