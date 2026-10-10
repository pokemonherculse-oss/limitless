// Shared realtime client. All durable writes are sent to the Excel-backed server.
// A small, ordered patch prevents one browser from overwriting another's changes.
(function () {
    'use strict';
    const copy = obj => JSON.parse(JSON.stringify(obj));
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    const identity = list => {
        if (!list.length || !list.every(isObject)) return null;
        for (const fields of [['matchId'], ['id'], ['playerId'], ['tournamentId'], ['round','phase']]) {
            if (list.every(x => fields.every(k => Object.prototype.hasOwnProperty.call(x,k)))) {
                const keys = list.map(x => fields.map(k => String(x[k])).join(':'));
                if (new Set(keys).size === keys.length) return fields;
            }
        }
        return null;
    };
    const selector = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));
    const key = (obj, keys) => keys.map(k => String(obj[k])).join(':');
    const diffs = (before, after, path = []) => {
        if (path[path.length - 1] === 'chat') return []; // temporary battle messages are never persisted
        // Check equality before the entry shortcut: otherwise each registration
        // resends every other player's unchanged entry, which the server rightly
        // rejects as an unauthorized cross-player edit.
        if (equal(before, after)) return [];
        if (path.length === 4 && path[0] === 'tournaments' && path[2] === 'entries') {
            if (after === undefined) return [{op:'delete',path,before:before===undefined?null:before}];
            return [{op:'set',path,value:after,before:before===undefined?null:before}];
        }
        if (isObject(after) && (isObject(before) || before === undefined)) {
            const result = [];
            const a = isObject(before) ? before : {};
            for (const k of new Set([...Object.keys(a), ...Object.keys(after)])) {
                result.push(...diffs(a[k], after[k], [...path,k]));
            }
            return result;
        }
        if (Array.isArray(after) && (Array.isArray(before) || before === undefined)) {
            const old = Array.isArray(before) ? before : [];
            const keys = identity(after) || identity(old);
            if (keys) {
                const former = new Map(old.map(x=>[key(x,keys),x]));
                const newer = new Map(after.map(x=>[key(x,keys),x]));
                const result = [];
                for (const [k,value] of former) {
                    if (!newer.has(k)) result.push({op:'delete',path:[...path,selector(value,keys)]});
                }
                for (const [k,value] of newer) {
                    const leafPath = [...path,selector(value,keys)];
                    if (!former.has(k)) result.push({op:'set',path:leafPath,value});
                    else result.push(...diffs(former.get(k),value,leafPath));
                }
                return result;
            }
            if ([...old,...after].every(x=>['string','number','boolean'].includes(typeof x))) {
                return [
                    ...old.filter(x => !after.includes(x)).map(value=>({op:'removeSet',path,value})),
                    ...after.filter(x => !old.includes(x)).map(value=>({op:'addSet',path,value}))
                ];
            }
            // Chat logs and other unkeyed object arrays can safely append new items.
            if (after.length >= old.length && old.every((v,i)=>equal(v,after[i]))) {
                return after.slice(old.length).map(value=>({op:'append',path,value}));
            }
            return [{op:'set',path,value:after,before:old}];
        }
        if (after === undefined) return [{op:'delete',path,before:before===undefined?null:before}];
        return [{op:'set',path,value:after,before:before===undefined?null:before}];
    };

    const message = text => {
        let el = document.getElementById('limitless-connectivity');
        if (!el) {
            el = document.createElement('div');
            el.id = 'limitless-connectivity';
            el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;max-width:90vw;padding:12px 18px;background:#7f1d1d;border:1px solid #f87171;border-radius:8px;color:#fff;font:600 13px system-ui;text-align:center';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
    };
    async function request(url, payload) {
        let res;
        try {
            res = await fetch(url, {
                method:payload===undefined?'GET':'POST', credentials:'same-origin', cache:'no-store',
                headers:payload===undefined?{}:{'Content-Type':'application/json'},
                body:payload===undefined?undefined:JSON.stringify(payload)
            });
        } catch(e) {
            throw Error('Unable to connect to the Excel database. Check the server connection.');
        }
        const data = await res.json().catch(()=>({error:'Unexpected server response'}));
        if (!res.ok) throw Error(data.error||`Server error ${res.status}`);
        return data;
    }
    class Store {
        constructor() {
            this.state = null;
            this.base = null;
            this.revision = -1;
            this.chatRevision = -1;
            this.role = null;
            this.me = null;
            this.queue = [];
            this.running = false;
            this.onChange = null;
            this.ready = null;
            this.pollTimer = null;
        }
        _accept(data) {
            this.state = data.state;
            this.base = copy(data.state);
            this.revision = data.revision;
            this.chatRevision = data.chatRevision;
            this.role = data.role;
            this.me = data.me;
            if (this.onChange) this.onChange(this.state);
            message('');
        }
        init(onChange, interval = 1800) {
            if (this.ready) return this.ready;
            this.onChange = onChange;
            this.ready = this.refresh(true).then(() => {
                this.pollTimer = setInterval(()=>this.refresh(false).catch(()=>{}),interval);
            });
            return this.ready;
        }
        async refresh(force) {
            if (this.queue.length || this.running) return;
            try {
                const data = await request('/api/state');
                if (this.queue.length || this.running || data.revision < this.revision) return data;
                if (force || data.revision !== this.revision || data.chatRevision !== this.chatRevision || data.role !== this.role || data.me?.id !== this.me?.id) {
                    // A user may start editing a form while a background read is in flight;
                    // DOM rendering in player preserves input values.
                    this._accept(data);
                } else message('');
                return data;
            } catch(e) {
                message(e.message);
                if (force) throw e;
            }
        }
        save(next) {
            if (!this.base) {message('Database is not ready. No changes saved.');return;}
            const ops = diffs(this.base, next);
            if (!ops.length) return;
            this.base = copy(next);
            this.queue.push(ops);
            this._drain();
        }
        async _drain() {
            if (this.running) return;
            this.running = true;
            let last;
            try {
                while (this.queue.length) {
                    last = await request('/api/patch',{ops:this.queue[0]});
                    this.queue.shift();
                }
                this._accept(last);
            } catch(e) {
                this.queue=[];
                message('Save failed: ' + e.message);
                alert('Your change was not saved to Excel. ' + e.message + '\nThe latest server data will be loaded.');
                try { this._accept(await request('/api/state')); } catch (_) {}
            } finally {
                this.running = false;
            }
        }
        async auth(endpoint, body) { return request(endpoint,body); }
        async chat(matchId, text) { await request('/api/chat/send',{matchId,text}); await this.refresh(true); }
    }
    window.LimitlessStore = new Store();
})();
