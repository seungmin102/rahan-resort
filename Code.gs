/**
 * 라한호텔 휴양시설 신청 - 구글 앱스 스크립트 백엔드
 *
 * [설치 방법]
 * 1. 새 구글 시트를 만듭니다.
 * 2. 메뉴에서 확장 프로그램 > Apps Script 를 클릭합니다.
 * 3. 열린 편집기의 기존 코드를 모두 지우고 이 파일 내용을 전부 붙여넣습니다.
 * 4. 저장(디스크 아이콘 또는 Ctrl+S) 합니다.
 * 5. 우측 상단 "배포" > "새 배포" 클릭
 *    - 유형: 웹 앱
 *    - 설명: 아무거나 (예: 라한호텔 신청 API)
 *    - 실행 계정: 나(본인 계정)
 *    - 액세스 권한: "전체" 또는 "조직 내 모든 사용자" (사내에서만 쓸 거면 후자 권장)
 * 6. "배포" 클릭 후 권한 승인 진행
 * 7. 나온 웹 앱 URL(.../exec 로 끝나는 주소)을 복사해서
 *    apply.html, admin.html 안의 CONFIG.API_URL 에 붙여넣습니다.
 *    ※ 이미 배포된 URL을 유지하려면 "새 배포"가 아니라
 *      "배포 관리 > 기존 배포 편집 > 버전: 새 버전"으로 재배포하세요.
 * 8. (속도 최적화, 선택이지만 추천) 시트가 한 번 자동 생성된 후, "Applications" 탭에서
 *    B열(신청번호), D열(사번), G열(이용일) 전체를 마우스로 선택 → 서식 > 숫자 > 일반 텍스트로
 *    지정해 두면, 매 제출마다 서식을 다시 고치는 과정이 없어져 더 빨라집니다.
 *    "BlockedDates" 탭의 A열(날짜)도 같은 방식으로 일반 텍스트 지정을 추천합니다.
 *
 * 시트는 처음 요청이 들어올 때 자동으로 "Applications", "BlockedDates" 탭이 생성됩니다.
 */

const APPS_SHEET_NAME = 'Applications';
const BLOCKED_SHEET_NAME = 'BlockedDates';

const APPS_HEADERS = ['id','appNo','name','empid','branch','roomtype','date','nights','people','memo','status','reservationNo','submittedAt'];
const BLOCKED_HEADERS = ['date','blockedAt'];

/* =========================================================
   신청 규칙 (서버 측 검증용)
   ※ apply.html 의 동일 규칙과 값이 일치해야 합니다.
     연도가 바뀌면 HOLIDAYS / RANGE_* 를 양쪽 모두 갱신하세요.
   ========================================================= */
const RANGE_START = '2026-10-01';
const RANGE_END   = '2026-12-31';

const HOLIDAYS = {
  '2026-01-01':1,'2026-02-16':1,'2026-02-17':1,'2026-02-18':1,
  '2026-03-01':1,'2026-03-02':1,'2026-05-01':1,'2026-05-05':1,
  '2026-05-24':1,'2026-05-25':1,'2026-06-03':1,'2026-06-06':1,
  '2026-07-17':1,'2026-08-15':1,'2026-08-17':1,
  '2026-09-24':1,'2026-09-25':1,'2026-09-26':1,
  '2026-10-03':1,'2026-10-05':1,'2026-10-09':1,'2026-12-25':1
};

const BRANCHES = ['경주','전주','포항','목포','울산'];
const ROOMTYPES = ['디럭스 더블','디럭스 트윈'];
const NIGHTS_OPTIONS = ['1박2일','2박3일'];
const STATUSES = ['대기','승인','거절'];

const MAX_NAME_LEN = 20;
const MAX_MEMO_LEN = 500;
const MAX_RESERVATION_LEN = 50;
const MAX_BULK_IDS = 200;

