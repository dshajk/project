// Node.js 기본 모듈만 사용해 정적 웹 서버와 SQLite API를 구성한다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { AiError, extractSchedule } from './ai.js';

// 프로젝트와 데이터베이스 경로, 서버 포트, 휴지통 보관 기간을 설정한다.
const rootDirectory = dirname(fileURLToPath(import.meta.url));
try { loadEnvFile(join(rootDirectory, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const dataDirectory = join(rootDirectory, 'data');
const databasePath = join(dataDirectory, 'schedule.db');
const port = Number(process.env.PORT ?? 3000);
const trashRetentionMs = 30 * 24 * 60 * 60 * 1000;

// data 폴더가 없으면 만든 뒤 SQLite 데이터베이스를 연다.
mkdirSync(dataDirectory, { recursive: true });

const database = new DatabaseSync(databasePath, { timeout: 5000 });
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
// 최초 실행 시 일정 테이블과 조회 성능을 위한 인덱스를 자동 생성한다.
// deleted_at이 NULL이면 일반 일정이고, 값이 있으면 휴지통에 있는 일정이다.
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS state_version (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
  INSERT OR IGNORE INTO state_version (id, revision) VALUES (1, 0);

  CREATE TABLE IF NOT EXISTS schedule_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    reminder TEXT NOT NULL,
    deleted_at INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_schedule_events_date
  ON schedule_events(date, time);

  CREATE INDEX IF NOT EXISTS idx_schedule_events_deleted_at
  ON schedule_events(deleted_at);
`);

// 자주 실행하는 SQL을 미리 준비해 같은 쿼리를 안전하고 빠르게 재사용한다.
const selectEvents = database.prepare(`
  SELECT id, title, date, time, reminder, deleted_at
  FROM schedule_events
  ORDER BY date, time
`);
const insertEvent = database.prepare(`
  INSERT INTO schedule_events (id, title, date, time, reminder, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const deleteAllEvents = database.prepare('DELETE FROM schedule_events');
const deleteExpiredTrash = database.prepare(
  'DELETE FROM schedule_events WHERE deleted_at IS NOT NULL AND deleted_at <= ?'
);

// 웹 요청 경로와 실제 파일, 응답 Content-Type을 연결한다.
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

// JavaScript 값을 JSON 문자열로 변환해 공통 응답 헤더와 함께 전송한다.
function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

// 브라우저가 보낸 일정 값을 정리하고 필수값과 날짜 형식을 검사한다.
function normalizeEvent(value, isTrash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('일정 형식이 올바르지 않습니다.');
  for (const key of ['id', 'title', 'date', 'time']) {
    if (typeof value[key] !== 'string') throw new RequestError('일정 필드 형식이 올바르지 않습니다.');
  }

  const event = {
    id: String(value.id || '').trim(),
    title: String(value.title || '').trim(),
    date: String(value.date || ''),
    time: String(value.time || ''),
    reminder: String(value.reminder || '알림 없음')
  };

  if (!event.id || !event.title || event.id.length > 200 || event.title.length > 2000) throw new RequestError('일정 ID와 제목을 확인해 주세요. 제목은 2000자 이내로 입력해 주세요.');
  const date = new Date(`${event.date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== event.date) throw new RequestError('실제 존재하는 날짜를 입력해 주세요.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time)) throw new RequestError('시간 형식이 올바르지 않습니다.');
  const reminder = event.reminder.match(/^(?:(\d+)\s*일\s*)?(?:(\d+)\s*시간\s*)?(?:(\d+)\s*분\s*)?전$/);
  const reminderMinutes = reminder ? Number(reminder[1] || 0) * 1440 + Number(reminder[2] || 0) * 60 + Number(reminder[3] || 0) : 0;
  if (event.reminder !== '알림 없음' && !/^시각 ([01]\d|2[0-3]):[0-5]\d$/.test(event.reminder) && !(reminderMinutes >= 1 && reminderMinutes <= 44639)) throw new RequestError('알림 시간이 올바르지 않습니다.');

  if (isTrash) {
    const deletedAt = Number(value.deletedAt);
    if (typeof value.deletedAt !== 'number' || !Number.isSafeInteger(deletedAt) || deletedAt <= 0 || deletedAt > Date.now() + 60000) throw new RequestError('삭제 시간이 올바르지 않습니다.');
    event.deletedAt = Math.min(deletedAt, Date.now());
  }

  return event;
}

// 만료된 휴지통 데이터를 삭제하고 DB 행을 일반 일정과 휴지통으로 나눠 반환한다.
function readState() {
  if (deleteExpiredTrash.run(Date.now() - trashRetentionMs).changes > 0) {
    database.exec('UPDATE state_version SET revision = revision + 1 WHERE id = 1');
  }
  const events = [];
  const trash = [];

  for (const row of selectEvents.all()) {
    const event = {
      id: row.id,
      title: row.title,
      date: row.date,
      time: row.time,
      reminder: row.reminder
    };
    if (row.deleted_at === null) events.push(event);
    else trash.push({ ...event, deletedAt: Number(row.deleted_at) });
  }

  return { events, trash, revision: database.prepare('SELECT revision FROM state_version WHERE id = 1').get().revision };
}

// 브라우저의 전체 상태로 DB 내용을 교체한다.
// 트랜잭션을 사용하므로 저장 중 오류가 나면 변경 전 상태로 되돌아간다.
function replaceState(value) {
  if (!value || !Array.isArray(value.events) || !Array.isArray(value.trash)) {
    throw new RequestError('저장할 데이터 형식이 올바르지 않습니다.');
  }

  const events = value.events.map(item => normalizeEvent(item, false));
  const trash = value.trash.map(item => normalizeEvent(item, true));
  const ids = new Set();
  for (const event of [...events, ...trash]) {
    if (ids.has(event.id)) throw new RequestError('중복된 일정 ID가 있습니다.');
    ids.add(event.id);
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const revision = database.prepare('SELECT revision FROM state_version WHERE id = 1').get().revision;
    if (value.revision !== revision) throw new RequestError('다른 창에서 일정이 변경됐어요. 새로고침한 뒤 다시 시도해 주세요.', 409);
    deleteAllEvents.run();
    for (const event of events) {
      insertEvent.run(event.id, event.title, event.date, event.time, event.reminder, null);
    }
    for (const event of trash) {
      insertEvent.run(event.id, event.title, event.date, event.time, event.reminder, event.deletedAt);
    }
    database.exec('UPDATE state_version SET revision = revision + 1 WHERE id = 1');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return readState();
}

// PUT 요청 본문을 최대 1MB까지만 읽어 JSON으로 변환한다.
async function readRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RequestError('요청 데이터가 너무 큽니다.', 413);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// API 요청과 정적 파일 요청을 처리하는 HTTP 서버를 만든다.
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const origin = request.headers.origin;
    const listeningPort = server.address().port;
    if (['POST', 'PUT'].includes(request.method) && origin && origin !== `http://127.0.0.1:${listeningPort}` && origin !== `http://localhost:${listeningPort}`) {
      throw new RequestError('현재 일정관리 화면에서 요청해 주세요.', 403);
    }
    // 일정 문장만 AI에 전달한다. 기존 일정이나 DB는 이 경로에서 변경하지 않는다.
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = await readRequestJson(request);
      sendJson(response, 200, { draft: await extractSchedule(body?.message) });
      return;
    }
    // 현재 일정과 휴지통 전체를 조회한다.
    if (url.pathname === '/api/state' && request.method === 'GET') {
      sendJson(response, 200, readState());
      return;
    }

    // 브라우저가 보낸 일정과 휴지통 상태를 SQLite에 저장한다.
    if (url.pathname === '/api/state' && request.method === 'PUT') {
      sendJson(response, 200, replaceState(await readRequestJson(request)));
      return;
    }

    // HTML, JavaScript, CSS 파일을 브라우저에 전달한다.
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [filename, contentType] = staticFiles.get(url.pathname);
      const body = await readFile(join(rootDirectory, filename));
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache'
      });
      response.end(body);
      return;
    }

    // 등록되지 않은 주소에는 JSON 형식의 404 오류를 반환한다.
    sendJson(response, 404, { error: '요청한 경로를 찾을 수 없습니다.' });
  } catch (error) {
    // 잘못된 JSON은 400, 그 밖의 서버·DB 오류는 500으로 처리한다.
    if (!(error instanceof AiError) && !(error instanceof RequestError) && !(error instanceof SyntaxError)) console.error(error);
    const statusCode = error instanceof AiError || error instanceof RequestError ? error.status : error instanceof SyntaxError ? 400 : 500;
    sendJson(response, statusCode, { error: error.message || '서버 오류가 발생했습니다.' });
  }
});

// 같은 포트에서 서버가 이미 실행 중인 경우 이해하기 쉬운 메시지를 표시한다.
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`이미 서버가 실행 중입니다: http://localhost:${port}`);
  } else {
    console.error('서버를 시작하지 못했습니다.', error);
  }
  process.exitCode = 1;
});

// 외부 네트워크에는 공개하지 않고 현재 컴퓨터의 3000번 포트에서만 실행한다.
server.listen(port, '127.0.0.1', () => {
  console.log(`일정관리챗봇: http://localhost:${server.address().port}`);
  console.log(`SQLite: ${databasePath}`);
  if (process.platform === 'win32' && process.argv.includes('--open') && !process.argv.includes('--no-open')) {
    const browser = spawn('explorer.exe', [`http://localhost:${server.address().port}`], {
      windowsHide: true, stdio: 'ignore'
    });
    browser.on('error', () => console.log('브라우저에서 위 주소를 직접 열어 주세요.'));
    browser.unref();
  }
});

// Ctrl+C 또는 종료 신호를 받으면 서버와 DB 연결을 순서대로 안전하게 닫는다.
function closeServer() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
