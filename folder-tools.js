// =========================
// ChatsPlus: folder management tools
// =========================
// Folder menu (rename, move, reorder, color, subfolder, delete), moving chats
// between folders, bulk actions on a folder's chats, display options and
// drag & drop. All colors come from the active SillyTavern theme (see style.css).

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { deleteChatsFlow, isCurrentChat, makeAvatar } from './bulk-delete.js';
import { loadChats, peekChats } from './chat-store.js';

/**
 * Functions from index.js, injected to avoid circular imports.
 * @type {{
 *  getFolders: () => any[], setFolders: (f: any[]) => void, addFolder: (name: string, parent: string|null) => void,
 *  getChatFoldersMap: () => Object, setChatFoldersMap: (m: Object) => void,
 *  getSettings: () => any, saveSettingsDebounced: () => void,
 *  buildFolderTree: (f: any[]) => any[], buildFolderChatList: () => any[],
 *  refreshFolders: () => Promise<void>|void, refreshAll: () => Promise<void>|void,
 *  cleanupDeletedChats: (chats: any[]) => void,
 *  renameFolder: (folder: any) => Promise<void>, addChatsToFolder: (folder: any) => Promise<void>,
 * }}
 */
let api = null;

export function initFolderTools(deps) {
    api = deps;
}

const DND_TYPE = 'application/x-chatsplus';
const COLLAPSE_KEY = 'topInfoBar_folder_collapsed_';

// Folder colors: theme colors first (they change with the theme), then fixed hues.
const COLOR_CHOICES = [
    { label: '테마 기본', value: '' },
    { label: '테마 인용색', value: 'var(--SmartThemeQuoteColor)' },
    { label: '테마 강조색', value: 'var(--SmartThemeEmColor)' },
    { label: '테마 밑줄색', value: 'var(--SmartThemeUnderlineColor)' },
    { label: '빨강', value: '#e05d5d' },
    { label: '주황', value: '#e0995d' },
    { label: '노랑', value: '#d9c24a' },
    { label: '초록', value: '#5dbb72' },
    { label: '하늘', value: '#5db3e0' },
    { label: '파랑', value: '#6a7fe0' },
    { label: '보라', value: '#a97be0' },
    { label: '분홍', value: '#e07bb5' },
];

// ---------- settings ----------

export function getFolderDisplaySettings() {
    const s = api.getSettings();
    return {
        folderSort: s.folderSort === 'name' ? 'name' : 'manual',
        folderChatSort: s.folderChatSort === 'recent' ? 'recent' : 'name',
        showFolderCounts: s.showFolderCounts !== false,
    };
}

function saveDisplaySettings(patch) {
    Object.assign(api.getSettings(), patch);
    api.saveSettingsDebounced();
}

// ---------- ordering helpers ----------

/** Give every folder an `order` (keeps the old alphabetical order on first use). */
function ensureOrder(folders) {
    let changed = false;
    const byParent = new Map();
    for (const f of folders) {
        const key = f.parent || '';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(f);
    }
    for (const siblings of byParent.values()) {
        if (siblings.every(f => typeof f.order === 'number')) continue;
        siblings.sort(compareFolders);
        siblings.forEach((f, i) => {
            if (f.order !== i) {
                f.order = i;
                changed = true;
            }
        });
    }
    return changed;
}

function compareFolders(a, b) {
    const oa = typeof a.order === 'number' ? a.order : Infinity;
    const ob = typeof b.order === 'number' ? b.order : Infinity;
    if (oa !== ob) return oa - ob;
    return (a.name || '').localeCompare(b.name || '');
}

