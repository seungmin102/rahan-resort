# -*- coding: utf-8 -*-
"""apply.html 의 마감일 목록(BRANCH_BLOCKED / ROOM_BLOCKED)을 안전하게 고친다.

  python3 tools/block-date.py 경주 2026-11-02                   # 경주 전체 마감
  python3 tools/block-date.py 경주 2026-11-02 "디럭스 트윈"       # 경주 트윈만 마감
  python3 tools/block-date.py --unblock 경주 2026-11-02          # 해제
  python3 tools/block-date.py --unblock 경주 2026-11-02 "디럭스 트윈"
  python3 tools/block-date.py --list                            # 현황

날짜 형식, 접수 기간(2026-10-01~12-31), 요일(일~목)을 검사하고
중복 없이 날짜순으로 정리한다.
"""
import io, os, re, sys, datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
APPLY = os.path.join(ROOT, 'apply.html')
WD = ['월','화','수','목','금','토','일']   # datetime.weekday()
ROOMS = ['디럭스 더블', '디럭스 트윈']

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
    return d

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
