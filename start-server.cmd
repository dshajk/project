@echo off
REM 명령을 실행한 위치와 관계없이 프로젝트 폴더로 이동한다.
cd /d "%~dp0"
REM Node.js로 일정관리챗봇 서버를 시작한다.
node server.js
REM 실행 오류가 발생하면 창이 바로 닫히지 않도록 대기한다.
if errorlevel 1 pause