/** Folders in display order (input for buildFolderTree, which keeps order). */
export function sortFoldersForDisplay(folders) {
    const list = folders.slice();
    if (getFolderDisplaySettings().folderSort === 'name') {
        return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    if (ensureOrder(list)) api.setFolders(folders);
    return list.sort(compareFolders);
}

export function sortFolderChats(chats) {
    const list = chats.slice();
    if (getFolderDisplaySettings().folderChatSort === 'recent') {
        return list.sort((a, b) => (b.last_mes || 0) - (a.last_mes || 0)
            || (a.character || '').localeCompare(b.character || ''));
    }
    return list.sort((a, b) => (a.character || '').localeCompare(b.character || '')
        || (a.file_name || '').localeCompare(b.file_name || ''));
}

/** "Recent" sort needs last-message dates for every chat: load them once if missing. */
let recentLoadRequested = false;
export function ensureDatesForRecentSort() {
    if (getFolderDisplaySettings().folderChatSort !== 'recent') return;
    const cached = peekChats();
    if (cached && cached.complete && !cached.stale) return;
    if (recentLoadRequested) return;
    recentLoadRequested = true;
    loadChats({ max: Infinity })
        .then(() => api.refreshFolders())
        .catch(e => console.warn('ChatsPlus: could not load dates for folder sort', e))
        .finally(() => { recentLoadRequested = false; });
}

function getDescendantIds(folderId, folders = api.getFolders()) {
    const out = new Set();
    const walk = (id) => {
        for (const f of folders) {
            if (f.parent === id && !out.has(f.id)) {
                out.add(f.id);
                walk(f.id);
            }
        }
    };
    walk(folderId);
    return out;
}

function siblingsOf(folder, folders) {
    return folders.filter(f => (f.parent || null) === (folder.parent || null)).sort(compareFolders);
}

function renumber(siblings) {
    siblings.forEach((f, i) => { f.order = i; });
}

// ---------- folder operations ----------

/** Move a folder before/after another folder, or into it. Returns false if not allowed. */
export function placeFolder(folderId, targetId, position) {
    const folders = api.getFolders();
    ensureOrder(folders);
    const folder = folders.find(f => f.id === folderId);
    if (!folder || folderId === targetId) return false;
    const target = targetId ? folders.find(f => f.id === targetId) : null;
    if (targetId && !target) return false;

    const newParent = position === 'into' ? (target ? target.id : null) : (target ? (target.parent || null) : null);
    // A folder can't go inside itself or its own subfolders
    if (newParent && (newParent === folderId || getDescendantIds(folderId, folders).has(newParent))) {
        toastr.warning('폴더를 자기 자신이나 하위 폴더 안으로 옮길 수 없어요.');
        return false;
    }

    const oldSiblings = siblingsOf(folder, folders).filter(f => f.id !== folderId);
    folder.parent = newParent;
    const newSiblings = folders.filter(f => (f.parent || null) === newParent && f.id !== folderId).sort(compareFolders);
    let index = newSiblings.length;
    if (position !== 'into' && target) {
        index = newSiblings.findIndex(f => f.id === target.id);
        if (position === 'after') index += 1;
    }
    newSiblings.splice(index, 0, folder);
    renumber(oldSiblings);
    renumber(newSiblings);
    api.setFolders(folders);
    if (position !== 'into' && getFolderDisplaySettings().folderSort === 'name') {
        saveDisplaySettings({ folderSort: 'manual' });
        toastr.info('폴더 정렬을 "직접 정렬"로 바꿨어요.');
    }
    return true;
}

function shiftFolder(folderId, delta) {
    const folders = api.getFolders();
    ensureOrder(folders);
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;
    const siblings = siblingsOf(folder, folders);
    const i = siblings.findIndex(f => f.id === folderId);
    const j = i + delta;
    if (j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    renumber(siblings);
    api.setFolders(folders);
    if (getFolderDisplaySettings().folderSort === 'name') saveDisplaySettings({ folderSort: 'manual' });
}

/** Delete a folder: its subfolders move up one level, chats only lose this folder tag. */
function deleteFolderSafely(folderId) {
    const folders = api.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;
    for (const f of folders) {
        if (f.parent === folderId) f.parent = folder.parent || null;
    }
    api.setFolders(folders.filter(f => f.id !== folderId));
    const map = api.getChatFoldersMap();
    for (const key of Object.keys(map)) {
        map[key] = (map[key] || []).filter(id => id !== folderId);
        if (map[key].length === 0) delete map[key];
    }
    api.setChatFoldersMap(map);
    try { localStorage.removeItem(COLLAPSE_KEY + folderId); } catch { /* ignore */ }
}

function chatKey(chat) {
    return chat.characterId + ':' + chat.file_name;
}

/**
 * Move (or copy) chats between folders.
 * @param {Array} chats
 * @param {string|null} fromFolderId folder to remove them from (null = keep)
 * @param {string|null} toFolderId folder to add them to (null = none)
 */
export function moveChats(chats, fromFolderId, toFolderId) {
    const map = api.getChatFoldersMap();
    for (const chat of chats) {
        const key = chatKey(chat);
        let ids = Array.isArray(map[key]) ? map[key].slice() : [];
        if (fromFolderId) ids = ids.filter(id => id !== fromFolderId);
        if (toFolderId && !ids.includes(toFolderId)) ids.push(toFolderId);
        if (ids.length) map[key] = ids;
        else delete map[key];
    }
    api.setChatFoldersMap(map);
}

// ---------- popups ----------

function makeMenuButton(icon, label, onClick, { danger = false, disabled = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu_button chatsplus-menu-item' + (danger ? ' chatsplus-menu-danger' : '');
    btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.disabled = disabled;
    if (disabled) btn.classList.add('disabled');
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!btn.disabled) onClick();
    });
    return btn;
}

