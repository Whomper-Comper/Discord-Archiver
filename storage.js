const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const completed = transaction => {
  const promise = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('Archive storage transaction aborted'));
    transaction.onerror = () => {};
  });
  // Requests may fail before callers reach the transaction completion await.
  promise.catch(() => {});
  return promise;
};
export const userKey = author => author?.id != null ? `id:${author.id}` : `name:${author?.display_name ?? author?.username ?? 'Unknown'}`;

export class ArchiveStorage {
  static async open({indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange, name = 'discord-archive-cache'} = {}) {
    if (!indexedDB || !IDBKeyRange) throw new Error('IndexedDB disk storage is unavailable. Open the extension workspace in a supported browser.');
    const opening = indexedDB.open(name, 2);
    opening.onupgradeneeded = event => {
      const db = opening.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('jobs', {keyPath:'id'});
        const messages = db.createObjectStore('messages', {keyPath:['jobId','order']});
        messages.createIndex('identity', ['jobId','identity'], {unique:true});
        db.createObjectStore('users', {keyPath:['jobId','key']});
      }
      const messages = opening.transaction.objectStore('messages');
      messages.createIndex('authorOrder', ['jobId','authorKey','order']);
      // Upgrade atomically: old cache stays v1 if any write fails. Read/update one
      // record at a time so migration never collects the archive in JS memory.
      const cursor = messages.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result; if (!current) return;
        const row = current.value; row.authorKey = userKey(row.message.author);
        current.update(row).onsuccess = () => current.continue();
      };
    };
    const db = await request(opening);
    db.onversionchange = () => db.close();
    return new ArchiveStorage(db, IDBKeyRange);
  }
  constructor(db, ranges) { this.db = db; this.ranges = ranges; }
  close() { this.db.close(); }
  range(id, after) { return this.ranges.bound([id,after ?? -Infinity],[id,Infinity],after != null,false); }
  async get(id) { return request(this.db.transaction('jobs').objectStore('jobs').get(id)); }
  async list() { return request(this.db.transaction('jobs').objectStore('jobs').getAll()); }
  async create({channel = {}, settings = {}, kind = 'capture', name} = {}) {
    const time = new Date().toISOString();
    const job = {id:crypto.randomUUID(),name:name || channel.name || 'Archive',channel:{id:channel.id ?? null,name:channel.name || 'Archive'},kind,status:kind === 'import' ? 'importing' : 'collecting',count:0,bytes:0,scanned:0,cursor:null,settings,createdAt:time,updatedAt:time};
    const tx = this.db.transaction('jobs','readwrite'); const done = completed(tx);
    tx.objectStore('jobs').add(job); await done; return job;
  }
  async update(id, changes) {
    const tx = this.db.transaction('jobs','readwrite'); const done = completed(tx);
    try {
      const jobs = tx.objectStore('jobs'); const job = await request(jobs.get(id));
      if (!job) throw new Error('Archive job was not found');
      Object.assign(job, changes, {id,updatedAt:new Date().toISOString()});
      jobs.put(job); await done; return job;
    } catch (error) { try {tx.abort();} catch {} await done.catch(()=>{}); throw error; }
  }
  async append(id, records, checkpoint = {}) {
    const tx = this.db.transaction(['jobs','messages','users'],'readwrite'); const done = completed(tx);
    try {
      const jobs = tx.objectStore('jobs'), messages = tx.objectStore('messages'), users = tx.objectStore('users');
      const job = await request(jobs.get(id)); if (!job) throw new Error('Archive job was not found');
      const encoder = new TextEncoder();
      const seen = new Set(), accepted = [];
      // Queue independent ID lookups together. The only in-memory identity set is this batch.
      const identities = records.map(message => {
        const channelId = message.channel_id ?? job.channel.id;
        return message.id != null && channelId != null ? JSON.stringify([String(channelId),String(message.id)]) : undefined;
      });
      const existing = await Promise.all(identities.map(identity => identity ? request(messages.index('identity').getKey([id,identity])) : undefined));
      const counts = new Map();
      for (let i=0;i<records.length;i++) {
        const message=records[i],identity=identities[i];
        if(identity&&(existing[i]||seen.has(identity)))continue;
        if(identity)seen.add(identity);
        accepted.push({message,identity});
        const key=userKey(message.author);
        const entry=counts.get(key)||{key,author:message.author,count:0};entry.count++;counts.set(key,entry);
      }
      const existingUsers = await Promise.all([...counts.keys()].map(key=>request(users.get([id,key]))));
      for (const {message,identity} of accepted) {
        const sequence = job.count + 1;
        const row = {jobId:id,order:job.kind === 'capture' ? -sequence : sequence,authorKey:userKey(message.author),message};
        if (identity) row.identity = identity;
        messages.add(row);
        job.count++;
        if (job.kind !== 'import') job.bytes += encoder.encode(JSON.stringify(message)).byteLength;
      }
      let userIndex=0;
      for(const {key,author,count} of counts.values()){
        const user=existingUsers[userIndex++]||{jobId:id,key,id:author?.id ?? null,display_name:author?.display_name || author?.username || 'Unknown',username:author?.username || '',count:0};
        user.count+=count;users.put(user);
      }
      // Only progress fields can mutate collection metadata, preserving original settings.
      for (const key of ['cursor','status','scanned','bytes']) if (Object.hasOwn(checkpoint,key)) job[key] = checkpoint[key];
      job.updatedAt = new Date().toISOString(); jobs.put(job); await done; return job;
    } catch (error) { try {tx.abort();} catch {} await done.catch(()=>{}); throw error; }
  }
  async readPage(id, {after = null, limit = 100, userKey = null} = {}) {
    limit = Math.max(1,Math.min(100,Math.floor(Number(limit)||100)));
    const tx = this.db.transaction('messages'); const store = tx.objectStore('messages');
    const source = userKey == null ? store : store.index('authorOrder');
    const range = userKey == null ? this.range(id,after)
      : this.ranges.bound([id,userKey,after ?? -Infinity],[id,userKey,Infinity],after != null,false);
    const messages = []; let next = null;
    await new Promise((resolve,reject) => {
      const cursor = source.openCursor(range);
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) { next = null; resolve(); return; }
        if (messages.length === limit) { resolve(); return; }
        messages.push(current.value.message); next = current.value.order; current.continue();
      };
    });
    return {messages,next};
  }
  async updateInfo(id, channelId, {check = () => {}} = {}) {
    const job = await this.get(id); if (!job) throw new Error('Archive job was not found');
    if (channelId == null || String(channelId) === '') throw new Error('Choose the Discord channel to update');
    channelId = String(channelId);
    let newestId = null, newestNumber = '', identifiedCount = 0, hasNonNumericIds = false;
    // The identity index contains [jobId, JSON.stringify([channelId,messageId])].
    // A key cursor never materializes message bodies and keeps only the maximum.
    await new Promise((resolve,reject) => {
      const cursor = this.db.transaction('messages').objectStore('messages').index('identity')
        .openKeyCursor(this.ranges.bound([id,''],[id,'\uffff']));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        try {
          check();const current = cursor.result; if (!current) {resolve();return;}
          identifiedCount++;
          const [channel,messageId] = JSON.parse(current.key[1]);
          if (channel === channelId) {
            if (/^\d+$/.test(messageId)) {
              const numeric = messageId.replace(/^0+/,'') || '0';
              if (newestId === null || numeric.length > newestNumber.length || (numeric.length === newestNumber.length && numeric > newestNumber)) {
                newestId = messageId; newestNumber = numeric;
              }
            } else hasNonNumericIds = true;
          }
          current.continue();
        } catch(error) {reject(error);}
      };
    });
    return {job,channelId,newestId,hasMissingIds:identifiedCount < job.count,hasNonNumericIds};
  }
  async summary(id, search = '') {
    const job = await this.get(id); if (!job) throw new Error('Archive job was not found');
    const users = []; let truncatedUsers = false; search = search.toLocaleLowerCase();
    await new Promise((resolve,reject) => {
      const cursor = this.db.transaction('users').objectStore('users').openCursor(this.ranges.bound([id,''],[id,'\uffff']));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const current = cursor.result; if (!current) {resolve();return;}
        const {jobId,...user} = current.value;
        if (!search || `${user.key} ${user.display_name} ${user.username}`.toLocaleLowerCase().includes(search)) {
          if (users.length === 200) {truncatedUsers=true;resolve();return;}
          users.push(user);
        }
        current.continue();
      };
    });
    return {job,users,truncatedUsers};
  }
  async delete(id) {
    const tx = this.db.transaction(['jobs','messages','users'],'readwrite'); const done = completed(tx);
    tx.objectStore('jobs').delete(id);
    for (const name of ['messages','users']) {
      const store = tx.objectStore(name);
      const range = name === 'messages' ? this.range(id) : this.ranges.bound([id,''],[id,'\uffff']);
      const cursor = store.openCursor(range);
      cursor.onsuccess = () => {const row=cursor.result;if(row){row.delete();row.continue();}};
    }
    await done; return {deleted:true};
  }
}
