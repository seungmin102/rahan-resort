/**
 * 육아휴직 · 육아기 근로시간 단축 사용 현황 - 구글 앱스 스크립트 백엔드
 *
 * 휴양시설 신청(Code.gs)과는 **다른 구글 시트, 다른 Apps Script 프로젝트**로 배포한다.
 * 직원·자녀 개인정보가 들어가므로, 휴양시설 시트에 접근하는 사람에게 이 데이터가
 * 보이지 않게 하고, 휴양시설 API(인증 없음)와 섞이지 않게 하기 위해서다.
 *
 * [설치 방법]
 * 1. 새 구글 시트를 만든다 (예: "육아휴직 관리").
 * 2. 확장 프로그램 > Apps Script 를 열고 이 파일 내용을 전부 붙여넣고 저장(Ctrl+S).
 * 3. 왼쪽 톱니바퀴(프로젝트 설정) > 스크립트 속성 > 속성 추가
 *      속성: ACCESS_KEY   값: 담당자만 아는 긴 문자열 (예: 20자 이상 무작위)
 *    이 값이 없으면 모든 요청이 'not_configured' 로 거절된다.
 * 4. 배포 > 새 배포 > 유형: 웹 앱
 *      실행 계정: 나 / 액세스 권한: 전체
 *    (브라우저가 github.io 에서 호출하므로 구글 로그인을 요구하면 호출이 막힌다.
 *     대신 모든 요청에 ACCESS_KEY 를 요구한다.)
 * 5. 나온 .../exec 주소를 leave.html 의 CONFIG.API_URL 에 넣는다.
 *    ※ 고친 뒤에는 "배포 관리 > 기존 배포 편집 > 버전: 새 버전" 으로 재배포해야 URL 이 유지된다.
 * 6. (권장) 시트가 자동 생성된 뒤, 각 탭의 날짜 열과 사번 열을 서식 > 숫자 > 일반 텍스트로 지정.
 *
 * 모든 요청은 POST(text/plain) 로 받는다. 접근 키를 URL 쿼리에 실으면
 * 브라우저 기록·프록시 로그에 남기 때문이다.
 */

const EMP_SHEET_NAME   = 'Employees';
const CHILD_SHEET_NAME = 'Children';
const USAGE_SHEET_NAME = 'Usages';

const EMP_HEADERS   = ['id','empid','name','dept','position','hireDate','memo','createdAt'];
const CHILD_HEADERS = ['id','employeeId','name','birthDate','extended','extendReason','memo','createdAt'];
const USAGE_HEADERS = ['id','childId','type','startDate','endDate','hoursPerWeek','memo','createdAt'];

const HEADERS_BY_SHEET = {};
HEADERS_BY_SHEET[EMP_SHEET_NAME] = EMP_HEADERS;
HEADERS_BY_SHEET[CHILD_SHEET_NAME] = CHILD_HEADERS;
HEADERS_BY_SHEET[USAGE_SHEET_NAME] = USAGE_HEADERS;

/* ※ leave.html 의 같은 이름 상수와 값이 일치해야 한다. */
const USAGE_TYPES = ['육아휴직','육아기단축'];
const EXTEND_REASONS = ['부모 모두 3개월 이상 사용','한부모','중증 장애아동 부모'];
const MIN_SHORT_HOURS = 15;
const MAX_SHORT_HOURS = 35;

const SCRIPT_VERSION = '2026-10-07';
const SUPPORTED_ACTIONS = [
  'version','loadAll',
  'saveEmployee','deleteEmployee',
  'saveChild','deleteChild',
  'saveUsage','deleteUsage'
];

const MAX_NAME_LEN = 20;
const MAX_TEXT_LEN = 50;
const MAX_MEMO_LEN = 500;

function doGet(e){
  // 데이터는 POST 로만 준다. 주소창에서 연결 확인만 할 수 있게 version 만 연다.
  if(e && e.parameter && e.parameter.action === 'version'){
    return jsonResponse({ ok:true, data: { version: SCRIPT_VERSION, actions: SUPPORTED_ACTIONS } });
  }
  return jsonResponse({ ok:false, error: 'use_post' });
}

