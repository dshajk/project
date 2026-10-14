// Node.js 기본 모듈만 사용해 정적 웹 서버와 SQLite API를 구성한다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// 프로젝트와 데이터베이스 경로, 서버 포트, 휴지통 보관 기간을 설정한다.
const rootDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(rootDirectory, 'data');
const databasePath = join(dataDirectory, 'schedule.db');
const port = Number(process.env.PORT) || 3000;
const trashRetentionMs = 30 * 24 * 60 * 60 * 1000;

// data 폴더가 없으면 만든 뒤 SQLite 데이터베이스를 연다.
mkdirSync(dataDirectory, { recursive: true });

const database = new DatabaseSync(databasePath, { timeout: 5000 });
// 최초 실행 시 일정 테이블과 조회 성능을 위한 인덱스를 자동 생성한다.
// deleted_at이 NULL이면 일반 일정이고, 값이 있으면 휴지통에 있는 일정이다.
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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
  if (!value || typeof value !== 'object') throw new Error('일정 형식이 올바르지 않습니다.');

  const event = {
    id: String(value.id || '').trim(),
    title: String(value.title || '').trim(),
    date: String(value.date || ''),
    time: String(value.time || ''),
    reminder: String(value.reminder || '알림 없음')
  };

  if (!event.id || !event.title) throw new Error('일정 ID와 제목은 필수입니다.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  if (!/^\d{2}:\d{2}$/.test(event.time)) throw new Error('시간 형식이 올바르지 않습니다.');

  if (isTrash) {
    const deletedAt = Number(value.deletedAt);
    if (!Number.isFinite(deletedAt)) throw new Error('삭제 시간이 올바르지 않습니다.');
    event.deletedAt = deletedAt;
  }

  return event;
}

// 만료된 휴지통 데이터를 삭제하고 DB 행을 일반 일정과 휴지통으로 나눠 반환한다.
function readState() {
  deleteExpiredTrash.run(Date.now() - trashRetentionMs);
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

  return { events, trash };
}

// 브라우저의 전체 상태로 DB 내용을 교체한다.
// 트랜잭션을 사용하므로 저장 중 오류가 나면 변경 전 상태로 되돌아간다.
function replaceState(value) {
  if (!value || !Array.isArray(value.events) || !Array.isArray(value.trash)) {
    throw new Error('저장할 데이터 형식이 올바르지 않습니다.');
  }

  const events = value.events.map(item => normalizeEvent(item, false));
  const trash = value.trash.map(item => normalizeEvent(item, true));
  const ids = new Set();
  for (const event of [...events, ...trash]) {
    if (ids.has(event.id)) throw new Error('중복된 일정 ID가 있습니다.');
    ids.add(event.id);
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    deleteAllEvents.run();
    for (const event of events) {
      insertEvent.run(event.id, event.title, event.date, event.time, event.reminder, null);
    }
    for (const event of trash) {
      insertEvent.run(event.id, event.title, event.date, event.time, event.reminder, event.deletedAt);
    }
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
    if (size > 1024 * 1024) throw new Error('요청 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// API 요청과 정적 파일 요청을 처리하는 HTTP 서버를 만든다.
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
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
    console.error(error);
    const statusCode = error instanceof SyntaxError ? 400 : 500;
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
  console.log(`일정관리챗봇: http://localhost:${port}`);
  console.log(`SQLite: ${databasePath}`);
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
