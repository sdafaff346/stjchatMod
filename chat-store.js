// =========================
// ChatsPlus shared chat index
// =========================
// One place that knows about every chat file. All tabs and popups read from here
// instead of scanning the server on their own.
//
// Speed-ups compared to the original extension:
//  - Uses ST's /api/chats/recent endpoint: ONE request returns the newest N chats
//    (server only reads N chat files instead of every file).
//  - Falls back to one request per character (not two) with a concurrency limit
//    on older SillyTavern builds that lack /api/chats/recent.
//  - Results are shared between tabs and kept in memory.
//  - The last result is saved in IndexedDB (localforage) so the list can be shown
//    instantly after a page reload, then refreshed quietly in the background.

import { groups } from '../../../group-chats.js';
import { timestampToMoment } from '../../../utils.js';

const PERSIST_KEY = 'chatsPlus_chatIndex_v1';
const PERSIST_MES_LIMIT = 300; // characters of last message kept in the persisted copy
const LEGACY_CONCURRENCY = 6;

/**
 * @typedef {Object} RawChat
 * @property {'char'|'group'} kind
 * @property {string} [avatar]   Character avatar file (stable id for characters)
 * @property {string} [groupId]  Group id for group chats
 * @property {string} file_name  File name without .jsonl
 * @property {string} mes        Last message preview
 * @property {number|string} last_mes Last message timestamp
 * @property {number} chat_items
 * @property {string} file_size
 */

/** @type {{ items: RawChat[], max: number, complete: boolean, fetchedAt: number } | null} */
let mem = null;
let stale = true;
/** @type {boolean|null} null = not probed yet */
let recentEndpointSupported = null;
/** @type {{ max: number, promise: Promise<any> } | null} */
let inflight = null;
let staleToken = 0; // changes on every markStale(), so an in-flight load can tell if it is outdated
let generation = 0; // bumps whenever the data changes, lets callers skip identical re-renders
/** @type {() => Array<{characterId: string, file_name: string}>} */
let pinnedProvider = () => [];
const staleListeners = new Set();

function ctx() {
    return SillyTavern.getContext();
}

function getLocalforage() {
    return (SillyTavern.libs && SillyTavern.libs.localforage) || window.localforage || null;
}

function stripExt(name) {
    return String(name ?? '').replace(/\.jsonl$/i, '');
}

/** Run async jobs with a fixed number of workers. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = await fn(items[i], i);
            } catch (e) {
                results[i] = undefined;
            }
        }
    });
    await Promise.all(workers);
    return results;
}

// ---------- normalisation ----------

function buildAvatarIndex() {
    const map = new Map();
    const characters = ctx().characters || [];
    for (const [id, char] of Object.entries(characters)) {
        if (char && char.avatar) map.set(char.avatar, id);
    }
    return map;
}

/**
 * Convert raw (stable, avatar-keyed) entries to the shape the UI code expects.
 * Character ids are resolved at read time so a cached list survives index shifts.
 */
function normalize(items) {
    const characters = ctx().characters || [];
    const avatarIndex = buildAvatarIndex();
    const groupMap = new Map((groups || []).map(g => [g.id, g]));
    const out = [];
    for (const raw of items) {
        let base;
        if (raw.kind === 'group') {
            const group = groupMap.get(raw.groupId);
            if (!group) continue;
            base = {
                character: group.name || `Group ${group.id}`,
                avatar: group.avatar || '',
                characterId: group.id,
                isGroup: true,
                groupMembers: group.members || [],
            };
        } else {
            const id = avatarIndex.get(raw.avatar);
            if (id === undefined) continue;
            const char = characters[id];
            base = {
                character: char.name || id,
                avatar: char.avatar,
                characterId: id,
                isGroup: false,
            };
        }
        let lastMesDate = null;
        if (raw.last_mes) {
            const m = timestampToMoment(raw.last_mes);
            if (m && m.isValid()) lastMesDate = m.toDate();
        }
        out.push({
            ...base,
            file_name: raw.file_name,
            stat: {
                file_name: raw.file_name + '.jsonl',
                mes: raw.mes,
                last_mes: raw.last_mes,
                chat_items: raw.chat_items,
                file_size: raw.file_size,
            },
            last_mes: lastMesDate,
        });
    }
    out.sort((a, b) => (b.last_mes || 0) - (a.last_mes || 0));
    return out;
}

