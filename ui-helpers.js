// =========================
// ChatsPlus: shared display helpers (Korean, readable names and dates)
// =========================

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value) ? null : value;
    if (typeof value.toDate === 'function') return value.toDate();
    const d = new Date(typeof value === 'number' ? value : Date.parse(value));
    return isNaN(d) ? null : d;
}

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "오늘", "어제", "11월 3일 (화)", or "2025년 11월 3일 (월)" for other years. */
export function formatDateHeader(value) {
    const d = toDate(value);
    if (!d) return '';
    const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (diff === 0) return '오늘';
    if (diff === 1) return '어제';
    const md = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
    return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

/** Short time for a list row: "오후 3:05" today, "어제", "11/3", "2025/11/3". */
export function formatShortTime(value) {
    const d = toDate(value);
    if (!d) return '';
    const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (diff === 0) {
        const h = d.getHours();
        return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    if (diff === 1) return '어제';
    if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** Full date and time for tooltips. */
export function formatFullDateTime(value) {
    const d = toDate(value);
    if (!d) return '';
    const h = d.getHours();
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Put "캐릭터 이름 · 채팅 파일 이름" into an element, with the character name
 * emphasised and the (often long) file name muted.
 * @param {HTMLElement} el
 * @param {{character?: string, file_name?: string, isGroup?: boolean}} chat
 */
export function fillChatName(el, chat) {
    el.replaceChildren();
    el.classList.add('cp-name');
    const who = document.createElement('span');
    who.className = 'cp-char';
    who.textContent = (chat.isGroup ? '👥 ' : '') + (chat.character || '');
    const file = document.createElement('span');
    file.className = 'cp-file';
    file.textContent = chat.file_name || '';
    el.append(who, file);
    el.title = `${chat.character || ''} · ${chat.file_name || ''}`;
}