function doGet(e){
  try{
    const action = e.parameter.action;
    if(action === 'list'){
      return jsonResponse({ ok:true, data: getAllApplications() });
    }
    if(action === 'blocked'){
      return jsonResponse({ ok:true, data: getAllBlockedDates() });
    }
    if(action === 'adminData'){
      // 관리자 화면이 쓰는 list + blocked 를 한 번의 실행으로 함께 돌려준다.
      // Apps Script 는 요청당 고정 오버헤드(컨테이너 기동, /exec 리다이렉트)가
      // 커서, 같은 데이터를 두 번 나눠 받으면 그 비용을 두 번 낸다.
      return jsonResponse({ ok:true, data: {
        applications: getAllApplications(),
        blocked: getAllBlockedDates()
      }});
    }
    if(action === 'lookup'){
      const name = e.parameter.name || '';
      const empid = e.parameter.empid || '';
      return jsonResponse({ ok:true, data: lookupApplications(name, empid) });
    }
    if(action === 'status'){
      const id = e.parameter.id || '';
      return jsonResponse({ ok:true, data: getApplicationById(id) });
    }
    return jsonResponse({ ok:false, error: 'unknown_action' });
  }catch(err){
    return jsonResponse({ ok:false, error: String(err && err.message || err) });
  }
}

function doPost(e){
  try{
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      if(action === 'submit'){
        const result = submitApplication(body.data);
        return jsonResponse({ ok:true, data: result });
      }
      if(action === 'updateStatus'){
        updateApplicationField(body.id, 'status', normalizeStatus(body.status));
        return jsonResponse({ ok:true });
      }
      if(action === 'updateStatusBulk'){
        // 여러 건을 한 요청에서 처리 (관리자 일괄 승인/거절).
        // 건별로 POST를 날리면 요청마다 락을 잡고 시트를 다시 읽어야 해서
        // 건수가 늘면 락 대기 시간을 넘겨 실패한다.
        const result = updateStatusBulk(body.ids, body.status);
        return jsonResponse({ ok:true, data: result });
      }
      if(action === 'updateReservation'){
        updateApplicationField(body.id, 'reservationNo', normalizeReservationNo(body.reservationNo));
        return jsonResponse({ ok:true });
      }
      if(action === 'deleteApplication'){
        deleteApplication(body.id);
        return jsonResponse({ ok:true });
      }
      if(action === 'deleteApplicationsBulk'){
        const result = deleteApplicationsBulk(body.ids);
        return jsonResponse({ ok:true, data: result });
      }
      if(action === 'blockDate'){
        blockDate(body.date);
        return jsonResponse({ ok:true });
      }
      if(action === 'unblockDate'){
        unblockDate(body.date);
        return jsonResponse({ ok:true });
      }
      return jsonResponse({ ok:false, error: 'unknown_action' });
    } finally {
      lock.releaseLock();
    }
  }catch(err){
    return jsonResponse({ ok:false, error: String(err && err.message || err) });
  }
}

function jsonResponse(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if(!sheet){
    sheet = ss.insertSheet(name);
    if(name === APPS_SHEET_NAME){
      sheet.appendRow(APPS_HEADERS);
    } else if(name === BLOCKED_SHEET_NAME){
      sheet.appendRow(BLOCKED_HEADERS);
    }
  }
  return sheet;
}

/* 시트 읽기는 필요한 범위만.
   getDataRange() 는 "내용이 있는 마지막 행/열"까지를 통째로 가져온다.
   헤더 밖 열에 뭔가 적혀 있거나 열 전체에 서식이 걸려 있으면 그만큼
   더 읽게 되고, 한 열만 필요할 때도 13개 열을 전부 실어 온다. */