// ---------- fetching ----------

function buildPinnedPayload() {
    const characters = ctx().characters || [];
    const payload = [];
    for (const p of pinnedProvider() || []) {
        const char = characters[p.characterId];
        if (char && char.avatar) {
            payload.push({ file_name: p.file_name + '.jsonl', avatar: char.avatar });
        } else {
            payload.push({ file_name: p.file_name + '.jsonl', group: p.characterId });
        }
    }
    return payload;
}

/** Single request via /api/chats/recent. Returns null if the endpoint does not exist. */
async function fetchViaRecent(max) {
    const pinned = buildPinnedPayload();
    const body = { pinned };
    if (Number.isFinite(max)) body.max = max;
    const res = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) throw new Error(`ChatsPlus: /api/chats/recent failed (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('ChatsPlus: unexpected /api/chats/recent response');

    /** @type {RawChat[]} */
    const items = [];
    for (const row of data) {
        if (!row || !row.file_name) continue;
        const common = {
            file_name: stripExt(row.file_name),
            mes: row.mes,
            last_mes: row.last_mes,
            chat_items: row.chat_items,
            file_size: row.file_size,
        };
        if (row.group) items.push({ kind: 'group', groupId: row.group, ...common });
        else if (row.avatar) items.push({ kind: 'char', avatar: row.avatar, ...common });
        // chats without an owner (root of /chats) are ignored, like before
    }
    const complete = !Number.isFinite(max) || data.length < max + pinned.length;
    return { items, complete };
}

/** Older SillyTavern: one request per character, limited concurrency. */
async function fetchLegacy() {
    const characters = Object.values(ctx().characters || []);
    const headers = ctx().getRequestHeaders();

    const charLists = await mapLimit(characters, LEGACY_CONCURRENCY, async (char) => {
        if (!char || !char.avatar) return [];
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: char.avatar }),
        });
        if (!res.ok) return [];
        const data = await res.json();
        if (!data || data.error) return [];
        return Object.values(data).filter(x => x && x.file_name).map(x => ({
            kind: 'char',
            avatar: char.avatar,
            file_name: stripExt(x.file_name),
            mes: x.mes,
            last_mes: x.last_mes,
            chat_items: x.chat_items,
            file_size: x.file_size,
        }));
    });

    const groupJobs = [];
    for (const group of groups || []) {
        for (const chatId of group.chats || []) groupJobs.push({ group, chatId });
    }
    const groupItems = await mapLimit(groupJobs, LEGACY_CONCURRENCY, async ({ group, chatId }) => {
        const res = await fetch('/api/chats/group/info', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: chatId }),
        });
        if (!res.ok) return null;
        const x = await res.json();
        if (!x || !x.file_name) return null;
        return {
            kind: 'group',
            groupId: group.id,
            file_name: stripExt(x.file_name),
            mes: x.mes,
            last_mes: x.last_mes,
            chat_items: x.chat_items,
            file_size: x.file_size,
        };
    });

    return { items: [...charLists.flat().filter(Boolean), ...groupItems.filter(Boolean)], complete: true };
}

async function fetchIndex(max) {
    if (recentEndpointSupported !== false) {
        try {
            const result = await fetchViaRecent(max);
            if (result) {
                recentEndpointSupported = true;
                return result;
            }
            recentEndpointSupported = false;
            console.info('ChatsPlus: /api/chats/recent not available, using per-character loading');
        } catch (e) {
            // Network or server error: try the legacy path once
            console.warn(e);
        }
    }
    return await fetchLegacy();
}

function sameItems(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (x.file_name !== y.file_name || x.last_mes !== y.last_mes || x.avatar !== y.avatar
            || x.groupId !== y.groupId || x.mes !== y.mes) return false;
    }
    return true;
}

// ---------- persistence ----------

async function persist() {
    const lf = getLocalforage();
    if (!lf || !mem) return;
    try {
        await lf.setItem(PERSIST_KEY, {
            items: mem.items.map(i => ({ ...i, mes: typeof i.mes === 'string' ? i.mes.slice(0, PERSIST_MES_LIMIT) : i.mes })),
            max: Number.isFinite(mem.max) ? mem.max : -1,
            complete: mem.complete,
            savedAt: Date.now(),
        });
    } catch (e) {
        console.warn('ChatsPlus: failed to persist chat index', e);
    }
}

async function restore() {
    const lf = getLocalforage();
    if (!lf || mem) return;
    try {
        const saved = await lf.getItem(PERSIST_KEY);
        if (saved && Array.isArray(saved.items) && !mem) {
            mem = {
                items: saved.items,
                max: saved.max === -1 ? Infinity : saved.max,
                complete: !!saved.complete,
                fetchedAt: saved.savedAt || 0,
            };
            stale = true; // always revalidate a restored copy
            generation++;
        }
    } catch (e) {
        console.warn('ChatsPlus: failed to restore chat index', e);
    }
}

// ---------- public API ----------

export function setPinnedProvider(fn) {
    pinnedProvider = typeof fn === 'function' ? fn : () => [];
}

/** Current generation number; changes whenever the index content changes. */
export function getGeneration() {
    return generation;
}

export function isStale() {
    return stale;
}

function covers(max) {
    return !!mem && (mem.complete || mem.max >= max);
}

/** Synchronous peek at whatever is cached (may be stale). */
export function peekChats(max = Infinity) {
    if (!mem || !covers(max)) return null;
    return { chats: normalize(mem.items), complete: mem.complete, stale };
}

/**
 * Get chats, loading from the server only when needed.
 * @param {Object} [opts]
 * @param {number} [opts.max=Infinity] How many of the most recent chats are needed.
 * @param {boolean} [opts.force=false] Ignore the cache.
 * @param {boolean} [opts.allowStale=false] Return a stale cache immediately (caller refreshes later).
 * @returns {Promise<{chats: Array, complete: boolean, stale: boolean}>}
 */
export async function loadChats({ max = Infinity, force = false, allowStale = false } = {}) {
    if (!force && covers(max) && (!stale || allowStale)) {
        return { chats: normalize(mem.items), complete: mem.complete, stale };
    }

    if (inflight && inflight.max >= max) {
        await inflight.promise;
        return { chats: normalize(mem ? mem.items : []), complete: mem ? mem.complete : false, stale };
    }

    const tokenAtStart = staleToken;
    const promise = (async () => {
        const { items, complete } = await fetchIndex(max);
        const changed = !mem || !sameItems(mem.items, items) || mem.complete !== complete;
        mem = { items, max, complete, fetchedAt: Date.now() };
        // Only clear the stale flag if nothing invalidated it while we were loading
        if (staleToken === tokenAtStart) stale = false;
        if (changed) generation++;
        persist();
    })();
    inflight = { max, promise };
    try {
        await promise;
    } finally {
        if (inflight && inflight.promise === promise) inflight = null;
    }
    return { chats: normalize(mem.items), complete: mem.complete, stale };
}

/** Mark cached data as outdated. Listeners are told so a visible list can refresh. */
export function markStale() {
    stale = true;
    staleToken++;
    for (const fn of staleListeners) {
        try { fn(); } catch (e) { console.warn(e); }
    }
}

export function onStale(fn) {
    staleListeners.add(fn);
    return () => staleListeners.delete(fn);
}

/**
 * Remove chats from the cached index right away (after deleting them).
 * @param {Array<{characterId: string, file_name: string, isGroup?: boolean}>} chats
 */
export function forgetChats(chats) {
    if (!mem) return;
    const characters = ctx().characters || [];
    const drop = new Set(chats.map(c => {
        if (c.isGroup) return 'g:' + c.characterId + ':' + c.file_name;
        const char = characters[c.characterId];
        return 'c:' + (char ? char.avatar : '') + ':' + c.file_name;
    }));
    const before = mem.items.length;
    mem.items = mem.items.filter(i => !drop.has((i.kind === 'group' ? 'g:' + i.groupId : 'c:' + i.avatar) + ':' + i.file_name));
    if (mem.items.length !== before) {
        generation++;
        persist();
    }
}

/** Load the persisted copy and hook ST events that make the cache outdated. */
export async function initChatStore() {
    const { eventSource, event_types } = ctx();
    const staleEvents = [
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
        'CHAT_CREATED', 'GROUP_CHAT_CREATED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED', 'CHAT_RENAMED',
        'CHARACTER_DELETED', 'CHARACTER_RENAMED',
    ];
    for (const name of staleEvents) {
        if (event_types && event_types[name]) eventSource.on(event_types[name], markStale);
    }
    await restore();
}
