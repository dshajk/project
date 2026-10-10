// 자주 사용하는 HTML 요소를 한 번 찾아 두고 이후 기능에서 재사용한다.
const chat = document.querySelector('#chat');
const resetButton = document.querySelector('#resetButton');
const toast = document.querySelector('#toast');
const calendarModal = document.querySelector('#calendarModal');
const calendarMount = document.querySelector('#calendarMount');
const calendarClose = document.querySelector('#calendarClose');
const trashButton = document.querySelector('#trashButton');
const calendarButton = document.querySelector('#calendarButton');
const sideCalendar = document.querySelector('#sideCalendar');
const sideDayEventsPanel = document.querySelector('#sideDayEventsPanel');

// 브라우저 localStorage에 저장할 데이터의 키와 휴지통 보관 기간(30일)이다.
const STORAGE_KEY = 'haru-events-v1';
const TRASH_KEY = 'haru-trash-v1';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFIED_KEY = 'haru-notified-v1';
const CHAT_HISTORY_KEY = 'haru-chat-history-v1';
const dateFmt = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
const shortMonthFmt = new Intl.DateTimeFormat('ko-KR', { month: 'short' });
const weekdayFmt = new Intl.DateTimeFormat('ko-KR', { weekday: 'long' });
const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true });

// 앱이 실행되는 동안 공유하는 일정, 휴지통, 작성 중 데이터와 화면 상태다.
let events = loadEvents();
let trash = loadTrash();
let draft = {};
let editingId = null;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedSidebarDate = null;

// 저장된 일정과 휴지통 데이터를 불러오거나 다시 저장한다.
function loadEvents() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function loadTrash() {
  try {
    const stored = JSON.parse(localStorage.getItem(TRASH_KEY)) || [];
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const current = stored.filter(item => Number(item.deletedAt) > cutoff);
    if (current.length !== stored.length) localStorage.setItem(TRASH_KEY, JSON.stringify(current));
    return current;
  } catch { return []; }
}

function saveTrash() {
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  trash = trash.filter(item => Number(item.deletedAt) > cutoff);
  try { localStorage.setItem(TRASH_KEY, JSON.stringify(trash)); }
  catch (error) { console.warn('휴지통을 저장하지 못했습니다.', error); }
  updateTrashCount();
}

function updateTrashCount() {
  const count = document.querySelector('#trashCount');
  if (count) count.textContent = String(trash.length);
}

function saveEvents() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch (error) {
    console.warn('일정을 브라우저 저장소에 저장하지 못했습니다.', error);
  }
  updateToday();
}

// 사용자가 선택한 알림 시점을 실제 날짜·시간으로 변환하고 알림을 확인한다.
function parseReminder(label) {
  const match = String(label).trim().match(/^(?:(\d+)\s*일\s*)?(?:(\d+)\s*시간\s*)?(?:(\d+)\s*분\s*)?전$/);
  if (!match || !match.slice(1).some(value => value !== undefined)) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const offset = days * 86400000 + hours * 3600000 + minutes * 60000;
  if (offset < 1) return null;
  return { days, hours, minutes, offset };
}

function reminderOffset(label) {
  return parseReminder(label)?.offset ?? null;
}

function reminderAt(event) {
  if (event.reminder === '알림 없음') return null;
  const offset = reminderOffset(event.reminder);
  if (offset !== null) return parseLocal(event.date, event.time).getTime() - offset;
  const absoluteTime = String(event.reminder).match(/^시각 (\d{2}:\d{2})$/);
  return absoluteTime ? parseLocal(event.date, absoluteTime[1]).getTime() : null;
}

function notificationId(event) {
  return `${event.id}:${event.date}:${event.time}:${event.reminder}`;
}

async function enableNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try { await Notification.requestPermission(); } catch { /* 브라우저가 알림 요청을 지원하지 않는 경우 */ }
}

function checkReminders() {
  const now = Date.now();
  let notified;
  try {
    notified = new Set(JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'));
  } catch {
    notified = new Set();
  }
  let changed = false;

  events.forEach(event => {
    const eventAt = parseLocal(event.date, event.time).getTime();
    const notifyAt = reminderAt(event);
    if (notifyAt === null || notifyAt >= eventAt) return;
    const id = notificationId(event);
    if (now >= notifyAt && now < eventAt && !notified.has(id)) {
      const body = `${dateFmt.format(parseLocal(event.date))} ${timeFmt.format(parseLocal(event.date, event.time))}`;
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`일정 알림 · ${event.title}`, { body, tag: id });
      } else {
        showToast(`🔔 곧 “${event.title}” 일정이 있어요`);
      }
      notified.add(id);
      changed = true;
    }
  });

  if (changed) {
    try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified])); }
    catch { /* 저장소를 사용할 수 없어도 화면 동작은 계속한다. */ }
  }
}

// 날짜와 시간을 브라우저의 현지 시간 기준 문자열로 변환한다.
function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localTimeValue(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseLocal(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, min);
}