function readRows(sheet, numCols){
  const lastRow = sheet.getLastRow();
  if(lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
}

// 한 열만 읽는다 (colIndex 는 1부터).
function readColumn(sheet, colIndex){
  const lastRow = sheet.getLastRow();
  if(lastRow < 2) return [];
  return sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
}

// id 로 행 번호를 찾는다. A열만 읽으면 되므로 전체를 가져오지 않는다.
function findRowById(sheet, id){
  const target = String(id);
  const ids = readColumn(sheet, 1);
  for(let i=0; i<ids.length; i++){
    if(String(ids[i][0]) === target) return i + 2; // 헤더 1줄 + 0-based 보정
  }
  return -1;
}

function sheetToObjects(sheet, headers){
  return readRows(sheet, headers.length).map(row=>{
    const obj = {};
    headers.forEach((h, i)=>{ obj[h] = row[i]; });
    return obj;
  }).filter(o => o.id || o.date); // 빈 행 제거용 최소 조건
}

function getAllApplications(){
  const sheet = getSheet(APPS_SHEET_NAME);
  return sheetToObjects(sheet, APPS_HEADERS).map(o=>{
    o.date = formatDateValue(o.date);
    if(o.submittedAt && Object.prototype.toString.call(o.submittedAt) === '[object Date]'){
      o.submittedAt = o.submittedAt.toISOString();
    } else {
      o.submittedAt = String(o.submittedAt || '');
    }
    o.appNo = String(o.appNo || '');
    o.empid = String(o.empid || '');
    o.reservationNo = String(o.reservationNo || '');
    return o;
  });
}

function getAllBlockedDates(){
  const sheet = getSheet(BLOCKED_SHEET_NAME);
  return sheetToObjects(sheet, BLOCKED_HEADERS).map(o => formatDateValue(o.date));
}

function formatDateValue(val){
  // 시트에 날짜가 Date 객체로 저장된 경우 YYYY-MM-DD 문자열로 변환
  if(Object.prototype.toString.call(val) === '[object Date]'){
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val);
}

/* =========================================================
   검증 헬퍼
   ========================================================= */

// 'YYYY-MM-DD' 문자열을 로컬 Date 로 변환. 형식이 틀리거나 달력에 없는
// 날짜(예: 2026-11-31)면 null 을 돌려준다.
function parseDateStr(dateStr){
  if(typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if(!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if(dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function addDaysStr(dateStr, days){
  const dt = parseDateStr(dateStr);
  dt.setDate(dt.getDate() + days);
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function inAllowedRange(dateStr){
  return dateStr >= RANGE_START && dateStr <= RANGE_END;
}

// 이용(체크인) 가능 요일: 일(0)~목(4)
function isAllowedWeekday(dateStr){
  const dt = parseDateStr(dateStr);
  if(!dt) return false;
  const day = dt.getDay();
  return day >= 0 && day <= 4;
}

// 묵을 수 없는 밤: 금·토요일, 공휴일, 관리자 마감일
function isNightBlocked(dateStr, blockedMap){
  const dt = parseDateStr(dateStr);
  if(!dt) return true;
  const day = dt.getDay();
  if(day === 5 || day === 6) return true;
  if(HOLIDAYS[dateStr]) return true;
  if(blockedMap[dateStr]) return true;
  return false;
}

function occupiedNights(dateStr, nightsValue){
  const count = nightsValue === '2박3일' ? 2 : 1;
  const arr = [];
  for(let i=0; i<count; i++){
    arr.push(addDaysStr(dateStr, i));
  }
  return arr;
}

function blockedDateMap(){
  const map = {};
  getAllBlockedDates().forEach(d => { map[d] = 1; });
  return map;
}

function normalizeStatus(status){
  const s = String(status == null ? '' : status).trim();
  if(STATUSES.indexOf(s) === -1) throw new Error('invalid_status');
  return s;
}

function normalizeReservationNo(value){
  const s = String(value == null ? '' : value).trim();
  if(s.length > MAX_RESERVATION_LEN) throw new Error('reservation_too_long');
  return s;
}

// 신청 데이터를 검증하고, 시트에 기록할 정규화된 값을 돌려준다.
// 브라우저(apply.html)에서 이미 같은 규칙을 검사하지만, API 를 직접
// 호출하면 그 검사를 통째로 건너뛸 수 있으므로 여기서 다시 확인한다.
function validateSubmission(data){
  if(!data || typeof data !== 'object') throw new Error('invalid_payload');

  const name = String(data.name == null ? '' : data.name).trim();
  if(!name) throw new Error('missing_name');
  if(name.length > MAX_NAME_LEN) throw new Error('name_too_long');

  const empid = String(data.empid == null ? '' : data.empid).trim();
  if(!/^\d{1,6}$/.test(empid)) throw new Error('invalid_empid');

  const branch = String(data.branch == null ? '' : data.branch).trim();
  if(BRANCHES.indexOf(branch) === -1) throw new Error('invalid_branch');

  const roomtype = String(data.roomtype == null ? '' : data.roomtype).trim();
  if(ROOMTYPES.indexOf(roomtype) === -1) throw new Error('invalid_roomtype');

  const nights = String(data.nights == null ? '' : data.nights).trim();
  if(NIGHTS_OPTIONS.indexOf(nights) === -1) throw new Error('invalid_nights');

  const date = String(data.date == null ? '' : data.date).trim();
  if(!parseDateStr(date)) throw new Error('invalid_date');
  if(!inAllowedRange(date)) throw new Error('date_out_of_range');
  if(!isAllowedWeekday(date)) throw new Error('date_not_allowed_weekday');

  const blockedMap = blockedDateMap();
  const nightsList = occupiedNights(date, nights);
  for(let i=0; i<nightsList.length; i++){
    if(isNightBlocked(nightsList[i], blockedMap)) throw new Error('stay_not_available');
  }

  const memo = String(data.memo == null ? '' : data.memo).trim();
  if(memo.length > MAX_MEMO_LEN) throw new Error('memo_too_long');

  return { name, empid, branch, roomtype, date, nights, memo };
}

/* =========================================================
   쓰기 동작
   ========================================================= */

function submitApplication(data){
  const clean = validateSubmission(data);
  const sheet = getSheet(APPS_SHEET_NAME);
  const id = Utilities.getUuid();
  const appNo = generateAppNo(sheet);
  const row = [
    id, appNo,
    clean.name, clean.empid, clean.branch, clean.roomtype,
    clean.date, clean.nights, 2, clean.memo,
    '대기', '', new Date().toISOString()
  ];
  // appendRow 대신 위치를 직접 계산해 한 번의 호출로 기록 (속도 최적화)
  // ※ 날짜/사번/신청번호가 자동 서식 변환되지 않으려면, 시트에서 해당 열을
  //   미리 '일반 텍스트'로 서식 지정해 두세요 (설치 안내 참고).
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);
  return { id, appNo };
}

function generateAppNo(sheet){
  // 신청번호(B열)만 있으면 된다. 예전에는 이 한 열 때문에 시트 전체를 읽었다.
  const existing = new Set(readColumn(sheet, 2).map(r => String(r[0])));
  for(let i=0; i<50; i++){
    const candidate = String(Math.floor(Math.random()*9000) + 1000);
    if(!existing.has(candidate)) return candidate;
  }
  return String(Date.now()).slice(-4);
}

function updateApplicationField(id, field, value){
  const sheet = getSheet(APPS_SHEET_NAME);
  const colIndex = APPS_HEADERS.indexOf(field);
  if(colIndex === -1) throw new Error('invalid_field');
  const row = findRowById(sheet, id);
  if(row === -1) throw new Error('not_found');
  sheet.getRange(row, colIndex+1).setValue(value);
  return true;
}

// 여러 건의 상태를 한 번에 변경한다. 시트는 한 번만 읽고, status 열 전체를
// 한 번의 setValues 로 다시 쓴다(값은 방금 읽은 것 그대로라 대상 외 행은 불변).
function updateStatusBulk(ids, status){
  const clean = normalizeStatus(status);
  if(!Array.isArray(ids)) throw new Error('invalid_ids');
  if(ids.length === 0) return { updated: 0, notFound: [] };
  if(ids.length > MAX_BULK_IDS) throw new Error('too_many_ids');

  const wanted = {};
  ids.forEach(id => { wanted[String(id)] = true; });

  const sheet = getSheet(APPS_SHEET_NAME);
  const statusCol = APPS_HEADERS.indexOf('status') + 1;
  const idRows = readColumn(sheet, 1); // id(A열)만 읽어 대상 행을 찾는다
  if(idRows.length === 0) return { updated: 0, notFound: ids.map(String) };

  const found = {};
  const targetRows = [];
  for(let i=0; i<idRows.length; i++){
    const rowId = String(idRows[i][0]);
    if(wanted[rowId]){
      targetRows.push(i + 2);
      found[rowId] = true;
    }
  }

  if(targetRows.length > 0){
    // 대상 행들을 모두 감싸는 최소 구간만 읽고 쓴다.
    // 건별 setValue 는 호출이 건수만큼 늘고, 열 전체 쓰기는 무관한 행까지 건드린다.
    const minRow = targetRows[0];
    const maxRow = targetRows[targetRows.length - 1];
    const span = maxRow - minRow + 1;
    const isTarget = {};
    targetRows.forEach(r => { isTarget[r] = true; });

    const values = sheet.getRange(minRow, statusCol, span, 1).getValues();
    for(let r=minRow; r<=maxRow; r++){
      if(isTarget[r]) values[r - minRow][0] = clean;
    }
    sheet.getRange(minRow, statusCol, span, 1).setValues(values);
  }

  const notFound = Object.keys(wanted).filter(id => !found[id]);
  return { updated: targetRows.length, notFound };
}

/* 신청 삭제. 시트에서 행을 실제로 지우므로 API 로는 되돌릴 수 없다.
   (구글 시트의 파일 > 버전 기록으로는 복구 가능하다.) */
function deleteApplication(id){
  const sheet = getSheet(APPS_SHEET_NAME);
  const row = findRowById(sheet, id);
  if(row === -1) throw new Error('not_found');
  sheet.deleteRow(row);
  return true;
}

function deleteApplicationsBulk(ids){
  if(!Array.isArray(ids)) throw new Error('invalid_ids');
  if(ids.length === 0) return { deleted: 0, notFound: [] };
  if(ids.length > MAX_BULK_IDS) throw new Error('too_many_ids');

  const wanted = {};
  ids.forEach(id => { wanted[String(id)] = true; });

  const sheet = getSheet(APPS_SHEET_NAME);
  const idRows = readColumn(sheet, 1);
  const found = {};
  const targetRows = [];
  for(let i=0; i<idRows.length; i++){
    const rowId = String(idRows[i][0]);
    if(wanted[rowId]){
      targetRows.push(i + 2);
      found[rowId] = true;
    }
  }

  /* 아래쪽 행부터 지운다. 위에서부터 지우면 남은 행 번호가 한 칸씩 당겨져
     뒤 대상들이 어긋난다. 연속된 구간은 deleteRows 로 한 번에 처리한다. */
  let i = targetRows.length - 1;
  while(i >= 0){
    const end = targetRows[i];
    let start = end;
    while(i > 0 && targetRows[i-1] === start - 1){ i--; start = targetRows[i]; }
    sheet.deleteRows(start, end - start + 1);
    i--;
  }

  const notFound = Object.keys(wanted).filter(id => !found[id]);
  return { deleted: targetRows.length, notFound };
}

function lookupApplications(name, empid){
  const all = getAllApplications();
  return all.filter(a => String(a.name) === name && String(a.empid) === empid);
}

function getApplicationById(id){
  const all = getAllApplications();
  return all.find(a => String(a.id) === id) || null;
}

function blockDate(dateStr){
  const date = String(dateStr == null ? '' : dateStr).trim();
  if(!parseDateStr(date)) throw new Error('invalid_date');
  if(!inAllowedRange(date)) throw new Error('date_out_of_range');
  if(!isAllowedWeekday(date)) throw new Error('date_not_allowed_weekday');

  const sheet = getSheet(BLOCKED_SHEET_NAME);
  const existing = readColumn(sheet, 1);
  for(let r=0; r<existing.length; r++){
    if(formatDateValue(existing[r][0]) === date) return; // 이미 존재
  }
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, 1, 2).setValues([[date, new Date().toISOString()]]);
}

function unblockDate(dateStr){
  const date = String(dateStr == null ? '' : dateStr).trim();
  const sheet = getSheet(BLOCKED_SHEET_NAME);
  const existing = readColumn(sheet, 1);
  for(let r=0; r<existing.length; r++){
    if(formatDateValue(existing[r][0]) === date){
      sheet.deleteRow(r + 2);
      return;
    }
  }
}
