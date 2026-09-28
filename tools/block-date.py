# -*- coding: utf-8 -*-
"""apply.html 의 BRANCH_BLOCKED(지점별 마감일) 을 안전하게 고친다.

  python3 tools/block-date.py 경주 2026-11-02            # 마감 추가
  python3 tools/block-date.py --unblock 경주 2026-11-02  # 마감 해제
  python3 tools/block-date.py --list                     # 현황 보기

날짜 형식, 접수 기간, 요일(일~목)을 검사하고 중복 없이 날짜순으로 정리한다.
"""
import io, os, re, sys, datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
APPLY = os.path.join(ROOT, 'apply.html')
WD = ['월','화','수','목','금','토','일']   # datetime.weekday()

def load():
    s = io.open(APPLY, encoding='utf-8').read()
    m = re.search(r'const BRANCH_BLOCKED = \{(.*?)\n\};', s, re.S)
    if not m: sys.exit('BRANCH_BLOCKED 블록을 찾지 못했습니다.')
    data = {}
    for line in m.group(1).split('\n'):
        bm = re.match(r"\s*'([^']+)':\s*\[(.*?)\],\s*$", line)
        if bm:
            data[bm.group(1)] = re.findall(r"'([\d-]+)'", bm.group(2))
    return s, m, data

def save(s, m, data):
    body = '\n'.join(
        "  '%s': [%s]," % (b, ', '.join("'%s'" % d for d in sorted(set(dates))))
        for b, dates in data.items())
    io.open(APPLY, 'w', encoding='utf-8').write(
        s[:m.start()] + 'const BRANCH_BLOCKED = {\n' + body + '\n};' + s[m.end():])

def check(branch, date, data):
    if branch not in data:
        sys.exit('지점 이름이 올바르지 않습니다. 가능: %s' % ', '.join(data))
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        sys.exit('날짜는 YYYY-MM-DD 형식이어야 합니다.')
    try:
        d = datetime.date(*map(int, date.split('-')))
    except ValueError:
        sys.exit('달력에 없는 날짜입니다: %s' % date)
    if not ('2026-10-01' <= date <= '2026-12-31'):
        sys.exit('접수 기간(2026-10-01~12-31) 밖입니다: %s' % date)
    if d.weekday() in (4, 5):
        sys.exit('%s 는 %s요일이라 이미 신청이 불가능합니다. 막을 필요가 없습니다.' % (date, WD[d.weekday()]))
    return d

def main():
    args = [a for a in sys.argv[1:]]
    s, m, data = load()

    if '--list' in args:
        total = sum(len(v) for v in data.values())
        print('지점별 마감일 (총 %d건)' % total)
        for b, dates in data.items():
            if dates:
                print('  %s: %s' % (b, ', '.join(
                    '%s(%s)' % (x, WD[datetime.date(*map(int, x.split('-'))).weekday()]) for x in dates)))
            else:
                print('  %s: 없음' % b)
        return

    unblock = '--unblock' in args
    if unblock: args.remove('--unblock')
    if len(args) != 2:
        sys.exit(__doc__)
    branch, date = args
    d = check(branch, date, data)

    if unblock:
        if date not in data[branch]:
            sys.exit('%s 에 %s 마감이 없습니다.' % (branch, date))
        data[branch].remove(date)
        print('해제: %s %s (%s요일)' % (branch, date, WD[d.weekday()]))
    else:
        if date in data[branch]:
            sys.exit('%s 은(는) 이미 %s 마감입니다.' % (date, branch))
        data[branch].append(date)
        print('마감: %s %s (%s요일)' % (branch, date, WD[d.weekday()]))

    save(s, m, data)

main()