// 사이드 패널의 오늘 날짜와 오늘 일정 개수를 최신 상태로 표시한다.
function updateToday() {
  const now = new Date();
  document.querySelector('#sideMonth').textContent = `${now.getMonth() + 1}월`;
  document.querySelector('#sideDay').textContent = String(now.getDate()).padStart(2, '0');
  document.querySelector('#sideWeekday').textContent = weekdayFmt.format(now);
  document.querySelector('#todayCount').textContent = events.filter(e => e.date === localDateKey()).length;
  renderSidebarCalendar();
  if (selectedSidebarDate) {
    renderSidebarDayEvents(selectedSidebarDate, events.filter(event => event.date === selectedSidebarDate));
  }
}

// 채팅 메시지를 저장·복원하고 화면에 말풍선을 생성한다.
function saveChatMessage(text, type) {
  try {
    const history = JSON.parse(sessionStorage.getItem(CHAT_HISTORY_KEY) || '[]');
    history.push({ text, type });
    sessionStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(history.slice(-100)));
  } catch { /* 대화 저장이 불가능해도 현재 대화는 계속한다. */ }
}

function addMessage(text, type = 'bot', persist = true) {
  const row = document.createElement('div');
  row.className = `message-row ${type}`;
  if (type === 'bot') {
    const avatar = document.createElement('span');
    avatar.className = 'bot-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = '✦';
    row.appendChild(avatar);
  }
  const stack = document.createElement('div');
  stack.className = 'message-stack';
  if (type === 'bot') {
    const speaker = document.createElement('p');
    speaker.className = 'speaker';
    speaker.textContent = '일정관리챗봇';
    stack.appendChild(speaker);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = text;
  stack.appendChild(bubble);
  row.appendChild(stack);
  chat.appendChild(row);
  if (persist) saveChatMessage(text, type);
  scrollBottom();
}

function restoreChatHistory() {
  try {
    const history = JSON.parse(sessionStorage.getItem(CHAT_HISTORY_KEY) || '[]');
    history.forEach(message => addMessage(message.text, message.type, false));
  } catch {
    sessionStorage.removeItem(CHAT_HISTORY_KEY);
  }
}

function addConversationDivider() {
  if (!chat.children.length) return;
  const divider = document.createElement('div');
  divider.className = 'conversation-divider';
  divider.innerHTML = '<span>새 대화</span>';
  chat.appendChild(divider);
}

// 챗봇의 선택지 버튼을 만들고 선택 결과에 맞는 다음 동작을 실행한다.
function choices(items) {
  disableInputs();
  const wrap = document.createElement('div');
  wrap.className = 'choices active-input';
  items.forEach(({ label, action, className = '' }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `choice ${className}`;
    button.textContent = label;
    button.addEventListener('click', () => {
      [...wrap.querySelectorAll('button')].forEach(b => b.disabled = true);
      addMessage(label, 'user');
      try {
        action();
      } catch (error) {
        recoverFromError(error);
      }
    }, { once: true });
    wrap.appendChild(button);
  });
  chat.appendChild(wrap);
  scrollBottom();
}

function recoverFromError(error) {
  console.error('일정 처리 중 오류가 발생했습니다.', error);
  addMessage('처리 중 문제가 생겼어요. 입력 내용은 그대로 두고 다시 시도할 수 있어요.');
  choices([
    { label: '다시 시작', action: beginAdd, className: 'primary' },
    { label: '처음으로', action: start }
  ]);
}

function askInput({ type = 'text', placeholder = '', min = '', value = '', validate, submit: onSubmit, secondaryLabel = '', secondaryAction }) {
  disableInputs();
  const form = document.createElement('form');
  form.className = 'text-form active-input';
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  input.min = min;
  input.value = value;
  input.required = true;
  input.setAttribute('aria-label', placeholder || '값 입력');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '확인';
  form.append(input, button);
  let secondaryButton = null;
  if (secondaryLabel && secondaryAction) {
    secondaryButton = document.createElement('button');
    secondaryButton.type = 'button';
    secondaryButton.className = 'secondary';
    secondaryButton.textContent = secondaryLabel;
    form.appendChild(secondaryButton);
  }
  let completed = false;
  let composing = false;
  let pendingSubmit = false;

  const commit = () => {
    if (completed) return;
    if (composing) {
      pendingSubmit = true;
      return;
    }

    const raw = input.value.trim();
    if (!raw || !input.checkValidity()) {
      input.reportValidity();
      input.focus();
      return;
    }

    const validationMessage = validate?.(raw);
    if (validationMessage) {
      showToast(validationMessage);
      input.focus();
      input.select();
      return;
    }

    completed = true;
    input.disabled = button.disabled = true;
    if (secondaryButton) secondaryButton.disabled = true;
    addMessage(formatInputValue(raw, type), 'user');
    try {
      onSubmit(raw);
    } catch (error) {
      recoverFromError(error);
    }
  };

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (pendingSubmit) {
      pendingSubmit = false;
      setTimeout(commit, 0);
    }
  });

  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.isComposing || composing) {
      pendingSubmit = true;
      return;
    }
    commit();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    commit();
  });
  button.addEventListener('click', commit);
  secondaryButton?.addEventListener('click', () => {
    if (completed) return;
    completed = true;
    input.disabled = button.disabled = secondaryButton.disabled = true;
    addMessage(secondaryLabel, 'user');
    try {
      secondaryAction();
    } catch (error) {
      recoverFromError(error);
    }
  });
  chat.appendChild(form);
  scrollBottom();
  setTimeout(() => input.focus(), 100);
}

