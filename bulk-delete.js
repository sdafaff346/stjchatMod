// =========================
// ChatsPlus: delete several chat files at once
// =========================

import * as stScript from '../../../../script.js';
import * as stGroups from '../../../group-chats.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { fillChatName, formatFullDateTime } from './ui-helpers.js';
import { loadChats, forgetChats, markStale } from './chat-store.js';

const RENDER_BATCH = 150; // rows rendered per "show more" click

function ctx() {
    return SillyTavern.getContext();
}

function chatKey(chat) {
    return `${chat.characterId}:${chat.file_name}`;
}

/** Is this the chat that is open right now? It can't be deleted from here. */
function isCurrentChat(chat) {
    const context = ctx();
    const currentId = context.getCurrentChatId && context.getCurrentChatId();
    if (!currentId || currentId !== chat.file_name) return false;
    if (chat.isGroup) return String(context.groupId) === String(chat.characterId);
    return context.groupId == null && String(context.characterId) === String(chat.characterId);
}

function makeAvatar(chat) {
    let el;
    if (chat.isGroup) {
        el = document.createElement('div');
        el.className = 'tabItem-previewImg group-preview';
        const group = (stGroups.groups || []).find(g => g.id === chat.characterId);
        if (group && typeof stGroups.getGroupAvatar === 'function') {
            const result = stGroups.getGroupAvatar(group);
            if (result && result.length > 0) {
                const node = result[0];
                node.style.width = '100%';
                node.style.height = '100%';
                node.style.minWidth = 'unset';
                el.appendChild(node);
            }
        }
    } else {
        el = document.createElement('img');
        el.className = 'tabItem-previewImg';
        el.loading = 'lazy';
        const { getThumbnailUrl } = ctx();
        el.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
        el.alt = chat.character || '';
    }
    el.style.width = '32px';
    el.style.height = '32px';
    return el;
}

function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Show a list of all chats with checkboxes and return the chosen ones.
 * @returns {Promise<Array|null>} chosen chats, or null if cancelled
 */
