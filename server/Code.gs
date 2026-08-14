/* ══════════════════════════════════════════════════════════════════════
   본부 수신 스크립트 (Google Apps Script)
   · 아동코드를 도착 순서대로 부여합니다.
   · 같은 기록ID가 다시 오면 새 줄을 만들지 않고 부여했던 코드를 돌려줍니다.
   · 여러 직원이 동시에 보내도 LockService 가 한 줄로 세웁니다.

   설치: 구글 시트 → 확장 프로그램 → Apps Script → 이 코드 붙여넣기
        → 아래 CONFIG 를 채우고 → 배포 → 새 배포 → 웹 앱
        → 실행 사용자: 나,  액세스 권한: 모든 사용자
   ══════════════════════════════════════════════════════════════════════ */

const CONFIG = {
  SHEET_ID:   '',                    // 비워두면 이 스크립트가 붙은 시트를 씁니다
  MASTER_TAB: '아동마스터',
  PHOTO_TAB:  '사진',
  FOLDER_ID:  '여기에_드라이브_폴더_ID',   // 사진이 저장될 폴더
  KEY:        '여기에_전송키',              // 앱 설정의 전송키와 같아야 합니다
  SEQ_PAD:    4
};

const MASTER_COLS = ['아동코드','국가코드','사업장코드','연번','등록일','등록담당자','현지어이름','영문이름',
'성별','생년월일','생년월일추정','출생등록','중복확인','중복확인메모','주보호자','동거가족수','주소득원',
'식수원','전기','취학여부','학년','미취학사유','건강상태','건강메모','장래희망','좋아하는과목','취미',
'아동의말','담당자메모','보호자동의','아동동의','활용동의','동의서사진','대표사진','상태','본부검수일',
'본부검수자','종료일','종료사유','기록ID','전송일시'];

const PHOTO_COLS = ['사진ID','아동코드','촬영일','사진유형','사진파일','촬영자','촬영기준확인','비고'];

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (CONFIG.KEY && req.key !== CONFIG.KEY) return out({ ok: false, error: '전송키가 다릅니다' });
    if (req.action === 'ping')   return out({ ok: true, sheet: book().getName() });
    if (req.action === 'roster') return out(roster(req.site));
    if (req.action === 'record') return out(record(req));
    return out({ ok: false, error: '알 수 없는 요청: ' + req.action });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function book() {
  return CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
                         : SpreadsheetApp.getActiveSpreadsheet();
}

function tab(name, cols) {
  const ss = book();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(cols); }
  if (sh.getLastRow() === 0) sh.appendRow(cols);
  return sh;
}

function colIndex(sh, cols) {
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), cols.length))
                 .getValues()[0].map(String);
  const map = {};
  cols.forEach(c => { map[c] = head.indexOf(c); });
  return map;
}

const norm = v => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' ');
/* 시트의 날짜 칸은 Date 객체로 읽힙니다. 문자열로 그냥 자르면 "Mon Mar 03"이 되어
   중복 대조가 조용히 어긋납니다. 반드시 이 함수로 맞춰서 비교하세요. */
const dstr = v => v instanceof Date
  ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  : String(v == null ? '' : v).trim().slice(0, 10);
const pad  = n => String(n).padStart(CONFIG.SEQ_PAD, '0');

/* ── 등록 수신 ───────────────────────────────────────────────
   동시에 들어와도 순서대로 한 건씩 처리됩니다. */
