# -*- coding: utf-8 -*-
"""호텔 객실 현황표(.xls)를 읽어 apply.html 의 마감일 목록을 다시 만든다.

  python3 tools/import-availability.py <현황표.xls>          # 미리보기만
  python3 tools/import-availability.py <현황표.xls> --apply  # 실제 반영

시트 한 장이 지점 하나이고, 10/11/12월 세 덩어리가 세로로 이어진 형태를 가정한다.
각 덩어리는 '객실' 행(날짜 머리글) → '객실타입' 행(요일) → 객실타입별 잔여 수 행.

잔여가 0 이하(초과예약 음수 포함)면 마감으로 본다.
금·토·공휴일과 접수 기간 밖은 어차피 신청이 안 되므로 목록에 넣지 않는다.
한 지점의 선택 가능한 두 타입이 같은 날 모두 막히면 '지점 전체 마감' 하나로 합친다.
"""
import io, os, re, sys, json, datetime
import xlrd

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
APPLY = os.path.join(ROOT, 'apply.html')
ROOMS = ['디럭스 더블', '디럭스 트윈']

# ── 지점별 매핑 ────────────────────────────────────────────────────────
#   화면의 룸 타입  ->  현황표의 객실타입 목록 (여러 개면 하나라도 남으면 신청 가능)
#   None 이면 그 지점에는 해당 타입이 없다는 뜻 (신청 화면에서 선택지를 숨긴다)
#   추가 요금 객실(패밀리 트윈, 온돌 등)은 이용하지 않으므로 넣지 않는다.
MAPPING = {
    '경주': {'디럭스 더블': ['산전망 더블'],
             '디럭스 트윈': ['산전망 디럭스 트윈', '산전망 노발코니 디럭스 트윈']},
    '전주': {'디럭스 더블': None,
             '디럭스 트윈': ['시티뷰 디럭스 트윈']},
    '포항': {'디럭스 더블': ['더블'],
             '디럭스 트윈': ['트윈']},
    '목포': {'디럭스 더블': ['산전망 더블'],
             '디럭스 트윈': ['산전망 트윈']},
    '울산': {'디럭스 더블': ['더블'],
             '디럭스 트윈': ['트윈']},
}

# ── 현황표와 상관없이 늘 막아 두는 날 ────────────────────────────────
#   회사 사정으로 막는 날(연말, 사내 행사 등)은 호텔 현황표에 나오지 않는다.
#   여기에 적어 두면 현황표를 새로 반영해도 지워지지 않는다.
#   MANUAL_ALL  : 전 지점 마감
#   MANUAL_BRANCH: 특정 지점만 마감   예) {'경주': ['2026-12-24']}
MANUAL_ALL = ['2026-12-24']        # 12/24(목) 전 지점 마감
MANUAL_BRANCH = {
    '전주': ['2026-11-02', '2026-11-08', '2026-11-19', '2026-12-30'],   # 전주는 트윈 하나뿐이라 트윈 마감 = 지점 마감
    '포항': ['2026-11-22'],
}

#   룸 타입까지 지정해 늘 막아 두는 날  {지점: {룸타입: [날짜...]}}
#   호텔이 "이 날 이 타입은 안 된다" 고 따로 알려온 건을 여기 적어 둔다.
MANUAL_ROOM = {
    '경주': {
        '디럭스 트윈': ['2026-10-19', '2026-10-25', '2026-11-01', '2026-11-02', '2026-11-03',
                      '2026-11-05', '2026-11-09', '2026-12-31'],
        '디럭스 더블': ['2026-10-19', '2026-11-09', '2026-11-22'],
    },
    '포항': {
        '디럭스 더블': ['2026-12-20', '2026-12-23'],
    },
}

_gs = io.open(os.path.join(ROOT, 'Code.gs'), encoding='utf-8').read()
HOLIDAYS = set(re.findall(r'\d{4}-\d{2}-\d{2}',
               re.search(r'const HOLIDAYS = \{(.*?)\};', _gs, re.S).group(1)))
RANGE = ('2026-10-01', '2026-12-31')
WD = ['월','화','수','목','금','토','일']

def bookable(iso):
    if not (RANGE[0] <= iso <= RANGE[1]): return False
    d = datetime.date(*map(int, iso.split('-')))
    return d.weekday() not in (4, 5) and iso not in HOLIDAYS

def read_sheet(sh):
    """{객실타입: {날짜: 잔여}} 로 뽑는다."""
    rooms, header = {}, None
    for r in range(sh.nrows):
        a0 = str(sh.cell_value(r, 0)).strip()
        if a0 == '객실':
            header = {}
            for c in range(2, sh.ncols):
                m = re.match(r'^(\d{1,2})/(\d{1,2})$', str(sh.cell_value(r, c)).strip())
                if m: header[c] = '2026-%02d-%02d' % (int(m.group(1)), int(m.group(2)))
            continue
        if a0 in ('객실타입', '') or header is None: continue
        rooms.setdefault(a0, {})
        for c, iso in header.items():
            v = sh.cell_value(r, c)
            if v == '' or v is None: continue
            try: rooms[a0][iso] = int(float(v))
            except (TypeError, ValueError): pass
    return rooms