/**
 * Pick a folder from the tree.
 * @returns {Promise<string|null|undefined>} folder id, null for top level, undefined if cancelled
 */
export async function pickFolder({ title, excludeIds = new Set(), allowRoot = false, rootLabel = '최상위 (폴더 밖)', disabledIds = new Set() } = {}) {
    const folders = sortFoldersForDisplay(api.getFolders());
    const content = document.createElement('div');
    content.className = 'chatsplus-picker';
    const h = document.createElement('h3');
    h.textContent = title;
    content.appendChild(h);
    const group = document.createElement('div');
    group.className = 'chatplus_radio_group chatsplus-folder-radios';
    content.appendChild(group);
    const name = 'chatsplus-pick-' + Date.now();

    const addOption = (value, label, level, disabled, color) => {
        const row = document.createElement('label');
        row.className = 'chatsplus-radio-row' + (disabled ? ' disabled' : '');
        row.style.paddingLeft = (level * 18) + 'px';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = value;
        radio.disabled = disabled;
        const icon = document.createElement('i');
        icon.className = 'fa-solid ' + (value === '__root__' ? 'fa-layer-group' : 'fa-folder');
        if (color) icon.style.color = color;
        const text = document.createElement('span');
        text.textContent = label;
        row.append(radio, icon, text);
        group.appendChild(row);
    };
    if (allowRoot) addOption('__root__', rootLabel, 0, false, '');
    const walk = (nodes, level) => {
        for (const node of nodes) {
            if (excludeIds.has(node.id)) continue;
            addOption(node.id, node.name, level, disabledIds.has(node.id), node.color);
            if (node.children && node.children.length) walk(node.children, level + 1);
        }
    };
    walk(api.buildFolderTree(folders), 0);
    if (!group.querySelector('input')) {
        const empty = document.createElement('div');
        empty.className = 'chatsplus-bulk-empty';
        empty.textContent = '고를 수 있는 폴더가 없어요.';
        group.appendChild(empty);
    }

    const res = await new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '선택', cancelButton: '취소', wide: true }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return undefined;
    const checked = content.querySelector('input[type=radio]:checked');
    if (!checked) return undefined;
    return checked.value === '__root__' ? null : checked.value;
}

async function promptText(title, value = '', okLabel = '확인') {
    const content = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chatplus_menu_input';
    input.value = value;
    content.append(h, input);
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: okLabel, cancelButton: '취소', wide: true });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            popup.okButton.click();
        }
    });
    const shown = popup.show();
    setTimeout(() => input.focus(), 50);
    const res = await shown;
    if (res !== POPUP_RESULT.AFFIRMATIVE) return null;
    const v = input.value.trim();
    return v || null;
}

async function pickColor(folder) {
    const content = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = `"${folder.name}" 폴더 색`;
    const note = document.createElement('div');
    note.className = 'chatsplus-muted-note';
    note.textContent = '"테마" 색은 테마를 바꾸면 같이 바뀌어요.';
    const grid = document.createElement('div');
    grid.className = 'chatsplus-color-grid';
    let chosen = folder.color || '';
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: '취소' });
    for (const c of COLOR_CHOICES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chatsplus-color-swatch' + ((c.value || '') === (folder.color || '') ? ' active' : '');
        btn.title = c.label;
        const dot = document.createElement('i');
        dot.className = 'fa-solid fa-folder';
        if (c.value) dot.style.color = c.value;
        const label = document.createElement('span');
        label.textContent = c.label;
        btn.append(dot, label);
        btn.addEventListener('click', () => {
            chosen = c.value;
            popup.complete(POPUP_RESULT.AFFIRMATIVE);
        });
        grid.appendChild(btn);
    }
    // Custom color
    const customRow = document.createElement('label');
    customRow.className = 'chatsplus-color-custom';
    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.value = /^#[0-9a-f]{6}$/i.test(folder.color || '') ? folder.color : '#888888';
    const customText = document.createElement('span');
    customText.textContent = '직접 고르기';
    customRow.append(customInput, customText);
    customInput.addEventListener('change', () => {
        chosen = customInput.value;
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
    });
    content.append(h, note, grid, customRow);
    const res = await popup.show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;
    const folders = api.getFolders();
    const f = folders.find(x => x.id === folder.id);
    if (!f) return;
    if (chosen) f.color = chosen;
    else delete f.color;
    api.setFolders(folders);
    await api.refreshFolders();
}