function record(req) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '서버가 바쁩니다. 잠시 후 다시 시도하세요.' };
  try {
    const r  = req.record || {};
    const id = String(r.기록ID || '').trim();
    if (!id) return { ok: false, error: '기록ID가 없습니다' };

    const sh   = tab(CONFIG.MASTER_TAB, MASTER_COLS);
    const idx  = colIndex(sh, MASTER_COLS);
    const last = sh.getLastRow();
    const rows = last > 1 ? sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues() : [];

    /* 1. 이미 받은 건인가 — 재전송이면 그대로 돌려줍니다 */
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][idx['기록ID']]).trim() === id) {
        return { ok: true, 아동코드: rows[i][idx['아동코드']], 연번: rows[i][idx['연번']],
                 상태: rows[i][idx['상태']], 대표사진: rows[i][idx['대표사진']],
                 동의서사진: rows[i][idx['동의서사진']], 재전송: true };
      }
    }

    /* 2. 사업장별 다음 연번
       행에서 최댓값을 찾는 방식만 쓰면, 시트에서 행을 하나 지웠을 때 이미 나간 코드가
       다시 발급됩니다. 별도 카운터에 기록하고, 둘 중 큰 값을 기준으로 삼습니다. */
    const site = String(r.사업장코드 || '').trim();
    let max = 0;
    rows.forEach(row => {
      if (String(row[idx['사업장코드']]).trim() === site) {
        const n = parseInt(row[idx['연번']], 10);
        if (n > max) max = n;
      }
    });
    const seq  = Math.max(max, counterLast(site)) + 1;
    counterSet(site, seq);
    const code = [String(r.국가코드 || '').trim(), site, pad(seq)].join('-');

    /* 3. 같은 아동이 이미 있는지 — 막지 않고 표시만 합니다 */
    let 상태 = '본부검수대기', 메모 = String(r.중복확인메모 || '');
    const dup = rows.filter(row =>
      !row[idx['종료일']] &&
      String(row[idx['사업장코드']]).trim() === site &&
      norm(row[idx['영문이름']]) === norm(r.영문이름) &&
      dstr(row[idx['생년월일']]) === dstr(r.생년월일) &&
      String(row[idx['성별']]).trim() === String(r.성별).trim());
    if (dup.length) {
      상태 = '중복확인필요';
      메모 = (메모 ? 메모 + ' / ' : '') + '자동감지: ' + dup.map(x => x[idx['아동코드']]).join(', ');
    }

    /* 4. 사진 저장 — 파일명은 부여된 코드로 여기서 만듭니다 */
    const day    = String(r.등록일 || '').replace(/-/g, '');
    const photos = req.photos || {};
    const qc     = req.qc || {};
    const saved  = {};
    ['face', 'full', 'consent'].forEach(k => {
      if (!photos[k]) return;
      saved[k] = savePhoto(photos[k], code + '_' + day + '_' + k + '.jpg');
    });

    /* 5. 아동마스터에 한 줄 추가 */
    const row = MASTER_COLS.map(c => {
      if (c === '아동코드')   return code;
      if (c === '연번')       return pad(seq);
      if (c === '상태')       return 상태;
      if (c === '중복확인메모') return 메모;
      if (c === '대표사진')   return saved.face    || '';
      if (c === '동의서사진') return saved.consent || '';
      if (c === '기록ID')     return id;
      if (c === '전송일시')   return new Date();
      return r[c] == null ? '' : r[c];
    });
    sh.appendRow(row);

    /* 6. 사진 시트 */
    const ph = tab(CONFIG.PHOTO_TAB, PHOTO_COLS);
    let n = 1;
    const addPhoto = (type, k, note) => {
      if (!saved[k]) return;
      ph.appendRow([code + '-P' + String(n++).padStart(3, '0'), code, r.등록일, type,
                    saved[k], r.등록담당자, '예',
                    [note, qc[k === 'consent' ? 'cons' : k] || ''].filter(String).join(' · ')]);
    };
    addPhoto('신규-상반신', 'face',    '신규수급 등록 시 촬영');
    addPhoto('신규-전신',   'full',    '');
    addPhoto('동의서',      'consent', '보호자 서명본');

    return { ok: true, 아동코드: code, 연번: pad(seq), 상태: 상태,
             대표사진: saved.face || '', 동의서사진: saved.consent || '' };
  } finally {
    lock.releaseLock();
  }
}

/* ── 발급 카운터 ─────────────────────────────────────────────
   사업장별로 '지금까지 몇 번까지 나갔는지'만 기록합니다.
   행을 지워도 번호가 되돌아가지 않게 하는 안전장치입니다. */
const COUNTER_TAB = '코드발급';
function counterRow(site) {
  const sh = tab(COUNTER_TAB, ['사업장코드', '마지막연번', '갱신일시']);
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
  for (let i = 0; i < rows.length; i++)
    if (String(rows[i][0]).trim() === site) return { sh: sh, row: i + 2, n: Number(rows[i][1] || 0) };
  return { sh: sh, row: 0, n: 0 };
}
function counterLast(site) { return counterRow(site).n; }
function counterSet(site, n) {
  const c = counterRow(site);
  if (c.row) c.sh.getRange(c.row, 2, 1, 2).setValues([[n, new Date()]]);
  else c.sh.appendRow([site, n, new Date()]);
}

