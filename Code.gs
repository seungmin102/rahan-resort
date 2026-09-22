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

function doGet(e){
  try{
    const action = e.parameter.action;
    if(action === 'list'){
      return jsonResponse({ ok:true, data: getAllApplications() });
    }
    if(action === 'blocked'){
      return jsonResponse({ ok:true, data: getAllBlockedDates() });
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
    return jsonResponse({ ok:false, error: String(err) });
  }
}

function doPost(e){
  try{
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try{
      if(action === 'submit'){
        const result = submitApplication(body.data);
        return jsonResponse({ ok:true, data: result });
      }
      if(action === 'updateStatus'){
        updateApplicationField(body.id, 'status', body.status);
        return jsonResponse({ ok:true });
      }
      if(action === 'updateReservation'){
        updateApplicationField(body.id, 'reservationNo', body.reservationNo);
        return jsonResponse({ ok:true });
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
    return jsonResponse({ ok:false, error: String(err) });
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

function sheetToObjects(sheet, headers){
  const range = sheet.getDataRange().getValues();
  if(range.length < 2) return [];
  return range.slice(1).map(row=>{
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

function submitApplication(data){
  const sheet = getSheet(APPS_SHEET_NAME);
  const id = Utilities.getUuid();
  const appNo = generateAppNo(sheet);
  const row = [
    id, appNo,
    data.name || '', data.empid || '', data.branch || '', data.roomtype || '',
    data.date || '', data.nights || '', 2, data.memo || '',
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
  const range = sheet.getDataRange().getValues();
  const existing = new Set(range.slice(1).map(r => String(r[1])));
  for(let i=0; i<50; i++){
    const candidate = String(Math.floor(Math.random()*9000) + 1000);
    if(!existing.has(candidate)) return candidate;
  }
  return String(Date.now()).slice(-4);
}

function updateApplicationField(id, field, value){
  const sheet = getSheet(APPS_SHEET_NAME);
  const range = sheet.getDataRange().getValues();
  const colIndex = APPS_HEADERS.indexOf(field);
  if(colIndex === -1) throw new Error('invalid_field');
  for(let r=1; r<range.length; r++){
    if(range[r][0] === id){
      sheet.getRange(r+1, colIndex+1).setValue(value);
      return true;
    }
  }
  throw new Error('not_found');
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
  const sheet = getSheet(BLOCKED_SHEET_NAME);
  const range = sheet.getDataRange().getValues();
  for(let r=1; r<range.length; r++){
    if(formatDateValue(range[r][0]) === dateStr) return; // 이미 존재
  }
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, 1, 2).setValues([[dateStr, new Date().toISOString()]]);
}

function unblockDate(dateStr){
  const sheet = getSheet(BLOCKED_SHEET_NAME);
  const range = sheet.getDataRange().getValues();
  for(let r=1; r<range.length; r++){
    if(formatDateValue(range[r][0]) === dateStr){
      sheet.deleteRow(r+1);
      return;
    }
  }
}
