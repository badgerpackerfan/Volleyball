export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc=escapeHTML;
export function mountLineupEditor(root,team,initial={},onChange=()=>{}) {
  const options=(list,blank)=>`<option value="">${blank}</option>`+list.map(p=>`<option value="${esc(p.id)}">#${esc(p.jersey)} ${esc(p.name)}</option>`).join('');
  root.innerHTML=`<label>Offensive system<select id="system"><option>6-2</option><option>5-1</option><option>4-2</option></select></label>
    <fieldset><legend>Lineup in R1</legend><p class="help">Assign six different players in your base R1 order. The net is at the top. Your starting rotation is chosen separately for each set.</p>
    <p class="muted">Tap a player circle to choose a player.</p>
    <div class="lineup-court"><span class="lineup-net" aria-hidden="true">NET</span><span class="lineup-attack-line" aria-hidden="true"></span>${[4,3,2,5,6,1].map((n,i)=>`<label class="lineup-player ${n===1||n===5||n===6?'back':''}" style="--column:${i%3};--row:${Math.floor(i/3)}"><span class="lineup-position">P${n}</span><span class="lineup-disc"><span class="lineup-number" aria-hidden="true">+</span><span class="lineup-chevron" aria-hidden="true">⌄</span><select required data-slot="${n}" aria-label="Position ${n} player">${options(team.players,'Choose player')}</select></span><span class="lineup-name" aria-hidden="true">Choose player</span></label>`).join('')}</div></fieldset>
    <fieldset><legend>Setters and liberos</legend><div class="grid"><label>Setter 1<select id="setter1" required></select></label><label id="secondSetterLabel">Setter 2<select id="setter2" required></select></label><label>Libero 1<select id="libero1"></select></label><label>Libero 2<select id="libero2"></select></label></div><p class="muted">Setters must be opposite each other. In a 6–2, Setter 2 can be a bench player who replaces the opposite slot when it is in the back row. A setter cannot also be a libero. Designated liberos start off court.</p></fieldset>`;
  const q=id=>root.querySelector('#'+id);
  const starters=()=>[1,2,3,4,5,6].map(n=>root.querySelector(`[data-slot="${n}"]`).value);
  function paintCourt(){
    const setters=[q('setter1').value,...(q('system').value==='5-1'?[]:[q('setter2').value])];
    for(const select of root.querySelectorAll('[data-slot]')){
      const player=team.players.find(p=>p.id===select.value),label=select.closest('.lineup-player');
      label.querySelector('.lineup-number').textContent=player?player.jersey:'+';
      label.querySelector('.lineup-name').textContent=player?player.name:'Choose player';
      label.classList.toggle('empty',!player);
      label.style.setProperty('--player-color',player&&setters.includes(player.id)?'#b3251f':player?.position==='MB'?'#16713c':'#1d4ed8');
    }
  }
  function refresh(){
    const selected=starters(),on=team.players.filter(p=>selected.includes(p.id)),bench=team.players.filter(p=>!selected.includes(p.id));
    const values=Object.fromEntries(['setter1','setter2','libero1','libero2'].map(id=>[id,q(id).value]));
    const refill=(id,list,blank)=>{
      q(id).innerHTML=options(list,blank);
      q(id).value=list.some(player=>player.id===values[id])?values[id]:'';
      values[id]=q(id).value;
    };
    refill('setter1',on,'Choose setter');
    const firstIndex=selected.indexOf(q('setter1').value);
    const opposite=firstIndex<0?null:team.players.find(player=>player.id===selected[(firstIndex+3)%6]);
    const setter2Options=[...(opposite?[opposite]:[]),...(q('system').value==='6-2'?bench:[])]
      .filter((player,index,list)=>player.id!==q('setter1').value
        &&list.findIndex(other=>other.id===player.id)===index);
    refill('setter2',setter2Options,'Choose setter');
    const setters=[q('setter1').value,q('setter2').value];
    const liberoOptions=bench.filter(player=>!setters.includes(player.id));
    refill('libero1',liberoOptions,'None');
    refill('libero2',liberoOptions.filter(player=>player.id!==q('libero1').value),'None');
    const one=q('system').value==='5-1';q('secondSetterLabel').hidden=one;q('setter2').required=!one;q('setter2').disabled=one;
  }
  function write(value={}){
    q('system').value=value.system||'6-2';
    for(let pos=1;pos<=6;pos++)root.querySelector(`[data-slot="${pos}"]`).value=value.starters?.[pos-1]||'';
    refresh();
    q('setter1').value=value.setters?.[0]||'';refresh();
    q('setter2').value=value.setters?.[1]||'';
    q('libero1').value=value.liberos?.[0]||'';refresh();
    q('libero2').value=value.liberos?.[1]||'';refresh();
    paintCourt();
  }
  function read(){return {system:q('system').value,starters:starters(),setters:[q('setter1').value,...(q('system').value==='5-1'?[]:[q('setter2').value])],liberos:[q('libero1').value,q('libero2').value].filter(Boolean)};}
  root.addEventListener('change',e=>{if(e.target.matches('[data-slot],#system,#setter1,#setter2,#libero1,#libero2'))refresh();paintCourt();onChange(read());});
  write(initial);
  return {read,write};
}