/** The ⋯ menu on a folder header. */
export async function openFolderMenu(folder) {
    const folders = api.getFolders();
    const live = folders.find(f => f.id === folder.id) || folder;
    const manual = getFolderDisplaySettings().folderSort === 'manual';
    const siblings = siblingsOf(live, folders);
    const pos = siblings.findIndex(f => f.id === live.id);

    const content = document.createElement('div');
    content.className = 'chatsplus-menu';
    const h = document.createElement('h3');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-folder';
    if (live.color) icon.style.color = live.color;
    h.append(icon, document.createTextNode(' ' + live.name));
    content.appendChild(h);

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: '닫기' });
    let action = null;
    const pick = (a) => () => {
        action = a;
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
    };

    const sec1 = document.createElement('div');
    sec1.className = 'chatsplus-menu-section';
    sec1.append(
        makeMenuButton('fa-pencil-alt', '이름 바꾸기', pick('rename')),
        makeMenuButton('fa-palette', '색 바꾸기', pick('color')),
        makeMenuButton('fa-folder-plus', '하위 폴더 만들기', pick('subfolder')),
    );
    const sec2 = document.createElement('div');
    sec2.className = 'chatsplus-menu-section';
    sec2.append(
        makeMenuButton('fa-bookmark', '채팅 추가하기', pick('addChats')),
        makeMenuButton('fa-list-check', '채팅 골라서 처리하기', pick('bulk')),
    );
    const sec3 = document.createElement('div');
    sec3.className = 'chatsplus-menu-section';
    sec3.append(
        makeMenuButton('fa-arrow-up', '위로', pick('up'), { disabled: pos <= 0 }),
        makeMenuButton('fa-arrow-down', '아래로', pick('down'), { disabled: pos < 0 || pos >= siblings.length - 1 }),
        makeMenuButton('fa-folder-tree', '다른 폴더로 옮기기', pick('move')),
    );
    if (!manual) {
        const note = document.createElement('div');
        note.className = 'chatsplus-muted-note';
        note.textContent = '지금은 이름순 정렬이에요. 위/아래로 옮기면 직접 정렬로 바뀌어요.';
        sec3.appendChild(note);
    }
    const sec4 = document.createElement('div');
    sec4.className = 'chatsplus-menu-section';
    sec4.append(makeMenuButton('fa-trash-can', '폴더 삭제', pick('delete'), { danger: true }));
    content.append(sec1, sec2, sec3, sec4);

    await popup.show();
    if (!action) return;

    switch (action) {
        case 'rename':
            await api.renameFolder(live);
            break;
        case 'color':
            await pickColor(live);
            break;
        case 'subfolder': {
            const name = await promptText(`"${live.name}" 안에 만들 폴더 이름`, '', '만들기');
            if (name) {
                api.addFolder(name, live.id);
                await api.refreshFolders();
            }
            break;
        }
        case 'addChats':
            await api.addChatsToFolder(live);
            break;
        case 'bulk':
            await openFolderBulk(live);
            break;
        case 'up':
        case 'down':
            shiftFolder(live.id, action === 'up' ? -1 : 1);
            await api.refreshFolders();
            break;
        case 'move': {
            const exclude = getDescendantIds(live.id);
            exclude.add(live.id);
            const target = await pickFolder({ title: `"${live.name}" 폴더를 어디로 옮길까요?`, excludeIds: exclude, allowRoot: true });
            if (target === undefined) break;
            if ((target || null) === (live.parent || null)) break;
            if (placeFolder(live.id, target, 'into')) await api.refreshFolders();
            break;
        }
        case 'delete':
            await confirmDeleteFolder(live);
            break;
    }
}