function formatInputValue(value, type) {
  if (type === 'date') return dateFmt.format(parseLocal(value));
  if (type === 'time') return timeFmt.format(parseLocal(localDateKey(), value));
  if (type === 'number') return `${escapeHtml(value)}분 전`;
  return escapeHtml(value);
}

function disableInputs() {
  chat.querySelectorAll('.active-input input, .active-input button').forEach(el => el.disabled = true);
  chat.querySelectorAll('.active-input').forEach(el => el.classList.remove('active-input'));
}

function scrollBottom() { requestAnimationFrame(() => chat.scrollTop = chat.scrollHeight); }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }

// 대화를 초기 상태로 되돌리고 메인 메뉴를 표시한다.
function start() {
  disableInputs();
  addConversationDivider();
  draft = {};
  editingId = null;
  addMessage('무엇을 도와드릴까요?');
  showMainMenu();
}

function showMainMenu() {
  choices([
    { label: '＋ 일정 추가', action: beginAdd, className: 'primary' },
    { label: '✎ 일정 수정', action: () => showEvents('edit') },
    { label: '− 일정 삭제', action: () => showEvents('delete') }
  ]);
}

// 왼쪽의 작은 월간 달력과 선택한 날짜의 일정 목록을 그린다.
function renderSidebarCalendar() {
  if (!sideCalendar) return;
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  sideCalendar.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'side-calendar-header';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.setAttribute('aria-label', '이전 달');
  previous.textContent = '‹';
  const title = document.createElement('strong');
  title.textContent = `${year}년 ${month + 1}월`;
  const next = document.createElement('button');
  next.type = 'button';
  next.setAttribute('aria-label', '다음 달');
  next.textContent = '›';
  header.append(previous, title, next);
  sideCalendar.appendChild(header);

  previous.addEventListener('click', () => {
    calendarCursor = new Date(year, month - 1, 1);
    selectedSidebarDate = null;
    renderSidebarCalendar();
    clearSidebarDayEvents();
  });
  next.addEventListener('click', () => {
    calendarCursor = new Date(year, month + 1, 1);
    selectedSidebarDate = null;
    renderSidebarCalendar();
    clearSidebarDayEvents();
  });

  const grid = document.createElement('div');
  grid.className = 'side-calendar-grid';
  ['일', '월', '화', '수', '목', '금', '토'].forEach((weekday, index) => {
    const label = document.createElement('span');
    label.className = `side-weekday${index === 0 ? ' sunday' : ''}${index === 6 ? ' saturday' : ''}`;
    label.textContent = weekday;
    grid.appendChild(label);
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let index = 0; index < firstDay; index += 1) {
    const blank = document.createElement('span');
    blank.className = 'side-day blank';
    grid.appendChild(blank);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const dateKey = localDateKey(date);
    const dayEvents = events.filter(event => event.date === dateKey);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'side-day';
    if (dateKey === localDateKey()) button.classList.add('today');
    if (dateKey === selectedSidebarDate) button.classList.add('selected');
    if (dayEvents.length) button.classList.add('has-events');
    const dayNumber = document.createElement('span');
    dayNumber.className = 'side-day-number';
    dayNumber.textContent = String(day);
    button.appendChild(dayNumber);
    if (dayEvents.length) {
      const count = document.createElement('span');
      count.className = 'side-day-count';
      count.textContent = String(dayEvents.length);
      button.appendChild(count);
    }
    button.setAttribute('aria-label', `${month + 1}월 ${day}일, 일정 ${dayEvents.length}개`);
    button.addEventListener('click', () => {
      selectedSidebarDate = dateKey;
      renderSidebarCalendar();
      renderSidebarDayEvents(dateKey, dayEvents);
    });
    grid.appendChild(button);
  }
  sideCalendar.appendChild(grid);
}

function renderSidebarDayEvents(dateKey, dayEvents) {
  const section = sideDayEventsPanel;
  if (!section) return;
  section.innerHTML = '';
  const heading = document.createElement('strong');
  heading.className = 'side-day-events-heading';
  heading.textContent = `${dateFmt.format(parseLocal(dateKey))} 일정 ${dayEvents.length}개`;
  section.appendChild(heading);

  if (!dayEvents.length) {
    const empty = document.createElement('p');
    empty.className = 'side-day-events-empty';
    empty.textContent = '일정이 없습니다.';
    section.appendChild(empty);
  } else {
    dayEvents
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time))
      .forEach(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'side-event-item';
        const time = document.createElement('span');
        time.className = 'side-event-time';
        time.textContent = timeFmt.format(parseLocal(item.date, item.time));
        const title = document.createElement('span');
        title.className = 'side-event-title';
        title.textContent = item.title;
        button.append(time, title);
        button.addEventListener('click', () => {
          addMessage(item.title, 'user');
          viewEvent(item);
        });
        section.appendChild(button);
      });
  }

}

