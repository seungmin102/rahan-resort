# -*- coding: utf-8 -*-
"""apply.html 의 마감일 목록(BRANCH_BLOCKED / ROOM_BLOCKED)을 안전하게 고친다.

  python3 tools/block-date.py 경주 2026-11-02                   # 경주 전체 마감
  python3 tools/block-date.py 경주 2026-11-02 "디럭스 트윈"       # 경주 트윈만 마감
  python3 tools/block-date.py --unblock 경주 2026-11-02          # 해제
  python3 tools/block-date.py --unblock 경주 2026-11-02 "디럭스 트윈"
  python3 tools/block-date.py --range 2026-10-01 2026-10-16 경주   # 기간 일괄
  python3 tools/block-date.py --dates 2026-11-04,2026-11-12 경주   # 날짜 여러 개
  python3 tools/block-date.py --list                            # 현황

날짜 형식, 접수 기간(2026-10-01~12-31), 요일(일~목)을 검사하고
중복 없이 날짜순으로 정리한다.
"""
import io, os, re, sys, datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
APPLY = os.path.join(ROOT, 'apply.html')
WD = ['월','화','수','목','금','토','일']   # datetime.weekday()
ROOMS = ['디럭스 더블', '디럭스 트윈']

# 공휴일은 Code.gs 것을 그대로 읽어 쓴다 (목록을 또 복사해 두면 어긋난다)
_gs = io.open(os.path.join(ROOT, 'Code.gs'), encoding='utf-8').read()
HOLIDAYS = set(re.findall(r'\d{4}-\d{2}-\d{2}',
               re.search(r'const HOLIDAYS = \{(.*?)\};', _gs, re.S).group(1)))

def dates_in(text):
    return re.findall(r"'([\d-]+)'", text)

def load():
    s = io.open(APPLY, encoding='utf-8').read()
    bm = re.search(r'const BRANCH_BLOCKED = \{(.*?)\n\};', s, re.S)
    rm = re.search(r'const ROOM_BLOCKED = \{(.*?)\n\};', s, re.S)
    if not bm or not rm:
        sys.exit('마감일 목록 블록을 찾지 못했습니다. apply.html 구조가 바뀌었는지 확인하세요.')
    branch = {}
    for line in bm.group(1).split('\n'):
        m = re.match(r"\s*'([^']+)':\s*\[(.*?)\],\s*$", line)
        if m: branch[m.group(1)] = dates_in(m.group(2))
    room = {}
    for line in rm.group(1).split('\n'):
        m = re.match(r"\s*'([^']+)':\s*\{(.*?)\},\s*$", line)
        if m:
            room[m.group(1)] = {}
            for rmm in re.finditer(r"'([^']+)':\s*\[(.*?)\]", m.group(2)):
                room[m.group(1)][rmm.group(1)] = dates_in(rmm.group(2))
    return s, bm, rm, branch, room

def save(s, bm, rm, branch, room):
    def arr(ds): return '[%s]' % ', '.join("'%s'" % d for d in sorted(set(ds)))
    bbody = '\n'.join("  '%s': %s," % (b, arr(d)) for b, d in branch.items())
    rbody = '\n'.join(
        "  '%s': { %s }," % (b, ', '.join("'%s': %s" % (r, arr(room[b][r])) for r in ROOMS))
        for b in room)
    # 뒤쪽(ROOM_BLOCKED)부터 바꿔야 앞 블록의 위치가 틀어지지 않는다
    s = s[:rm.start()] + 'const ROOM_BLOCKED = {\n' + rbody + '\n};' + s[rm.end():]
    s = s[:bm.start()] + 'const BRANCH_BLOCKED = {\n' + bbody + '\n};' + s[bm.end():]
    io.open(APPLY, 'w', encoding='utf-8').write(s)

def check(branch_name, date, room_name, branch):
    if branch_name not in branch:
        sys.exit('지점 이름이 올바르지 않습니다. 가능: %s' % ', '.join(branch))
    if room_name is not None and room_name not in ROOMS:
        sys.exit('룸 타입이 올바르지 않습니다. 가능: %s' % ', '.join(ROOMS))
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        sys.exit('날짜는 YYYY-MM-DD 형식이어야 합니다.')
    try:
        d = datetime.date(*map(int, date.split('-')))
    except ValueError:
        sys.exit('달력에 없는 날짜입니다: %s' % date)
    if not ('2026-10-01' <= date <= '2026-12-31'):
        sys.exit('접수 기간(2026-10-01~12-31) 밖입니다: %s' % date)
    if d.weekday() in (4, 5):
        sys.exit('%s 는 %s요일이라 이미 신청이 불가능합니다. 날짜를 다시 확인해 주세요.'
                 % (date, WD[d.weekday()]))
    if date in HOLIDAYS:
        sys.exit('%s 는 공휴일이라 이미 신청이 불가능합니다. 날짜를 다시 확인해 주세요.' % date)
    return d

def all_days(start, end):
    d0 = datetime.date(*map(int, start.split('-')))
    d1 = datetime.date(*map(int, end.split('-')))
    if d1 < d0: sys.exit('시작일이 종료일보다 뒤입니다.')
    out, d = [], d0
    while d <= d1:
        out.append(d.isoformat()); d += datetime.timedelta(days=1)
    return out