async function pickChatsToDelete() {
    const content = document.createElement('div');
    content.className = 'chatsplus-bulk';

    const title = document.createElement('h3');
    title.textContent = '채팅 여러 개 삭제';
    content.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'chatsplus-bulk-hint';
    hint.textContent = '지울 채팅을 고르세요. 지금 열려 있는 채팅은 고를 수 없어요.';
    content.appendChild(hint);

    // Filter row
    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = '캐릭터 이름, 채팅 이름, 마지막 메시지로 찾기';
    filterInput.className = 'text_pole chatsplus-bulk-filter';
    content.appendChild(filterInput);

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'chatsplus-bulk-toolbar';
    const selectVisibleBtn = document.createElement('button');
    selectVisibleBtn.className = 'menu_button';
    selectVisibleBtn.textContent = '보이는 것 모두 선택';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'menu_button';
    clearBtn.textContent = '선택 해제';
    const countLabel = document.createElement('span');
    countLabel.className = 'chatsplus-bulk-count';
    toolbar.append(selectVisibleBtn, clearBtn, countLabel);
    content.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'chatsplus-bulk-list';
    content.appendChild(list);

    const loader = document.createElement('div');
    loader.className = 'chatsplus-bulk-loader';
    loader.innerHTML = '<i class="fa-2x fa-solid fa-gear fa-spin"></i>';
    list.appendChild(loader);

    /** @type {Map<string, any>} */
    const selected = new Map();
    let allChats = [];
    let filtered = [];
    let rendered = 0;

    const updateCount = () => {
        countLabel.textContent = `${selected.size}개 선택됨`;
    };

    function renderRow(chat) {
        const key = chatKey(chat);
        const locked = isCurrentChat(chat);
        const row = document.createElement('label');
        row.className = 'chatsplus-bulk-row' + (locked ? ' locked' : '') + (selected.has(key) ? ' selected' : '');
        row.dataset.key = key;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(key);
        checkbox.disabled = locked;

        const info = document.createElement('div');
        info.className = 'chatsplus-bulk-info';
        const name = document.createElement('div');
        name.className = 'chatsplus-bulk-name';
        fillChatName(name, chat);
        const meta = document.createElement('div');
        meta.className = 'chatsplus-bulk-meta';
        const parts = [formatFullDateTime(chat.last_mes)];
        if (chat.stat && chat.stat.chat_items != null) parts.push(`메시지 ${chat.stat.chat_items}개`);
        if (chat.stat && chat.stat.file_size) parts.push(chat.stat.file_size);
        if (locked) parts.push('지금 열린 채팅');
        meta.textContent = parts.filter(Boolean).join(' · ');
        const preview = document.createElement('div');
        preview.className = 'chatsplus-bulk-preview';
        preview.textContent = chat.stat && chat.stat.mes ? chat.stat.mes : '';
        info.append(name, meta, preview);

        row.append(checkbox, makeAvatar(chat), info);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.set(key, chat);
            else selected.delete(key);
            row.classList.toggle('selected', checkbox.checked);
            updateCount();
        });
        return row;
    }

    const moreBtn = document.createElement('button');
    moreBtn.className = 'menu_button chatsplus-bulk-more';

    function renderMore() {
        const frag = document.createDocumentFragment();
        const end = Math.min(rendered + RENDER_BATCH, filtered.length);
        for (let i = rendered; i < end; i++) frag.appendChild(renderRow(filtered[i]));
        rendered = end;
        moreBtn.remove();
        list.appendChild(frag);
        if (rendered < filtered.length) {
            moreBtn.textContent = `더 보기 (${filtered.length - rendered}개 남음)`;
            list.appendChild(moreBtn);
        }
    }
    moreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        renderMore();
    });

    function applyFilter() {
        const q = filterInput.value.trim().toLowerCase();
        filtered = !q ? allChats : allChats.filter(c =>
            (c.character && c.character.toLowerCase().includes(q)) ||
            (c.file_name && c.file_name.toLowerCase().includes(q)) ||
            (c.stat && typeof c.stat.mes === 'string' && c.stat.mes.toLowerCase().includes(q)));
        list.replaceChildren();
        rendered = 0;
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chatsplus-bulk-empty';
            empty.textContent = '맞는 채팅이 없어요.';
            list.appendChild(empty);
            return;
        }
        renderMore();
    }

    let filterTimer = null;
    filterInput.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(applyFilter, 150);
    });

    selectVisibleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        for (const chat of filtered) {
            if (!isCurrentChat(chat)) selected.set(chatKey(chat), chat);
        }
        list.querySelectorAll('.chatsplus-bulk-row').forEach(row => {
            const cb = row.querySelector('input[type=checkbox]');
            if (cb && !cb.disabled) {
                cb.checked = true;
                row.classList.add('selected');
            }
        });
        updateCount();
    });

    clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        selected.clear();
        list.querySelectorAll('.chatsplus-bulk-row').forEach(row => {
            const cb = row.querySelector('input[type=checkbox]');
            if (cb) cb.checked = false;
            row.classList.remove('selected');
        });
        updateCount();
    });

    updateCount();

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: '선택한 채팅 삭제',
        cancelButton: '취소',
        wide: true,
        large: true,
    });
    const shown = popup.show();

    // Load after the popup is on screen so it opens instantly
    try {
        const { chats } = await loadChats({ max: Infinity });
        allChats = chats;
        applyFilter();
    } catch (e) {
        console.error('ChatsPlus: failed to load chats for deletion', e);
        list.replaceChildren();
        const err = document.createElement('div');
        err.className = 'chatsplus-bulk-empty';
        err.textContent = '채팅 목록을 불러오지 못했어요. 콘솔(F12)을 확인해 주세요.';
        list.appendChild(err);
    }

    const result = await shown;
    if (result !== POPUP_RESULT.AFFIRMATIVE || selected.size === 0) return null;
    return [...selected.values()];
}

/** Second, explicit confirmation listing what will be removed. */
async function confirmDeletion(chats) {
    const box = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = `채팅 ${chats.length}개를 삭제할까요?`;
    const warn = document.createElement('p');
    warn.className = 'chatsplus-bulk-warn';
    warn.textContent = '서버에서 파일이 지워지고 되돌릴 수 없어요. 고정·폴더 정보도 함께 정리돼요.';
    const ul = document.createElement('ul');
    ul.className = 'chatsplus-bulk-confirm-list';
    const shownCount = Math.min(chats.length, 15);
    for (let i = 0; i < shownCount; i++) {
        const li = document.createElement('li');
        li.textContent = `${chats[i].character}: ${chats[i].file_name}`;
        ul.appendChild(li);
    }
    if (chats.length > shownCount) {
        const li = document.createElement('li');
        li.textContent = `… 외 ${chats.length - shownCount}개`;
        ul.appendChild(li);
    }
    box.append(h, warn, ul);
    const res = await new Popup(box, POPUP_TYPE.CONFIRM, '', { okButton: '삭제', cancelButton: '취소' }).show();
    return res === POPUP_RESULT.AFFIRMATIVE;
}