function clearSidebarDayEvents() {
  if (!sideDayEventsPanel) return;
  sideDayEventsPanel.innerHTML = '<p class="side-day-events-empty">캘린더에서 날짜를 선택하세요.</p>';
}

// 휴지통 목록을 보여 주고 선택 복원 또는 영구 삭제를 처리한다.
function showTrash() {
  trash = loadTrash();
  updateTrashCount();
  addMessage(trash.length ? '휴지통의 일정입니다. 삭제 후 30일 동안 보관됩니다.' : '휴지통이 비어 있습니다.');
  if (!trash.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '복원할 일정이 없습니다.';
    chat.appendChild(empty);
    choices([{ label: '메뉴로', action: () => returnToMenu() }]);
    return;
  }

  disableInputs();
  const list = document.createElement('div');
  list.className = 'event-list trash-list';
  const selectAllLabel = document.createElement('label');
  selectAllLabel.className = 'select-all-row';
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  const selectAllText = document.createElement('span');
  selectAllText.textContent = '전체 선택';
  selectAllLabel.append(selectAll, selectAllText);
  list.appendChild(selectAllLabel);
  const checkboxes = [];

  [...trash].sort((a, b) => b.deletedAt - a.deletedAt).forEach(item => {
    const date = parseLocal(item.date, item.time);
    const row = document.createElement('div');
    row.className = 'trash-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'trash-checkbox';
    checkbox.setAttribute('aria-label', `${item.title} 선택`);
    const card = document.createElement('div');
    card.className = 'event-card trash-event-card';
    const daysLeft = Math.max(0, Math.ceil((Number(item.deletedAt) + TRASH_RETENTION_MS - Date.now()) / 86400000));
    card.innerHTML = `<span class="event-date">${shortMonthFmt.format(date)}<b>${String(date.getDate()).padStart(2, '0')}</b></span><span class="event-info"><strong>${escapeHtml(item.title)}</strong><span>${timeFmt.format(date)} · ${daysLeft}일 후 자동 삭제</span></span>`;
    row.append(checkbox, card);
    list.appendChild(row);
    checkboxes.push({ checkbox, id: item.id });
  });

  const bulkControls = document.createElement('div');
  bulkControls.className = 'trash-bulk-controls';
  const bulkRestore = document.createElement('button');
  bulkRestore.type = 'button';
  bulkRestore.className = 'restore-selected-button';
  bulkRestore.textContent = '선택한 일정 복원';
  bulkRestore.disabled = true;
  const bulkDelete = document.createElement('button');
  bulkDelete.type = 'button';
  bulkDelete.className = 'permanent-delete-button';
  bulkDelete.textContent = '선택한 일정 영구 삭제';
  bulkDelete.disabled = true;
  bulkControls.append(bulkRestore, bulkDelete);

  const updateSelection = () => {
    const selected = checkboxes.filter(item => item.checkbox.checked).length;
    selectAll.checked = selected === checkboxes.length;
    selectAll.indeterminate = selected > 0 && selected < checkboxes.length;
    bulkRestore.disabled = selected === 0;
    bulkRestore.textContent = selected ? `선택한 ${selected}개 복원` : '선택한 일정 복원';
    bulkDelete.disabled = selected === 0;
    bulkDelete.textContent = selected ? `선택한 ${selected}개 영구 삭제` : '선택한 일정 영구 삭제';
  };
  selectAll.addEventListener('change', () => {
    checkboxes.forEach(item => { item.checkbox.checked = selectAll.checked; });
    updateSelection();
  });
  checkboxes.forEach(item => item.checkbox.addEventListener('change', updateSelection));
  bulkRestore.addEventListener('click', () => {
    const ids = checkboxes.filter(item => item.checkbox.checked).map(item => item.id);
    if (ids.length) restoreEvents(ids);
  });
  bulkDelete.addEventListener('click', () => {
    const ids = checkboxes.filter(item => item.checkbox.checked).map(item => item.id);
    if (!ids.length) return;
    list.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
    confirmPermanentDeleteMultiple(ids);
  });

  chat.append(list, bulkControls);
  choices([{ label: '메뉴로', action: () => returnToMenu() }]);
  scrollBottom();
}

function restoreEvents(ids) {
  const idSet = new Set(ids);
  const selected = trash.filter(event => idSet.has(event.id));
  if (!selected.length) return;
  const restored = selected.map(({ deletedAt, ...event }) => event);
  trash = trash.filter(event => !idSet.has(event.id));
  events.push(...restored);
  events.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  saveTrash();
  saveEvents();
  showToast(`${restored.length}개 일정을 복원했어요`);
  showTrash();
}

function confirmPermanentDeleteMultiple(ids) {
  const count = ids.filter(id => trash.some(event => event.id === id)).length;
  if (!count) return;
  addMessage(`선택한 일정 ${count}개를 영구 삭제할까요? 삭제하면 복원할 수 없습니다.`);
  choices([
    { label: `${count}개 영구 삭제`, action: () => permanentlyDeleteEvents(ids), className: 'danger' },
    { label: '취소', action: showTrash }
  ]);
}