def unbookable_reason(iso):
    """막을 필요가 없는 날이면 그 이유를, 정상이면 None 을 돌려준다."""
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', iso): return '날짜 형식 오류'
    try: d = datetime.date(*map(int, iso.split('-')))
    except ValueError: return '달력에 없는 날짜'
    if not ('2026-10-01' <= iso <= '2026-12-31'): return '접수 기간 밖'
    if d.weekday() in (4, 5): return '%s요일이라 이미 신청 불가' % WD[d.weekday()]
    if iso in HOLIDAYS: return '공휴일이라 이미 신청 불가'
    return None

def bookable_days(start, end):
    """기간 안에서 실제로 신청 가능한 날(일~목, 공휴일 아님)만 돌려준다."""
    d0 = datetime.date(*map(int, start.split('-')))
    d1 = datetime.date(*map(int, end.split('-')))
    if d1 < d0: sys.exit('시작일이 종료일보다 뒤입니다.')
    out, d = [], d0
    while d <= d1:
        iso = d.isoformat()
        if d.weekday() not in (4, 5) and iso not in HOLIDAYS and '2026-10-01' <= iso <= '2026-12-31':
            out.append(iso)
        d += datetime.timedelta(days=1)
    return out

def fmt(x): return '%s(%s)' % (x, WD[datetime.date(*map(int, x.split('-'))).weekday()])

def show(branch, room):
    total = sum(len(v) for v in branch.values()) + sum(len(d) for b in room.values() for d in b.values())
    print('마감일 현황 (총 %d건)' % total)
    for b in branch:
        parts = []
        if branch[b]: parts.append('지점 전체 ' + ', '.join(fmt(x) for x in branch[b]))
        for r in ROOMS:
            ds = room.get(b, {}).get(r, [])
            if ds: parts.append('%s %s' % (r, ', '.join(fmt(x) for x in ds)))
        print('  %s: %s' % (b, ' | '.join(parts) if parts else '없음'))

def main():
    args = sys.argv[1:]
    s, bm, rm, branch, room = load()

    if '--list' in args:
        show(branch, room); return

    unblock = '--unblock' in args
    if unblock: args.remove('--unblock')

    # 여러 날짜를 한 번에: --range 시작 종료  /  --dates 2026-11-04,2026-11-12,...
    # 막을 수 없는 날은 건너뛰고 왜 건너뛰었는지 전부 보고한다.
    wanted = None
    if '--range' in args:
        i = args.index('--range')
        wanted = all_days(args[i+1], args[i+2])
        args = args[:i] + args[i+3:]
    elif '--dates' in args:
        i = args.index('--dates')
        wanted = [x.strip() for x in args[i+1].split(',') if x.strip()]
        args = args[:i] + args[i+2:]

    if wanted is not None:
        if len(args) not in (1, 2): sys.exit(__doc__)
        branch_name = args[0]
        room_name = args[1] if len(args) == 2 else None
        if branch_name not in branch:
            sys.exit('지점 이름이 올바르지 않습니다. 가능: %s' % ', '.join(branch))
        if room_name is not None and room_name not in ROOMS:
            sys.exit('룸 타입이 올바르지 않습니다. 가능: %s' % ', '.join(ROOMS))

        target = room[branch_name][room_name] if room_name else branch[branch_name]
        label = '%s %s' % (branch_name, room_name) if room_name else '%s 전체' % branch_name
        done, skipped = [], []
        for iso in wanted:
            why = unbookable_reason(iso)
            if why:
                skipped.append((iso, why)); continue
            if unblock:
                if iso in target: target.remove(iso); done.append(iso)
                else: skipped.append((iso, '마감되어 있지 않음'))
            else:
                if iso in target:
                    skipped.append((iso, '이미 마감'))
                elif room_name and iso in branch[branch_name]:
                    skipped.append((iso, '지점 전체가 이미 마감'))
                else:
                    target.append(iso); done.append(iso)

        print('%s — %s %d일' % (label, '해제' if unblock else '마감', len(done)))
        for x in done: print('   %s' % fmt(x))
        if skipped:
            print('건너뜀 %d일' % len(skipped))
            for x, why in skipped: print('   %s  ← %s' % (fmt(x), why))
        save(s, bm, rm, branch, room)
        print()
        s2, bm2, rm2, b2, r2 = load(); show(b2, r2)
        return

    if len(args) not in (2, 3): sys.exit(__doc__)
    branch_name, date = args[0], args[1]
    room_name = args[2] if len(args) == 3 else None
    d = check(branch_name, date, room_name, branch)

    target = room[branch_name][room_name] if room_name else branch[branch_name]
    label = '%s %s' % (branch_name, room_name) if room_name else '%s 전체' % branch_name

    if unblock:
        if date not in target:
            sys.exit('%s 에 %s 마감이 없습니다.' % (label, date))
        target.remove(date)
        print('해제: %s / %s' % (label, fmt(date)))
    else:
        if date in target:
            sys.exit('%s 은(는) 이미 %s 마감입니다.' % (date, label))
        if room_name and date in branch[branch_name]:
            sys.exit('%s 은(는) 이미 %s 지점 전체가 마감입니다. 룸 타입 마감은 필요 없습니다.'
                     % (date, branch_name))
        target.append(date)
        print('마감: %s / %s' % (label, fmt(date)))

    save(s, bm, rm, branch, room)
    print()
    s2, bm2, rm2, b2, r2 = load()
    show(b2, r2)

try:
    main()
except BrokenPipeError:
    pass   # head 등으로 출력을 잘라도 오류처럼 보이지 않게