async function confirmDeleteFolder(folder) {
    const map = api.getChatFoldersMap();
    const chatCount = Object.values(map).filter(ids => Array.isArray(ids) && ids.includes(folder.id)).length;
    const subCount = api.getFolders().filter(f => f.parent === folder.id).length;
    const content = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = `"${folder.name}" 폴더를 삭제할까요?`;
    const p = document.createElement('p');
    const lines = ['채팅 파일은 지워지지 않고, 이 폴더에서만 빠져요.'];
    if (chatCount) lines.push(`들어 있던 채팅: ${chatCount}개`);
    if (subCount) lines.push(`하위 폴더 ${subCount}개는 한 단계 위로 올라가요.`);
    p.textContent = lines.join(' ');
    content.append(h, p);
    const res = await new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '삭제', cancelButton: '취소' }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;
    deleteFolderSafely(folder.id);
    await api.refreshFolders();
}

/** Move one chat out of a folder into another (button on a folder chat row). */
export async function moveChatPrompt(chat, fromFolderId) {
    const target = await pickFolder({
        title: `"${chat.character}: ${chat.file_name}" 옮길 폴더`,
        excludeIds: new Set([fromFolderId]),
    });
    if (target === undefined || target === null) return;
    moveChats([chat], fromFolderId, target);
    await api.refreshFolders();
}

/** Checkbox list of a folder's chats with actions: remove, move, copy, delete files. */
export async function openFolderBulk(folder) {
    const chats = sortFolderChats(api.buildFolderChatList().filter(c => {
        const ids = api.getChatFoldersMap()[chatKey(c)];
        return Array.isArray(ids) && ids.includes(folder.id);
    }));

    const content = document.createElement('div');
    content.className = 'chatsplus-bulk';
    const h = document.createElement('h3');
    h.textContent = `"${folder.name}" 채팅 골라서 처리하기`;
    content.appendChild(h);

    if (chats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chatsplus-bulk-empty';
        empty.textContent = '이 폴더에는 채팅이 없어요.';
        content.appendChild(empty);
        await new Popup(content, POPUP_TYPE.TEXT, '', { okButton: '닫기' }).show();
        return;
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'chatsplus-bulk-toolbar';
    const allBtn = document.createElement('button');
    allBtn.className = 'menu_button';
    allBtn.textContent = '모두 선택';
    const noneBtn = document.createElement('button');
    noneBtn.className = 'menu_button';
    noneBtn.textContent = '선택 해제';
    const count = document.createElement('span');
    count.className = 'chatsplus-bulk-count';
    toolbar.append(allBtn, noneBtn, count);
    content.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'chatsplus-bulk-list';
    content.appendChild(list);

    const selected = new Map();
    const updateCount = () => {
        count.textContent = `${selected.size}개 선택됨`;
        for (const b of actionButtons) b.disabled = selected.size === 0;
    };

    for (const chat of chats) {
        const row = document.createElement('label');
        row.className = 'chatsplus-bulk-row chatsplus-bulk-row-accent';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const info = document.createElement('div');
        info.className = 'chatsplus-bulk-info';
        const name = document.createElement('div');
        name.className = 'chatsplus-bulk-name';
        name.textContent = `${chat.isGroup ? '👥 ' : ''}${chat.character}: ${chat.file_name}`;
        info.appendChild(name);
        if (chat.stat && chat.stat.mes) {
            const pv = document.createElement('div');
            pv.className = 'chatsplus-bulk-preview';
            pv.textContent = chat.stat.mes;
            info.appendChild(pv);
        }
        row.append(cb, makeAvatar(chat), info);
        cb.addEventListener('change', () => {
            if (cb.checked) selected.set(chatKey(chat), chat);
            else selected.delete(chatKey(chat));
            row.classList.toggle('selected', cb.checked);
            updateCount();
        });
        list.appendChild(row);
    }

    const setAll = (on) => {
        list.querySelectorAll('.chatsplus-bulk-row').forEach((row, i) => {
            const cb = row.querySelector('input');
            cb.checked = on;
            row.classList.toggle('selected', on);
            if (on) selected.set(chatKey(chats[i]), chats[i]);
        });
        if (!on) selected.clear();
        updateCount();
    };
    allBtn.addEventListener('click', (e) => { e.preventDefault(); setAll(true); });
    noneBtn.addEventListener('click', (e) => { e.preventDefault(); setAll(false); });

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: '닫기', wide: true, large: true });
    let action = null;
    const actions = document.createElement('div');
    actions.className = 'chatsplus-bulk-actions';
    const mk = (icon, label, a, danger) => makeMenuButton(icon, label, () => {
        action = a;
        popup.complete(POPUP_RESULT.AFFIRMATIVE);
    }, { danger });
    const actionButtons = [
        mk('fa-arrow-right-from-bracket', '이 폴더에서 빼기', 'remove'),
        mk('fa-folder-tree', '다른 폴더로 옮기기', 'move'),
        mk('fa-copy', '다른 폴더에도 넣기', 'copy'),
        mk('fa-trash-can', '채팅 파일 삭제', 'delete', true),
    ];
    actions.append(...actionButtons);
    content.appendChild(actions);
    updateCount();

    await popup.show();
    const picked = [...selected.values()];
    if (!action || picked.length === 0) return;

    if (action === 'remove') {
        moveChats(picked, folder.id, null);
        toastr.success(`${picked.length}개를 폴더에서 뺐어요.`);
        await api.refreshFolders();
    } else if (action === 'move' || action === 'copy') {
        const target = await pickFolder({
            title: action === 'move' ? `${picked.length}개를 옮길 폴더` : `${picked.length}개를 추가로 넣을 폴더`,
            excludeIds: new Set([folder.id]),
        });
        if (!target) return;
        moveChats(picked, action === 'move' ? folder.id : null, target);
        toastr.success(action === 'move' ? `${picked.length}개를 옮겼어요.` : `${picked.length}개를 넣었어요.`);
        await api.refreshFolders();
    } else if (action === 'delete') {
        const deletable = picked.filter(c => !isCurrentChat(c));
        if (deletable.length !== picked.length) toastr.info('지금 열려 있는 채팅은 빼고 삭제해요.');
        await deleteChatsFlow(deletable, { onDeleted: api.cleanupDeletedChats, refresh: api.refreshAll });
    }
}