def compute(path):
    wb = xlrd.open_workbook(path)
    branch_blocked, room_blocked, report = {}, {}, {}
    for sh in wb.sheets():
        br = sh.name.split()[0]
        if br not in MAPPING:
            print('  ! 매핑에 없는 시트는 건너뜁니다: %s' % sh.name); continue
        raw = read_sheet(sh)
        mp = MAPPING[br]
        dates = sorted({d for v in raw.values() for d in v})
        per_type, missing = {}, []
        for rt in ROOMS:
            src = mp[rt]
            if src is None:
                per_type[rt] = None; continue
            for s in src:
                if s not in raw:
                    sys.exit('[%s] 현황표에 "%s" 객실타입이 없습니다. MAPPING 을 확인하세요.\n  시트에 있는 타입: %s'
                             % (br, s, ', '.join(raw)))
            # 매핑된 객실 중 하나라도 남아 있으면 신청 가능
            per_type[rt] = {d: max(raw[s].get(d, 0) for s in src) for d in dates}

        usable = [rt for rt in ROOMS if per_type[rt] is not None]
        bb, rb = [], {rt: [] for rt in ROOMS}
        for d in dates:
            if not bookable(d): continue
            full = [rt for rt in usable if per_type[rt][d] <= 0]
            if len(full) == len(usable):      # 선택 가능한 타입이 전부 0
                bb.append(d)
            else:
                for rt in full: rb[rt].append(d)
        for d in MANUAL_ALL + MANUAL_BRANCH.get(br, []):
            if bookable(d) and d not in bb:
                bb.append(d)
        # 변수 이름에 주의: 바깥 dates(현황표의 날짜 전체)를 가리면 집계가 틀어진다
        for rt, manual_dates in MANUAL_ROOM.get(br, {}).items():
            if rt not in usable: continue
            for md in manual_dates:
                if bookable(md) and md not in bb and md not in rb[rt]:
                    rb[rt].append(md)

        # 수동 지정까지 넣고 나서 다시 한 번 합친다.
        # 손으로 적은 타입별 마감이 합쳐져 "그 날은 아예 안 된다" 가 되는 경우가 있다.
        for d in sorted(set(sum((rb[rt] for rt in ROOMS), []))):
            if all(d in rb[rt] for rt in usable):
                bb.append(d)
                for rt in ROOMS:
                    if d in rb[rt]: rb[rt].remove(d)
        branch_blocked[br] = sorted(bb)
        room_blocked[br] = {rt: sorted(rb[rt]) for rt in ROOMS}
        report[br] = {'usable': usable, 'dates': len(dates),
                      'bookable': sum(1 for d in dates if bookable(d)),
                      'neg': sorted(d for rt in usable for d in dates
                                    if per_type[rt][d] < 0)}
    return branch_blocked, room_blocked, report

def js_lists(branch_blocked, room_blocked):
    def arr(ds): return '[%s]' % ', '.join("'%s'" % d for d in ds)
    b = '\n'.join("  '%s': %s," % (k, arr(v)) for k, v in branch_blocked.items())
    r = '\n'.join("  '%s': { %s }," % (k, ', '.join("'%s': %s" % (rt, arr(v[rt])) for rt in ROOMS))
                  for k, v in room_blocked.items())
    return b, r

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    path = sys.argv[1]
    apply_it = '--apply' in sys.argv
    bb, rb, rep = compute(path)

    print('현황표: %s\n' % os.path.basename(path))
    for br in bb:
        u = rep[br]['usable']
        print('%s — 선택 가능 타입: %s' % (br, ', '.join(u) if u else '없음'))
        print('   신청 가능 요일 %d일 중' % rep[br]['bookable'])
        print('     지점 전체 마감 %d일' % len(bb[br]))
        manual = [d for d in MANUAL_ALL + MANUAL_BRANCH.get(br, []) if bookable(d)]
        if manual:
            print('       (그 중 수동 지정: %s)' % ', '.join(sorted(set(manual))))
        for rt in ROOMS:
            if rt in u:
                left = rep[br]['bookable'] - len(bb[br]) - len(rb[br][rt])
                print('     %s 단독 마감 %d일  →  신청 가능 %d일' % (rt, len(rb[br][rt]), left))
            else:
                print('     %s 없음 (선택지에서 숨김)' % rt)
        if rep[br]['neg']:
            print('     ※ 초과예약(음수)으로 마감 처리: %s' % ', '.join(rep[br]['neg']))
        print()

    if not apply_it:
        print('미리보기입니다. 반영하려면 --apply 를 붙여 다시 실행하세요.')
        return

    s = io.open(APPLY, encoding='utf-8').read()
    bjs, rjs = js_lists(bb, rb)
    s = re.sub(r'const ROOM_BLOCKED = \{.*?\n\};',
               'const ROOM_BLOCKED = {\n' + rjs + '\n};', s, count=1, flags=re.S)
    s = re.sub(r'const BRANCH_BLOCKED = \{.*?\n\};',
               'const BRANCH_BLOCKED = {\n' + bjs + '\n};', s, count=1, flags=re.S)
    io.open(APPLY, 'w', encoding='utf-8').write(s)
    print('apply.html 에 반영했습니다.')

main()