function savePhoto(b64, name) {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const blob   = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name);
  folder.createFile(blob);
  return name;
}

/* ── 명단 회신 ───────────────────────────────────────────────
   앱이 전송할 때마다 받아가서, 오프라인 중복 검사에 씁니다. */
function roster(site) {
  const sh = tab(CONFIG.MASTER_TAB, MASTER_COLS);
  const idx = colIndex(sh, MASTER_COLS);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, roster: [] };
  const rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  const pick = ['아동코드','영문이름','생년월일','성별','사업장코드','현지어이름','주보호자'];
  const list = rows
    .filter(row => !row[idx['종료일']] && (!site || String(row[idx['사업장코드']]).trim() === site))
    .map(row => {
      const o = {};
      pick.forEach(c => {
        let v = row[idx[c]];
        if (c === '생년월일' && v instanceof Date) v = Utilities.formatDate(v, 'GMT', 'yyyy-MM-dd');
        o[c] = String(v == null ? '' : v);
      });
      return o;
    });
  return { ok: true, roster: list };
}

/* ══════════════════════════════════════════════════════════════
   설치가 잘 됐는지 스스로 확인하는 기능
   스크립트 편집기 위쪽에서 함수를 [설치점검] 으로 고르고 [실행] 을 누르세요.
   ══════════════════════════════════════════════════════════════ */
function 설치점검() {
  const 결과 = [];
  try {
    const ss = book();
    결과.push('연결된 시트 : ' + ss.getName());
  } catch (e) {
    결과.push('✗ 시트를 열 수 없습니다. CONFIG.SHEET_ID 를 확인하세요.');
    Logger.log(결과.join('\n')); return 결과.join('\n');
  }

  const m = tab(CONFIG.MASTER_TAB, MASTER_COLS);
  const ph = tab(CONFIG.PHOTO_TAB, PHOTO_COLS);
  const cn = tab(COUNTER_TAB, ['사업장코드', '마지막연번', '갱신일시']);
  결과.push('아동마스터 탭 : 준비됨 (현재 ' + Math.max(0, m.getLastRow() - 1) + '명)');
  결과.push('사진 탭 : 준비됨 (현재 ' + Math.max(0, ph.getLastRow() - 1) + '장)');
  결과.push('코드발급 탭 : 준비됨');

  if (!CONFIG.FOLDER_ID || CONFIG.FOLDER_ID.indexOf('여기에') === 0) {
    결과.push('✗ 사진 폴더가 설정되지 않았습니다. CONFIG.FOLDER_ID 를 채우세요.');
  } else {
    try {
      결과.push('사진 폴더 : ' + DriveApp.getFolderById(CONFIG.FOLDER_ID).getName());
    } catch (e) {
      결과.push('✗ 사진 폴더를 찾을 수 없습니다. 폴더 ID 를 다시 확인하세요.');
    }
  }

  if (!CONFIG.KEY || CONFIG.KEY.indexOf('여기에') === 0) {
    결과.push('✗ 전송키가 아직 기본값입니다. 길고 무작위한 문자열로 바꾸세요.');
  } else if (CONFIG.KEY.length < 12) {
    결과.push('△ 전송키가 짧습니다. 20자 이상을 권합니다.');
  } else {
    결과.push('전송키 : 설정됨 (' + CONFIG.KEY.length + '자)');
  }

  const 문제 = 결과.filter(function (r) { return r.indexOf('✗') === 0; }).length;
  결과.push('');
  결과.push(문제 ? '→ ✗ 표시된 항목을 고친 뒤 다시 실행하세요.'
                 : '→ 모두 정상입니다. 이제 [배포] 를 진행하세요.');
  const msg = 결과.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

/* 주소를 브라우저에서 그냥 열었을 때 보이는 안내 */
function doGet() {
  return ContentService.createTextOutput(
    '아동등록 수신 서버가 동작 중입니다. 이 주소를 앱 설정의 [본부 서버 주소] 에 넣으세요.');
}