/** Display options for the Folders tab. */
export async function openFolderOptions() {
    const cur = getFolderDisplaySettings();
    const content = document.createElement('div');
    content.className = 'chatsplus-options';
    const h = document.createElement('h3');
    h.textContent = '폴더 보기 옵션';
    content.appendChild(h);

    const radioGroup = (title, name, options, value) => {
        const box = document.createElement('div');
        box.className = 'chatsplus-option-group';
        const t = document.createElement('div');
        t.className = 'chatsplus-option-title';
        t.textContent = title;
        box.appendChild(t);
        for (const [v, label] of options) {
            const row = document.createElement('label');
            row.className = 'chatsplus-radio-row';
            const r = document.createElement('input');
            r.type = 'radio';
            r.name = name;
            r.value = v;
            r.checked = v === value;
            const s = document.createElement('span');
            s.textContent = label;
            row.append(r, s);
            box.appendChild(row);
        }
        return box;
    };
    content.appendChild(radioGroup('폴더 순서', 'cp-folder-sort', [['manual', '직접 정렬 (메뉴의 위/아래, 끌어다 놓기)'], ['name', '이름순']], cur.folderSort));
    content.appendChild(radioGroup('폴더 안 채팅 순서', 'cp-chat-sort', [['name', '이름순'], ['recent', '최근 대화순']], cur.folderChatSort));

    const countRow = document.createElement('label');
    countRow.className = 'chatsplus-radio-row';
    const countCb = document.createElement('input');
    countCb.type = 'checkbox';
    countCb.checked = cur.showFolderCounts;
    const countText = document.createElement('span');
    countText.textContent = '폴더 이름 옆에 채팅 수 표시';
    countRow.append(countCb, countText);
    const countBox = document.createElement('div');
    countBox.className = 'chatsplus-option-group';
    countBox.appendChild(countRow);
    content.appendChild(countBox);

    const bulkRow = document.createElement('div');
    bulkRow.className = 'chatsplus-bulk-toolbar';
    let expandAction = null;
    const expandBtn = document.createElement('button');
    expandBtn.className = 'menu_button';
    expandBtn.textContent = '모두 펼치기';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'menu_button';
    collapseBtn.textContent = '모두 접기';
    expandBtn.addEventListener('click', (e) => { e.preventDefault(); expandAction = 'expand'; expandBtn.classList.add('active'); collapseBtn.classList.remove('active'); });
    collapseBtn.addEventListener('click', (e) => { e.preventDefault(); expandAction = 'collapse'; collapseBtn.classList.add('active'); expandBtn.classList.remove('active'); });
    bulkRow.append(expandBtn, collapseBtn);
    content.appendChild(bulkRow);

    const res = await new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: '적용', cancelButton: '취소', wide: true }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;
    saveDisplaySettings({
        folderSort: content.querySelector('input[name=cp-folder-sort]:checked')?.value || 'manual',
        folderChatSort: content.querySelector('input[name=cp-chat-sort]:checked')?.value || 'name',
        showFolderCounts: countCb.checked,
    });
    if (expandAction) {
        for (const f of api.getFolders()) {
            try {
                if (expandAction === 'collapse') localStorage.setItem(COLLAPSE_KEY + f.id, '1');
                else localStorage.removeItem(COLLAPSE_KEY + f.id);
            } catch { /* ignore */ }
        }
    }
    await api.refreshFolders();
}