function permanentlyDeleteEvents(ids) {
  const idSet = new Set(ids);
  const count = trash.filter(event => idSet.has(event.id)).length;
  if (!count) return;
  trash = trash.filter(event => !idSet.has(event.id));
  saveTrash();
  showToast(`${count}개 일정을 영구 삭제했어요`);
  showTrash();
}

// 전체 달력 모달을 열고 해당 월의 날짜와 일정을 표시한다.
function showCalendar(month = calendarCursor) {
  calendarCursor = new Date(month.getFullYear(), month.getMonth(), 1);
  disableInputs();
  const panel = document.createElement('section');
  panel.className = 'calendar-panel modal-calendar active-input';
  panel.setAttribute('aria-label', '월간 일정 캘린더');
  calendarMount.innerHTML = '';
  calendarMount.appendChild(panel);
  calendarModal.hidden = false;
  document.body.classList.add('modal-open');
  renderCalendar(panel);
  calendarClose.focus();
}

function closeCalendar() {
  calendarModal.hidden = true;
  document.body.classList.remove('modal-open');
  calendarMount.innerHTML = '';
}

function renderCalendar(panel) {
  panel.innerHTML = '';
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();

  const header = document.createElement('div');
  header.className = 'calendar-header';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'calendar-nav';
  previous.setAttribute('aria-label', '이전 달');
  previous.textContent = '‹';
  const title = document.createElement('strong');
  title.textContent = `${year}년 ${month + 1}월`;
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'calendar-nav';
  next.setAttribute('aria-label', '다음 달');
  next.textContent = '›';
  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'calendar-menu';
  menu.textContent = '메뉴로';
  header.append(previous, title, next, menu);
  panel.appendChild(header);

  previous.addEventListener('click', () => {
    calendarCursor = new Date(year, month - 1, 1);
    renderCalendar(panel);
  });
  next.addEventListener('click', () => {
    calendarCursor = new Date(year, month + 1, 1);
    renderCalendar(panel);
  });
  menu.addEventListener('click', () => {
    closeCalendar();
    returnToMenu();
  });

  const weekdays = document.createElement('div');
  weekdays.className = 'calendar-weekdays';
  ['일', '월', '화', '수', '목', '금', '토'].forEach(day => {
    const label = document.createElement('span');
    label.textContent = day;
    weekdays.appendChild(label);
  });
  panel.appendChild(weekdays);

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstWeekday; i += 1) {
    const blank = document.createElement('span');
    blank.className = 'calendar-day blank';
    grid.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const dateKey = localDateKey(date);
    const dayEvents = events.filter(event => event.date === dateKey);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'calendar-day';
    if (dateKey === localDateKey()) cell.classList.add('today');
    if (dayEvents.length) cell.classList.add('has-events');
    cell.setAttribute('aria-label', `${month + 1}월 ${day}일, 일정 ${dayEvents.length}개`);

    const number = document.createElement('span');
    number.className = 'calendar-number';
    number.textContent = day;
    cell.appendChild(number);

    if (dayEvents.length) {
      const count = document.createElement('span');
      count.className = 'calendar-count-badge';
      count.textContent = String(dayEvents.length);
      cell.appendChild(count);
    }

    const preview = document.createElement('span');
    preview.className = 'calendar-events';
    dayEvents.slice(0, 2).forEach(event => {
      const item = document.createElement('span');
      item.textContent = event.title;
      preview.appendChild(item);
    });
    if (dayEvents.length > 2) {
      const more = document.createElement('small');
      more.textContent = `+${dayEvents.length - 2}`;
      preview.appendChild(more);
    }
    cell.appendChild(preview);

    cell.addEventListener('click', () => {
      if (!dayEvents.length) {
        showToast('등록된 일정이 없습니다');
        return;
      }
      showDayEvents(dateKey, dayEvents);
    });
    grid.appendChild(cell);
  }
  panel.appendChild(grid);
}

function showDayEvents(dateKey, dayEvents) {
  closeCalendar();
  disableInputs();
  const date = parseLocal(dateKey);
  addMessage(`${dateFmt.format(date)} 일정 ${dayEvents.length}개`, 'user');
  addMessage('확인할 일정을 선택해 주세요.');

  const list = document.createElement('div');
  list.className = 'event-list';
  dayEvents.forEach(item => {
    const eventDate = parseLocal(item.date, item.time);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'event-card';
    card.innerHTML = `<span class="event-date">${shortMonthFmt.format(eventDate)}<b>${String(eventDate.getDate()).padStart(2, '0')}</b></span><span class="event-info"><strong>${escapeHtml(item.title)}</strong><span>${timeFmt.format(eventDate)} · ${escapeHtml(item.reminder)}</span></span><span>›</span>`;
    card.addEventListener('click', () => {
      [...list.querySelectorAll('button')].forEach(button => { button.disabled = true; });
      addMessage(item.title, 'user');
      viewEvent(item);
    }, { once: true });
    list.appendChild(card);
  });
  chat.appendChild(list);
  choices([
    { label: '캘린더로', action: () => showCalendar(calendarCursor), className: 'primary' },
    { label: '메뉴로', action: () => returnToMenu() }
  ]);
  scrollBottom();
}