async function deleteOne(chat) {
    const context = ctx();
    if (chat.isGroup) {
        if (typeof stGroups.deleteGroupChatByName === 'function') {
            // Updates the group's chat list, saves the group and emits GROUP_CHAT_DELETED
            const group = (stGroups.groups || []).find(g => g.id === chat.characterId);
            if (!group || !group.chats.includes(chat.file_name)) throw new Error('group chat not found');
            await stGroups.deleteGroupChatByName(chat.characterId, chat.file_name);
            if (group.chats.includes(chat.file_name)) throw new Error('group chat was not deleted');
            return;
        }
        throw new Error('This SillyTavern version has no deleteGroupChatByName; update SillyTavern to delete group chats here.');
    }

    if (typeof stScript.deleteCharacterChatByName === 'function') {
        // Deletes the file, fixes the character's "last chat" pointer and emits CHAT_DELETED
        // ST only logs a console error on failure, so verify afterwards
        await stScript.deleteCharacterChatByName(chat.characterId, chat.file_name);
        if (await chatExists(chat)) throw new Error('chat was not deleted');
        return;
    }

    // Fallback for older builds: call the endpoint directly
    const char = (context.characters || [])[chat.characterId];
    if (!char) throw new Error('character not found');
    const res = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ chatfile: `${chat.file_name}.jsonl`, avatar_url: char.avatar }),
    });
    if (!res.ok) throw new Error(`delete failed (${res.status})`);
    const { eventSource, event_types } = context;
    await eventSource.emit(event_types.CHAT_DELETED, chat.file_name);
}

/** Cheap existence check (file listing only, no file reads). */
async function chatExists(chat) {
    const context = ctx();
    const char = (context.characters || [])[chat.characterId];
    if (!char) return false;
    const res = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: char.avatar, simple: true }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!Array.isArray(data)) return false;
    return data.some(x => String(x.file_name).replace(/\.jsonl$/i, '') === chat.file_name);
}

/**
 * Full flow: pick → confirm → delete → clean up.
 * @param {Object} hooks
 * @param {(chats: Array) => void} hooks.onDeleted called with successfully deleted chats (to clean pins/folders)
 * @param {() => Promise<void>|void} hooks.refresh re-render lists
 */
export { isCurrentChat, makeAvatar };

export async function runBulkDelete({ onDeleted, refresh } = {}) {
    const chosen = await pickChatsToDelete();
    if (!chosen || chosen.length === 0) return;
    await deleteChatsFlow(chosen, { onDeleted, refresh });
}

/**
 * Confirm and delete the given chats (used by the picker and by folder bulk actions).
 * @param {Array} chosen chats to delete
 * @param {Object} hooks same as runBulkDelete
 * @returns {Promise<Array>} chats that were deleted
 */
export async function deleteChatsFlow(chosen, { onDeleted, refresh } = {}) {
    if (!chosen || chosen.length === 0) return [];
    if (!(await confirmDeletion(chosen))) return [];

    const toast = toastr.info(`0 / ${chosen.length}`, '채팅 삭제 중…', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    const done = [];
    const failed = [];
    // Sequential on purpose: group deletions each save the group file,
    // and deleting the character's "last chat" rewrites the character card.
    for (let i = 0; i < chosen.length; i++) {
        const chat = chosen[i];
        if (isCurrentChat(chat)) {
            failed.push({ chat, error: new Error('currently open') });
            continue;
        }
        try {
            await deleteOne(chat);
            done.push(chat);
        } catch (error) {
            console.warn('ChatsPlus: failed to delete', chat, error);
            failed.push({ chat, error });
        }
        if (toast && toast.find) toast.find('.toast-message').text(`${i + 1} / ${chosen.length}`);
    }
    if (toast) toastr.clear(toast);

    forgetChats(done);
    markStale();
    if (typeof onDeleted === 'function') onDeleted(done);
    if (typeof refresh === 'function') await refresh();

    if (failed.length === 0) {
        toastr.success(`채팅 ${done.length}개를 삭제했어요.`);
    } else {
        toastr.warning(
            `${done.length}개 삭제, ${failed.length}개 실패. 실패 목록은 콘솔(F12)에 있어요.`,
            '일부 삭제 실패',
        );
        console.table(failed.map(f => ({ chat: `${f.chat.character}: ${f.chat.file_name}`, error: String(f.error && f.error.message) })));
    }
    return done;
}
