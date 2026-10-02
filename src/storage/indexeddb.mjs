import { validateSetAddition, orderMatchSets } from '../teams/match-model.mjs';
import { validateTeam } from '../teams/team-model.mjs';
import { replaySet } from '../engine/set-engine.mjs';
import { validatePractice } from '../practice/practice-model.mjs';

export class StorageConflict extends Error {
  constructor() {
    super('This set changed in another window. Reload the saved set before continuing.');
    this.name = 'StorageConflict';
  }
}

// v1: sets; v2: active-set pointer; v3: editable teams/rosters; v4: practice sessions.
export function openSetStore({ indexedDB = globalThis.indexedDB, name = 'volleyball-sets' } = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('This browser does not provide local match storage.'));
    const request = indexedDB.open(name, 4);
    let abandoned = false;
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('Close other volleyball windows, then retry opening storage.'));
    };
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = event => {
      if(abandoned){request.transaction.abort();return;}
      const db = request.result;
      if (!db.objectStoreNames.contains('teams')) db.createObjectStore('teams', {keyPath:'id'});
      if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'config.id' });
      if (!db.objectStoreNames.contains('practices')) db.createObjectStore('practices', {keyPath:'id'});
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (event.oldVersion === 1) {
        const cursor = request.transaction.objectStore('sets').openCursor();
        cursor.onsuccess = () => {
          if (cursor.result) request.transaction.objectStore('meta').put(cursor.result.value.config.id, 'activeSet');
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => db.close();
      // Keep every request inside the transaction's active task; resolve on commit only.
      const transaction=(names,mode,work)=>new Promise((done,fail)=>{
        const tx=db.transaction(names,mode,{durability:'strict'});let result,failure;
        const guard=fn=>{try{fn();}catch(e){failure=e;tx.abort();}};
        tx.oncomplete=()=>done(result);tx.onabort=()=>fail(failure??tx.error??new Error('Storage operation was interrupted.'));tx.onerror=()=>{};
        guard(()=>work(tx,value=>{result=value;},guard));
      });
      const checkActive=(tx,expected,guard,next)=>{
        const r=tx.objectStore('meta').get('activeSet');
        r.onsuccess=()=>guard(()=>{
          if((r.result??null)!==(expected?.id??null))throw new StorageConflict();
          if(!r.result){next();return;}
          const old=tx.objectStore('sets').get(r.result);
          old.onsuccess=()=>guard(()=>{if(!old.result||old.result.actions.length!==expected.revision)throw new StorageConflict();next();});
        });
      };
      resolve({
        listTeams:()=>transaction(['teams'],'readonly',(tx,done,guard)=>{
          const r=tx.objectStore('teams').getAll();r.onsuccess=()=>guard(()=>done(r.result.map(validateTeam)));
        }),
        listPractices:()=>transaction(['practices'],'readonly',(tx,done,guard)=>{
          const r=tx.objectStore('practices').getAll();r.onsuccess=()=>guard(()=>done(r.result.map(validatePractice)));
        }),
        getPractice:id=>transaction(['practices'],'readonly',(tx,done,guard)=>{
          const r=tx.objectStore('practices').get(id);r.onsuccess=()=>guard(()=>{
            if(!r.result)throw new Error('This practice no longer exists.');
            done(validatePractice(r.result));
          });
        }),
        createPractice:input=>{
          const practice=validatePractice(input);
          return transaction(['practices'],'readwrite',(tx,done,guard)=>{
            const table=tx.objectStore('practices'),r=table.get(practice.id);
            r.onsuccess=()=>guard(()=>{
              if(r.result)throw new Error('This practice already exists.');
              table.add(practice);done(practice);
            });
          });
        },
        savePractice:(input,expectedRevision)=>{
          const next=validatePractice(input);
          return transaction(['practices'],'readwrite',(tx,done,guard)=>{
            const table=tx.objectStore('practices'),r=table.get(next.id);
            r.onsuccess=()=>guard(()=>{
              const prior=r.result;
              if(!prior||prior.revision!==expectedRevision||next.revision!==expectedRevision+1)
                throw new Error('This practice changed in another window. Reload it before continuing.');
              if(next.teamId!==prior.teamId||next.teamName!==prior.teamName||next.date!==prior.date
                ||JSON.stringify(next.players)!==JSON.stringify(prior.players))
                throw new Error('Practice details and its saved roster cannot be changed while recording.');
              const appended=next.events.length===prior.events.length+1
                &&JSON.stringify(next.events.slice(0,-1))===JSON.stringify(prior.events);
              let undone=false;
              if(prior.events.length===next.events.length+1){
                for(let i=prior.events.length-1;i>=0&&!undone;i--){
                  const removed=prior.events[i];
                  let laterForPlayer=false;
                  for(let j=i+1;j<prior.events.length;j++)if(prior.events[j].playerId===removed.playerId){laterForPlayer=true;break;}
                  if(laterForPlayer&&i!==prior.events.length-1)continue;
                  const without=[...prior.events.slice(0,i),...prior.events.slice(i+1)];
                  undone=JSON.stringify(without)===JSON.stringify(next.events);
                }
              }
              if(!appended&&!undone)throw new Error('A practice save must record one result or undo the latest result.');
              table.put(next);done(next);
            });
          });
        },
        saveTeam:(input,expectedRevision=null)=>{
          const team=validateTeam(input);
          return transaction(['teams'],'readwrite',(tx,done,guard)=>{
            const table=tx.objectStore('teams'),r=table.get(team.id);
            r.onsuccess=()=>guard(()=>{
              if((r.result?.revision??null)!==expectedRevision||team.revision!==(expectedRevision??0)+1)
                throw new Error('This roster changed in another window. Reload Teams before saving again.');
              table.put(team);done(team);
            });
          });
        },
        listSets:()=>transaction(['sets'],'readonly',(tx,done,guard)=>{
          const r=tx.objectStore('sets').getAll();r.onsuccess=()=>guard(()=>{r.result.forEach(replaySet);done(r.result);});
        }),
        startSet:(input,expectedActive)=>{
          const record=structuredClone(input);replaySet(record);
          if(record.actions.length)throw new Error('A new set must start with an empty history.');
          return transaction(['sets','meta','teams'],'readwrite',(tx,done,guard)=>{
            checkActive(tx,expectedActive,guard,()=>{
              const teams=tx.objectStore('teams'),r=teams.get(record.config.teamId);
              r.onsuccess=()=>guard(()=>{
                if(!r.result||r.result.revision!==record.config.teamRevision)throw new Error('The roster changed. Reload Teams and choose the lineup again.');
                const records=tx.objectStore('sets').getAll();
                records.onsuccess=()=>guard(()=>{
                  if(records.result.some(r=>r.config.id===record.config.id))throw new Error('This set already exists.');
                  validateSetAddition(record,records.result);
                  tx.objectStore('sets').add(record);tx.objectStore('meta').put(record.config.id,'activeSet');
                });
              });
            });
          });
        },
        activateSet:(id,expectedActive)=>transaction(['sets','meta'],'readwrite',(tx,done,guard)=>{
          checkActive(tx,expectedActive,guard,()=>{
            const r=tx.objectStore('sets').get(id);r.onsuccess=()=>guard(()=>{
              if(!r.result)throw new Error('This set no longer exists.');replaySet(r.result);tx.objectStore('meta').put(id,'activeSet');
            });
          });
        }),
        updateSetRecord:(original,input)=>{
          const next=structuredClone(input);replaySet(next);
          return transaction(['sets'],'readwrite',(tx,done,guard)=>{
            const table=tx.objectStore('sets'),r=table.get(original.config.id);
            r.onsuccess=()=>guard(()=>{
              if(!r.result)throw new Error('This set no longer exists.');
              if(JSON.stringify(r.result)!==JSON.stringify(original))throw new StorageConflict();
              if(next.config.id!==original.config.id||next.config.teamId!==original.config.teamId
                ||next.config.matchId!==original.config.matchId||next.config.setNumber!==original.config.setNumber)
                throw new Error('A correction cannot move a set to another match.');
              table.put(next);done(next);
            });
          });
        },
        updateMatchDetails:({teamId,matchId,teamRevision,expectedSetIds,opponent,date})=>
          transaction(['teams','sets'],'readwrite',(tx,done,guard)=>{
            const teamTable=tx.objectStore('teams'),setTable=tx.objectStore('sets');
            const teamRequest=teamTable.get(teamId),setsRequest=setTable.getAll();
            let savedTeam,savedSets,teamReady=false,setsReady=false;
            const apply=()=>guard(()=>{
              if(!teamReady||!setsReady)return;
              if(!savedTeam||savedTeam.revision!==teamRevision)throw new Error('The roster changed. Reload Teams before editing this match.');
              const siblings=orderMatchSets(savedSets.filter(record=>record.config.teamId===teamId&&record.config.matchId===matchId));
              if(expectedSetIds&&JSON.stringify(siblings.map(record=>record.config.id))!==JSON.stringify(expectedSetIds))
                throw new StorageConflict();
              const planned=(savedTeam.plannedMatches??[]).find(match=>match.id===matchId);
              if(!siblings.length&&!planned)throw new Error('This match no longer exists.');
              for(const record of siblings){
                record.config.opponentName=opponent;record.config.matchDate=date;
                replaySet(record);setTable.put(record);
              }
              if(planned){
                const updated=validateTeam({...savedTeam,revision:savedTeam.revision+1,
                  plannedMatches:savedTeam.plannedMatches.map(match=>match.id===matchId?{...match,opponent,date}:match)});
                teamTable.put(updated);
              }
              done({sets:siblings.length,planned:Boolean(planned)});
            });
            teamRequest.onsuccess=()=>{savedTeam=teamRequest.result;teamReady=true;apply();};
            setsRequest.onsuccess=()=>{savedSets=setsRequest.result;setsReady=true;apply();};
          }),
        // Delete a team (with its roster, lineups, matches and sets), one match, or
        // the latest set of a match. Clears the live pointer if it pointed at a deleted set.
        deleteData:({teamId,matchId=null,setId=null,teamRevision=null,practiceId=null,practiceRevision=null})=>transaction(['teams','sets','meta','practices'],'readwrite',(tx,done,guard)=>{
          const teams=tx.objectStore('teams'),table=tx.objectStore('sets'),meta=tx.objectStore('meta');
          const team=teams.get(teamId),all=table.getAll(),practiceRecords=tx.objectStore('practices').getAll(),activeId=meta.get('activeSet');
          activeId.onsuccess=()=>guard(()=>{
            const records=all.result.filter(r=>r.config.teamId===teamId);let doomed;
            if(practiceId){
              const practiceTable=tx.objectStore('practices'),target=practiceRecords.result.find(p=>p.id===practiceId);
              if(!target)throw new Error('This practice no longer exists.');
              if(target.revision!==practiceRevision)throw new Error('This practice changed in another window. Reload it before deleting.');
              practiceTable.delete(practiceId);done(1);return;
            }else if(setId){
              const target=records.find(r=>r.config.id===setId);
              if(!target)throw new Error('This set no longer exists.');
              if(orderMatchSets(records.filter(r=>r.config.matchId===target.config.matchId)).at(-1)!==target)
                throw new Error('Delete the later sets in this match first.');
              doomed=[target];
            }else if(matchId){
              doomed=records.filter(r=>r.config.matchId===matchId);
              const planned=team.result?.plannedMatches?.some(m=>m.id===matchId);
              if(!doomed.length&&!planned)throw new Error('This match no longer exists.');
              if(planned)teams.put({...team.result,revision:team.result.revision+1,plannedMatches:team.result.plannedMatches.filter(m=>m.id!==matchId)});
            }else{
              if(team.result){
                if(team.result.revision!==teamRevision)throw new Error('This team changed in another window. Reload Teams before deleting it.');
                teams.delete(teamId);
              }else if(!records.length)throw new Error('This team no longer exists.');
              doomed=records;
              for(const practice of practiceRecords.result.filter(p=>p.teamId===teamId))tx.objectStore('practices').delete(practice.id);
            }
            for(const r of doomed)table.delete(r.config.id);
            if(doomed.some(r=>r.config.id===activeId.result))meta.delete('activeSet');
            done(doomed.length);
          });
        }),
        close: () => db.close(),
        loadActive: () => new Promise((done, fail) => {
          const tx = db.transaction(['sets', 'meta'], 'readonly');
          let record = null, failure;
          const active = tx.objectStore('meta').get('activeSet');
          active.onsuccess = () => {
            if (active.result === undefined) return;
            const get = tx.objectStore('sets').get(active.result);
            get.onsuccess = () => {
              try {
                if (!get.result) throw new Error('The active set is missing. Saved data was not replaced.');
                replaySet(get.result); record = get.result;
              } catch (e) { failure = e; tx.abort(); }
            };
          };
          tx.oncomplete = () => done(record);
          tx.onabort = () => fail(failure ?? tx.error ?? new Error('Reading the saved set was interrupted.'));
          tx.onerror = () => {}; // Abort is the authoritative result.
        }),
        save: (record, expectedRevision) => {
          // Snapshot before opening the transaction so caller mutation cannot change it.
          const next = structuredClone(record);
          replaySet(next);
          return new Promise((done, fail) => {
            const tx = db.transaction(['sets', 'meta'], 'readwrite', { durability: 'strict' });
            let failure;
            const sets = tx.objectStore('sets'), meta = tx.objectStore('meta');
            const get = sets.get(next.config.id), active = meta.get('activeSet');
            active.onsuccess = () => {
              try {
                const prior = get.result;
                if (expectedRevision === null ? (prior !== undefined || active.result !== undefined)
                  : (!prior || prior.actions.length !== expectedRevision || active.result !== next.config.id))
                  throw new StorageConflict();
                if (prior) {
                  replaySet(prior);
                  if (JSON.stringify(prior.config) !== JSON.stringify(next.config)
                    || next.actions.length !== expectedRevision + 1
                    || JSON.stringify(prior.actions) !== JSON.stringify(next.actions.slice(0, expectedRevision)))
                    throw new Error('Saving must append exactly one action to the saved history.');
                }
                sets.put(next);
                meta.put(next.config.id, 'activeSet');
              } catch (e) { failure = e; tx.abort(); }
            };
            tx.oncomplete = () => done();
            tx.onabort = () => fail(failure ?? tx.error ?? new Error('Saving was interrupted. The action was not recorded.'));
            tx.onerror = () => {};
          });
        },
      });
    };
  });
}