// ---------- drag & drop (desktop) ----------

let dragPayload = null;

function clearDropMarks() {
    document.querySelectorAll('.chatsplus-drop-before, .chatsplus-drop-after, .chatsplus-drop-into')
        .forEach(el => el.classList.remove('chatsplus-drop-before', 'chatsplus-drop-after', 'chatsplus-drop-into'));
}

/** Make a chat row inside a folder draggable. */
export function makeChatDraggable(el, chat, folderId) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
        dragPayload = { type: 'chat', chat, folderId };
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(DND_TYPE, 'chat');
        el.classList.add('chatsplus-dragging');
    });
    el.addEventListener('dragend', () => {
        el.classList.remove('chatsplus-dragging');
        dragPayload = null;
        clearDropMarks();
    });
}

function dropZone(e, el) {
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(r.height, 1);
    if (y < 0.25) return 'before';
    if (y > 0.75) return 'after';
    return 'into';
}

/** Folder header: draggable itself, accepts chats (into) and folders (before/after/into). */
export function makeFolderHeaderDnD(header, folder) {
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
        if (e.target !== header) return;
        dragPayload = { type: 'folder', folderId: folder.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_TYPE, 'folder');
        header.classList.add('chatsplus-dragging');
    });
    header.addEventListener('dragend', () => {
        header.classList.remove('chatsplus-dragging');
        dragPayload = null;
        clearDropMarks();
    });
    header.addEventListener('dragover', (e) => {
        if (!dragPayload) return;
        if (dragPayload.type === 'folder' && dragPayload.folderId === folder.id) return;
        e.preventDefault();
        const zone = dragPayload.type === 'chat' ? 'into' : dropZone(e, header);
        e.dataTransfer.dropEffect = dragPayload.type === 'chat' && e.ctrlKey ? 'copy' : 'move';
        clearDropMarks();
        header.classList.add('chatsplus-drop-' + zone);
    });
    header.addEventListener('dragleave', (e) => {
        if (!header.contains(e.relatedTarget)) header.classList.remove('chatsplus-drop-before', 'chatsplus-drop-after', 'chatsplus-drop-into');
    });
    header.addEventListener('drop', async (e) => {
        if (!dragPayload) return;
        e.preventDefault();
        const payload = dragPayload;
        const zone = payload.type === 'chat' ? 'into' : dropZone(e, header);
        clearDropMarks();
        dragPayload = null;
        if (payload.type === 'chat') {
            if (payload.folderId === folder.id) return;
            // Ctrl while dropping = copy (keep it in the old folder too)
            moveChats([payload.chat], e.ctrlKey ? null : payload.folderId, folder.id);
            await api.refreshFolders();
        } else if (payload.type === 'folder') {
            if (placeFolder(payload.folderId, folder.id, zone)) await api.refreshFolders();
        }
    });
}

/** Drop zone that moves a dragged folder to the top level. */
export function makeRootDropZone(el) {
    el.addEventListener('dragover', (e) => {
        if (!dragPayload || dragPayload.type !== 'folder') return;
        e.preventDefault();
        el.classList.add('chatsplus-drop-into');
    });
    el.addEventListener('dragleave', () => el.classList.remove('chatsplus-drop-into'));
    el.addEventListener('drop', async (e) => {
        if (!dragPayload || dragPayload.type !== 'folder') return;
        e.preventDefault();
        const id = dragPayload.folderId;
        dragPayload = null;
        clearDropMarks();
        if (placeFolder(id, null, 'into')) await api.refreshFolders();
    });
}