function doPost(e){
  try{
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if(action === 'version'){
      return jsonResponse({ ok:true, data: { version: SCRIPT_VERSION, actions: SUPPORTED_ACTIONS } });
    }
    checkAccessKey(body.key);

    if(action === 'loadAll'){
      return jsonResponse({ ok:true, data: loadAll() });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try{
      if(action === 'saveEmployee'){
        return jsonResponse({ ok:true, data: saveEmployee(body.data) });
      }
      if(action === 'deleteEmployee'){
        return jsonResponse({ ok:true, data: deleteEmployee(body.id) });
      }
      if(action === 'saveChild'){
        return jsonResponse({ ok:true, data: saveChild(body.data) });
      }
      if(action === 'deleteChild'){
        return jsonResponse({ ok:true, data: deleteChild(body.id) });
      }
      if(action === 'saveUsage'){
        return jsonResponse({ ok:true, data: saveUsage(body.data) });
      }
      if(action === 'deleteUsage'){
        return jsonResponse({ ok:true, data: deleteUsage(body.id) });
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

function checkAccessKey(key){
  const expected = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  if(!expected) throw new Error('not_configured');
  if(typeof key !== 'string' || key !== expected){
    Utilities.sleep(500); // 무작위 대입을 느리게
    throw new Error('unauthorized');
  }
}

/* =========================================================
   시트 읽기/쓰기 (Code.gs 와 같은 원칙: 필요한 범위만 읽는다)
   ========================================================= */

function getSheet(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if(!sheet){
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS_BY_SHEET[name]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readRows(sheet, numCols){
  const lastRow = sheet.getLastRow();
  if(lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
}

function readColumn(sheet, colIndex){
  const lastRow = sheet.getLastRow();
  if(lastRow < 2) return [];
  return sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
}

function findRowById(sheet, id){
  const target = String(id);
  const ids = readColumn(sheet, 1);
  for(let i=0; i<ids.length; i++){
    if(String(ids[i][0]) === target) return i + 2;
  }
  return -1;
}

// 시트 값은 숫자·날짜로 자동 변환돼 돌아올 수 있으므로 전부 문자열로 정규화한다.
function cellToString(val){
  if(Object.prototype.toString.call(val) === '[object Date]'){
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val == null ? '' : val);
}

function readObjects(name){
  const headers = HEADERS_BY_SHEET[name];
  return readRows(getSheet(name), headers.length).map(row=>{
    const obj = {};
    headers.forEach((h, i)=>{ obj[h] = cellToString(row[i]); });
    return obj;
  }).filter(o => o.id);
}

function loadAll(){
  const employees = readObjects(EMP_SHEET_NAME);
  const children = readObjects(CHILD_SHEET_NAME).map(c=>{
    c.extended = c.extended === 'Y' || c.extended === 'TRUE' || c.extended === 'true';
    return c;
  });
  const usages = readObjects(USAGE_SHEET_NAME).map(u=>{
    u.hoursPerWeek = u.hoursPerWeek === '' ? '' : Number(u.hoursPerWeek);
    return u;
  });
  return { employees, children, usages };
}

// id 가 있으면 그 행을 덮어쓰고, 없으면 새 행을 만든다.
function upsertRow(name, obj){
  const headers = HEADERS_BY_SHEET[name];
  const sheet = getSheet(name);
  const row = headers.map(h => obj[h] == null ? '' : obj[h]);
  if(obj.id){
    const r = findRowById(sheet, obj.id);
    if(r === -1) throw new Error('not_found');
    // createdAt 은 처음 값을 유지한다
    const createdCol = headers.indexOf('createdAt');
    row[createdCol] = sheet.getRange(r, createdCol + 1).getValue();
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    return obj.id;
  }
  const id = Utilities.getUuid();
  row[0] = id;
  row[headers.indexOf('createdAt')] = new Date().toISOString();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return id;
}

// 조건에 맞는 행을 아래에서부터 지운다(행 번호가 밀리지 않도록).
function deleteRowsWhere(name, colName, values){
  const headers = HEADERS_BY_SHEET[name];
  const sheet = getSheet(name);
  const col = headers.indexOf(colName) + 1;
  const wanted = {};
  values.forEach(v => { wanted[String(v)] = true; });
  const cells = readColumn(sheet, col);
  let deleted = 0;
  for(let i=cells.length-1; i>=0; i--){
    if(wanted[String(cells[i][0])]){
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }
  return deleted;
}

/* =========================================================
   검증
   ========================================================= */

function parseDateStr(s){
  if(typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if(!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if(dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function str(v){ return String(v == null ? '' : v).trim(); }

function requireDate(v, code, optional){
  const s = str(v);
  if(!s && optional) return '';
  if(!parseDateStr(s)) throw new Error(code);
  return s;
}

function requireLen(v, max, code){
  const s = str(v);
  if(s.length > max) throw new Error(code);
  return s;
}

function saveEmployee(data){
  if(!data || typeof data !== 'object') throw new Error('invalid_payload');
  const name = requireLen(data.name, MAX_NAME_LEN, 'name_too_long');
  if(!name) throw new Error('missing_name');
  const empid = str(data.empid);
  if(!/^\d{1,10}$/.test(empid)) throw new Error('invalid_empid');

  const existing = readObjects(EMP_SHEET_NAME);
  if(existing.some(e => e.empid === empid && e.id !== str(data.id))) throw new Error('duplicate_empid');

  const id = upsertRow(EMP_SHEET_NAME, {
    id: str(data.id),
    empid: empid,
    name: name,
    dept: requireLen(data.dept, MAX_TEXT_LEN, 'dept_too_long'),
    position: requireLen(data.position, MAX_TEXT_LEN, 'position_too_long'),
    hireDate: requireDate(data.hireDate, 'invalid_hire_date', true),
    memo: requireLen(data.memo, MAX_MEMO_LEN, 'memo_too_long')
  });
  return { id: id };
}

function saveChild(data){
  if(!data || typeof data !== 'object') throw new Error('invalid_payload');
  const employeeId = str(data.employeeId);
  if(findRowById(getSheet(EMP_SHEET_NAME), employeeId) === -1) throw new Error('employee_not_found');
  const name = requireLen(data.name, MAX_NAME_LEN, 'name_too_long');
  if(!name) throw new Error('missing_name');
  const birthDate = requireDate(data.birthDate, 'invalid_birth_date', false);

  const extended = data.extended === true;
  const extendReason = extended ? str(data.extendReason) : '';
  if(extended && EXTEND_REASONS.indexOf(extendReason) === -1) throw new Error('invalid_extend_reason');

  const id = upsertRow(CHILD_SHEET_NAME, {
    id: str(data.id),
    employeeId: employeeId,
    name: name,
    birthDate: birthDate,
    extended: extended ? 'Y' : '',
    extendReason: extendReason,
    memo: requireLen(data.memo, MAX_MEMO_LEN, 'memo_too_long')
  });
  return { id: id };
}

function saveUsage(data){
  if(!data || typeof data !== 'object') throw new Error('invalid_payload');
  const childId = str(data.childId);
  const children = readObjects(CHILD_SHEET_NAME);
  const child = children.filter(c => c.id === childId)[0];
  if(!child) throw new Error('child_not_found');

  const type = str(data.type);
  if(USAGE_TYPES.indexOf(type) === -1) throw new Error('invalid_type');
  const startDate = requireDate(data.startDate, 'invalid_start_date', false);
  const endDate = requireDate(data.endDate, 'invalid_end_date', false);
  if(endDate < startDate) throw new Error('end_before_start');
  if(startDate < child.birthDate) throw new Error('before_birth');

  let hoursPerWeek = '';
  if(type === '육아기단축'){
    hoursPerWeek = Number(data.hoursPerWeek);
    if(!isFinite(hoursPerWeek) || hoursPerWeek < MIN_SHORT_HOURS || hoursPerWeek > MAX_SHORT_HOURS){
      throw new Error('invalid_hours');
    }
  }

  // 같은 직원의 다른 사용 기간과 겹치면 안 된다(자녀가 달라도 한 사람이 동시에 둘을 쓸 수 없다).
  const id = str(data.id);
  const siblingIds = {};
  children.forEach(c => { if(c.employeeId === child.employeeId) siblingIds[c.id] = true; });
  const clash = readObjects(USAGE_SHEET_NAME).some(u =>
    u.id !== id && siblingIds[u.childId] && u.startDate <= endDate && startDate <= u.endDate
  );
  if(clash) throw new Error('overlap');

  const newId = upsertRow(USAGE_SHEET_NAME, {
    id: id,
    childId: childId,
    type: type,
    startDate: startDate,
    endDate: endDate,
    hoursPerWeek: hoursPerWeek,
    memo: requireLen(data.memo, MAX_MEMO_LEN, 'memo_too_long')
  });
  return { id: newId };
}

function deleteEmployee(id){
  const empId = str(id);
  const childIds = readObjects(CHILD_SHEET_NAME).filter(c => c.employeeId === empId).map(c => c.id);
  const usages = childIds.length ? deleteRowsWhere(USAGE_SHEET_NAME, 'childId', childIds) : 0;
  const children = deleteRowsWhere(CHILD_SHEET_NAME, 'employeeId', [empId]);
  const employees = deleteRowsWhere(EMP_SHEET_NAME, 'id', [empId]);
  if(!employees) throw new Error('not_found');
  return { employees, children, usages };
}

function deleteChild(id){
  const childId = str(id);
  const usages = deleteRowsWhere(USAGE_SHEET_NAME, 'childId', [childId]);
  const children = deleteRowsWhere(CHILD_SHEET_NAME, 'id', [childId]);
  if(!children) throw new Error('not_found');
  return { children, usages };
}

function deleteUsage(id){
  const usages = deleteRowsWhere(USAGE_SHEET_NAME, 'id', [str(id)]);
  if(!usages) throw new Error('not_found');
  return { usages };
}
