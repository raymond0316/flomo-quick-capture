// IndexedDB is local to this device; blobs are committed atomically with the text.
class DraftStore {
  constructor(key, factory = globalThis.indexedDB) { this.key=key;this.factory=factory;this.queue=Promise.resolve(); }
  async open() {
    if(!this.factory) throw new Error('Draft storage unavailable');
    if(!this.database) this.database=new Promise((resolve,reject)=>{
      const request=this.factory.open('obsidian-flomo-drafts',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();this.database=null;};resolve(db);};
      request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Draft storage blocked'));
    }).catch(error=>{this.database=null;throw error;});
    return this.database;
  }
  run(action) {
    const task=this.queue.catch(()=>{}).then(action);this.queue=task;return task;
  }
  async transaction(mode,action) {
    const db=await this.open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('drafts',mode);let result;
      tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Draft write failed'));
      const request=action(tx.objectStore('drafts'));
      if(request)request.onsuccess=()=>{result=request.result;};
    });
  }
  load() {return this.run(()=>this.transaction('readonly',store=>store.get(this.key)));}
  save(snapshot) {
    // Clone arrays now so later editing cannot mutate an enqueued snapshot.
    const copy={...snapshot,clips:snapshot.clips.map(item=>({...item})),images:snapshot.images.map(item=>({...item})),updatedAt:Date.now()};
    return this.run(()=>this.transaction('readwrite',store=>store.put(copy,this.key)));
  }
  clear(id) {
    return this.run(async()=>{
      const db=await this.open();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts');
        const request=store.get(this.key);
        request.onsuccess=()=>{if(!id||request.result?.id===id)store.delete(this.key);};
        tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Draft clear failed'));
      });
    });
  }
}
module.exports={DraftStore};