function returnToMenu(message = '메뉴를 선택해 주세요.') {
  addMessage(message);
  showMainMenu();
}

// 새 일정의 제목, 날짜, 시간, 알림을 차례로 입력받는 흐름을 시작한다.
function beginAdd() {
  draft = {};
  addMessage('<strong>일정 제목</strong>을 입력해 주세요.');
  askInput({ submit: value => { draft.title = value; askDate(); } });
}

function askDate() {
  addMessage('날짜를 직접 선택해 주세요.');
  askInput({ type: 'date', min: localDateKey(), value: draft.date || localDateKey(), submit: value => { draft.date = value; askTime(); } });
}

function askTime() {
  addMessage('시간을 선택해 주세요.');
  askTimeSelection(draft.time || localTimeValue(), value => {
    draft.time = value;
    askReminder();
  });
}

function askTimeSelection(initialValue, onSubmit) {
  disableInputs();
  const [initialHour, initialMinute] = initialValue.split(':').map(Number);
  const form = document.createElement('form');
  form.className = 'time-picker-form active-input';
  const hour = document.createElement('select');
  hour.setAttribute('aria-label', '시 선택');
  for (let value = 0; value <= 23; value += 1) {
    const option = document.createElement('option');
    option.value = String(value).padStart(2, '0');
    option.textContent = String(value).padStart(2, '0');
    hour.appendChild(option);
  }
  hour.value = String(initialHour).padStart(2, '0');

  const separator = document.createElement('span');
  separator.className = 'time-picker-separator';
  separator.textContent = ':';
  const minute = document.createElement('select');
  minute.setAttribute('aria-label', '분 선택');
  for (let value = 0; value <= 59; value += 1) {
    const option = document.createElement('option');
    option.value = String(value).padStart(2, '0');
    option.textContent = String(value).padStart(2, '0');
    minute.appendChild(option);
  }
  minute.value = String(initialMinute).padStart(2, '0');

  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.textContent = '확인';
  form.append(hour, separator, minute, confirm);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (form.dataset.done) return;
    form.dataset.done = 'true';
    form.querySelectorAll('select, button').forEach(control => { control.disabled = true; });
    const value = `${hour.value}:${minute.value}`;
    addMessage(timeFmt.format(parseLocal(localDateKey(), value)), 'user');
    try { onSubmit(value); } catch (error) { recoverFromError(error); }
  });
  chat.appendChild(form);
  scrollBottom();
}

function askReminder() {
  addMessage('일정 전에 알림을 받을 시간을 선택해 주세요.');
  disableInputs();
  const previous = parseReminder(draft.reminder || '');
  const form = document.createElement('form');
  form.className = 'reminder-form active-input';
  const fields = [
    { key: 'days', label: '일', max: 30, value: previous?.days ?? 0 },
    { key: 'hours', label: '시', max: 23, value: previous?.hours ?? 0 },
    { key: 'minutes', label: '분', max: 59, value: previous?.minutes ?? 10 }
  ];
  const selects = {};
  fields.forEach(field => {
    const label = document.createElement('label');
    label.className = 'reminder-field';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${field.label} 선택`);
    for (let value = 0; value <= field.max; value += 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.appendChild(option);
    }
    select.value = String(field.value);
    const unit = document.createElement('span');
    unit.textContent = field.label;
    label.append(select, unit);
    form.appendChild(label);
    selects[field.key] = select;
  });
  const confirmButton = document.createElement('button');
  confirmButton.type = 'submit';
  confirmButton.className = 'reminder-confirm';
  confirmButton.textContent = '확인';
  const noneButton = document.createElement('button');
  noneButton.type = 'button';
  noneButton.className = 'reminder-none';
  noneButton.textContent = '알림 없음';
  form.append(confirmButton, noneButton);

  const commit = noReminder => {
    if (form.dataset.done) return;
    const values = {
      days: Number(selects.days.value),
      hours: Number(selects.hours.value),
      minutes: Number(selects.minutes.value)
    };
    if (!noReminder && values.days + values.hours + values.minutes === 0) {
      showToast('알림 시간을 1 이상 선택해 주세요');
      return;
    }
    form.dataset.done = 'true';
    form.querySelectorAll('select, button').forEach(element => { element.disabled = true; });
    if (noReminder) {
      draft.reminder = '알림 없음';
      addMessage('알림 없음', 'user');
    } else {
      const parts = [];
      if (values.days) parts.push(`${values.days}일`);
      if (values.hours) parts.push(`${values.hours}시간`);
      if (values.minutes) parts.push(`${values.minutes}분`);
      draft.reminder = `${parts.join(' ')} 전`;
      addMessage(draft.reminder, 'user');
    }
    confirmDraft();
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    commit(false);
  });
  noneButton.addEventListener('click', () => commit(true));
  chat.appendChild(form);
  scrollBottom();
}

function eventSummary(event) {
  const when = parseLocal(event.date, event.time);
  return `<strong>${dateFmt.format(when)} ${timeFmt.format(when)}</strong><br>‘${escapeHtml(event.title)}’`;
}

function confirmDraft() {
  addMessage(`${eventSummary(draft)} 일정을 ${editingId ? '수정' : '등록'}할까요?`);
  choices([
    { label: editingId ? '수정 완료' : '등록', action: saveDraft, className: 'primary' },
    { label: '내용 수정', action: reviseDraft },
    { label: '취소', action: () => returnToMenu('알겠어요. 요청을 취소했어요.'), className: 'danger' }
  ]);
}

function reviseDraft() {
  addMessage('어떤 내용을 수정할까요?');
  choices([
    { label: '제목', action: () => { addMessage('새 제목을 입력해 주세요.'); askInput({ placeholder: '일정 제목', value: draft.title, submit: v => { draft.title = v; confirmDraft(); } }); } },
    { label: '날짜', action: askCustomDateForRevision },
    { label: '시간', action: askCustomTimeForRevision },
    { label: '알림', action: askReminder }
  ]);
}

function askCustomDateForRevision() {
  addMessage('새 날짜를 선택해 주세요.');
  askInput({ type: 'date', value: draft.date, submit: v => { draft.date = v; confirmDraft(); } });
}

function askCustomTimeForRevision() {
  addMessage('새 시간을 선택해 주세요.');
  askTimeSelection(draft.time, value => {
    draft.time = value;
    confirmDraft();
  });
}

// 확인이 끝난 새 일정 또는 수정된 일정을 저장한다.
function saveDraft() {
  if (editingId) {
    const index = events.findIndex(e => e.id === editingId);
    if (index >= 0) events[index] = { ...draft, id: editingId };
  } else {
    const id = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    events.push({ ...draft, id });
  }
  events.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  saveEvents();
  showToast(editingId ? '일정을 수정했어요' : '일정을 등록했어요');
  const verb = editingId ? '수정' : '등록';
  editingId = null;
  returnToMenu(`완료! 일정이 <strong>${verb}</strong>되었어요.<br><small>🔔 ${escapeHtml(draft.reminder)}</small>`);
  checkReminders();
}

// 일정 조회 모드에 맞게 목록을 정렬하여 표시한다.
function showEvents(mode) {
  if (mode === 'delete') {
    showDeleteEvents();
    return;
  }

  const labels = { view: '확인할', edit: '수정할', delete: '삭제할' };
  addMessage(events.length ? `${labels[mode]} 일정을 선택해 주세요.` : '아직 등록된 일정이 없어요.');
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '새로운 일정을 먼저 등록해 보세요.';
    chat.appendChild(empty);
    choices([{ label: '＋ 일정 추가', action: beginAdd, className: 'primary' }, { label: '처음으로', action: start }]);
    return;
  }
  disableInputs();
  const list = document.createElement('div');
  list.className = 'event-list';
  events.forEach(item => {
    const date = parseLocal(item.date, item.time);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'event-card';
    card.innerHTML = `<span class="event-date">${shortMonthFmt.format(date)}<b>${String(date.getDate()).padStart(2, '0')}</b></span><span class="event-info"><strong>${escapeHtml(item.title)}</strong><span>${timeFmt.format(date)} · ${escapeHtml(item.reminder)}</span></span><span>›</span>`;
    card.addEventListener('click', () => {
      [...list.querySelectorAll('button')].forEach(b => b.disabled = true);
      addMessage(item.title, 'user');
      if (mode === 'view') viewEvent(item);
      if (mode === 'edit') editEvent(item);
    }, { once: true });
    list.appendChild(card);
  });
  chat.appendChild(list);
  choices([{ label: '취소', action: () => returnToMenu('취소되었습니다.') }]);
  scrollBottom();
}

// 여러 일정을 선택해 한 번에 휴지통으로 보내는 화면을 만든다.
function showDeleteEvents() {
  addMessage(events.length ? '삭제할 일정을 선택해 주세요.' : '삭제할 일정이 없습니다.');
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '등록된 일정이 없습니다.';
    chat.appendChild(empty);
    choices([{ label: '메뉴로', action: () => returnToMenu() }]);
    return;
  }

  disableInputs();
  const list = document.createElement('div');
  list.className = 'event-list delete-event-list active-input';
  const selectAllLabel = document.createElement('label');
  selectAllLabel.className = 'select-all-row';
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  const selectAllText = document.createElement('span');
  selectAllText.textContent = '전체 선택';
  selectAllLabel.append(selectAll, selectAllText);
  list.appendChild(selectAllLabel);

  const checkboxes = [];
  const controls = document.createElement('div');
  controls.className = 'delete-controls active-input';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete-selected-button';
  deleteButton.textContent = '선택한 일정 삭제';
  deleteButton.disabled = true;
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'cancel-selection-button';
  cancelButton.textContent = '취소';
  controls.append(deleteButton, cancelButton);

  const updateSelection = () => {
    const selected = checkboxes.filter(box => box.input.checked).length;
    selectAll.checked = selected === checkboxes.length;
    selectAll.indeterminate = selected > 0 && selected < checkboxes.length;
    deleteButton.disabled = selected === 0;
    deleteButton.textContent = selected ? `선택한 ${selected}개 삭제` : '선택한 일정 삭제';
  };

  events.forEach(item => {
    const date = parseLocal(item.date, item.time);
    const row = document.createElement('label');
    row.className = 'delete-event-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = item.id;
    input.addEventListener('change', updateSelection);
    const card = document.createElement('span');
    card.className = 'event-card';
    card.innerHTML = `<span class="event-date">${shortMonthFmt.format(date)}<b>${String(date.getDate()).padStart(2, '0')}</b></span><span class="event-info"><strong>${escapeHtml(item.title)}</strong><span>${timeFmt.format(date)} · ${escapeHtml(item.reminder)}</span></span>`;
    row.append(input, card);
    list.appendChild(row);
    checkboxes.push({ input, id: item.id });
  });

  chat.append(list, controls);
  selectAll.addEventListener('change', () => {
    checkboxes.forEach(({ input }) => { input.checked = selectAll.checked; });
    updateSelection();
  });
  deleteButton.addEventListener('click', () => {
    const ids = checkboxes.filter(box => box.input.checked).map(box => box.id);
    if (ids.length) confirmDeleteMultiple(ids);
  });
  cancelButton.addEventListener('click', () => returnToMenu('취소되었습니다.'));
  scrollBottom();
}

// 일정 상세 보기, 수정, 삭제 동작을 처리한다.
function viewEvent(item) {
  addMessage(`${eventSummary(item)}<br><br>🔔 ${escapeHtml(item.reminder)}에 알려드려요.`);
  choices([
    { label: '수정하기', action: () => editEvent(item), className: 'primary' },
    { label: '삭제하기', action: () => confirmDelete(item), className: 'danger' },
    { label: '캘린더로', action: () => showCalendar(calendarCursor) }
  ]);
}

function editEvent(item) {
  editingId = item.id;
  draft = { title: item.title, date: item.date, time: item.time, reminder: item.reminder };
  addMessage('어떤 내용을 수정할까요?');
  choices([
    { label: '제목', action: () => { addMessage('새 제목을 입력해 주세요.'); askInput({ placeholder: '일정 제목', value: draft.title, submit: v => { draft.title = v; confirmDraft(); } }); }, className: 'primary' },
    { label: '날짜', action: askCustomDateForRevision },
    { label: '시간', action: askCustomTimeForRevision },
    { label: '알림', action: askReminder },
    { label: '취소', action: () => returnToMenu('수정을 취소했어요.') }
  ]);
}

function confirmDelete(item) {
  addMessage(`${eventSummary(item)} 일정을 정말 삭제할까요?`);
  choices([
    { label: '삭제', action: () => deleteEvent(item.id), className: 'danger' },
    { label: '취소', action: () => returnToMenu('삭제하지 않았어요.') }
  ]);
}

function confirmDeleteMultiple(ids) {
  const selected = events.filter(event => ids.includes(event.id));
  addMessage(`선택한 일정 ${selected.length}개를 삭제할까요?`);
  choices([
    { label: `${selected.length}개 삭제`, action: () => deleteEvents(ids), className: 'danger' },
    { label: '취소', action: () => showDeleteEvents() }
  ]);
}

function deleteEvents(ids) {
  const idSet = new Set(ids);
  const deletedAt = Date.now();
  const removed = events.filter(event => idSet.has(event.id));
  trash.push(...removed.map(event => ({ ...event, deletedAt })));
  events = events.filter(event => !idSet.has(event.id));
  saveTrash();
  saveEvents();
  showToast(`${ids.length}개 일정을 삭제했어요`);
  returnToMenu(`일정 ${ids.length}개를 삭제했습니다.`);
}

function deleteEvent(id) {
  const removed = events.find(event => event.id === id);
  if (removed) trash.push({ ...removed, deletedAt: Date.now() });
  events = events.filter(e => e.id !== id);
  saveTrash();
  saveEvents();
  showToast('일정을 삭제했어요');
  returnToMenu('일정을 <strong>삭제</strong>했어요.');
}

// 저장·삭제 같은 작업 결과를 화면 아래에 잠시 표시한다.
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// 고정 버튼, 모달 배경, Escape 키에 전역 이벤트를 연결한다.
resetButton.addEventListener('click', start);
trashButton.addEventListener('click', showTrash);
calendarButton.addEventListener('click', () => showCalendar());
calendarClose.addEventListener('click', () => {
  closeCalendar();
  returnToMenu();
});
calendarModal.addEventListener('click', event => {
  if (event.target !== calendarModal) return;
  closeCalendar();
  returnToMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !calendarModal.hidden) {
    closeCalendar();
    returnToMenu();
  }
});
// 첫 화면을 구성한 뒤 30초마다 실행 시간이 된 알림을 확인한다.
updateToday();
updateTrashCount();
restoreChatHistory();
start();
checkReminders();
setInterval(checkReminders, 30000);
