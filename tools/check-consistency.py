# -*- coding: utf-8 -*-
"""Code.gs / apply.html / admin.html 에 중복으로 들어있는 규칙이 서로 맞는지 확인."""
import io, re, sys

import os
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
gs    = io.open(R+'Code.gs', encoding='utf-8').read()
apply_= io.open(R+'apply.html', encoding='utf-8').read()
admin = io.open(R+'admin.html', encoding='utf-8').read()

fail = []
def check(label, a, b, an='Code.gs', bn='apply.html'):
    if a == b:
        print('  OK   %s' % label)
    else:
        fail.append(label)
        print('  MISMATCH %s\n       %s: %r\n       %s: %r' % (label, an, a, bn, b))

def dates(text):
    return sorted(set(re.findall(r'\d{4}-\d{2}-\d{2}', text)))

# 1) 공휴일
gs_hol = dates(re.search(r'const HOLIDAYS = \{(.*?)\};', gs, re.S).group(1))
ap_hol = dates(re.search(r'const HOLIDAYS_2026 = new Set\(\[(.*?)\]\);', apply_, re.S).group(1))
check('공휴일 목록 (%d일)' % len(gs_hol), gs_hol, ap_hol)

# 2) 접수 기간
gs_range = (re.search(r"RANGE_START = '([\d-]+)'", gs).group(1),
            re.search(r"RANGE_END   = '([\d-]+)'", gs).group(1))
ap_range = (re.search(r"RANGE_START = '([\d-]+)'", apply_).group(1),
            re.search(r"RANGE_END = '([\d-]+)'", apply_).group(1))
check('접수 기간', gs_range, ap_range)
ad_range = re.search(r"inAllowedRange\(dateStr\)\{ return dateStr >= '([\d-]+)' && dateStr <= '([\d-]+)'", admin)
check('접수 기간 (관리자)', gs_range, ad_range.groups(), 'Code.gs', 'admin.html')

# 3) 선택지: 서버 상수 vs 신청 폼 option
def opts(name):
    m = re.search(r'<select[^>]*id="%s".*?</select>' % name, apply_, re.S).group(0)
    return [v for v in re.findall(r'<option value="([^"]*)"', m) if v]
check('지점',   re.findall(r"'([^']+)'", re.search(r'const BRANCHES = \[(.*?)\]', gs).group(1)), opts('branch'))
check('룸타입', re.findall(r"'([^']+)'", re.search(r'const ROOMTYPES = \[(.*?)\]', gs).group(1)), opts('roomtype'))
check('박수',   re.findall(r"'([^']+)'", re.search(r'const NIGHTS_OPTIONS = \[(.*?)\]', gs).group(1)), opts('nights'))

# 4) 상태값: 서버 vs 관리자 드롭다운 vs 필터탭
gs_st = re.findall(r"'([^']+)'", re.search(r'const STATUSES = \[(.*?)\]', gs).group(1))
sel   = re.search(r'<select class="statusSelect.*?</select>', admin, re.S).group(0)
check('상태값 (드롭다운)', gs_st, re.findall(r'<option value="([^"]+)"', sel), 'Code.gs', 'admin.html')
tabs  = re.findall(r'data-status="([^"]+)"', re.search(r'id="statusFilter".*?</div>', admin, re.S).group(0))
check('상태값 (필터탭)', gs_st, [t for t in tabs if t != 'all'], 'Code.gs', 'admin.html')

# 5) version 액션 목록 vs 관리자 화면이 요구하는 액션
gs_actions = re.findall(r"'([^']+)'", re.search(r'const SUPPORTED_ACTIONS = \[(.*?)\];', gs, re.S).group(1))
req = re.findall(r'^\s{2}(\w+):', re.search(r'const REQUIRED_ACTIONS = \{(.*?)\};', admin, re.S).group(1), re.M)
missing = [a for a in req if a not in gs_actions]
if missing: fail.append('REQUIRED_ACTIONS'); print('  MISMATCH 관리자가 요구하는 액션이 서버 목록에 없음: %s' % missing)
else: print('  OK   관리자 요구 액션 %d개 모두 서버 목록에 있음' % len(req))

# 6) SUPPORTED_ACTIONS 에 적힌 액션이 실제로 코드에 분기되어 있는지
undeclared = [a for a in gs_actions if a != 'version' and ("action === '%s'" % a) not in gs]
if undeclared: fail.append('SUPPORTED_ACTIONS'); print('  MISMATCH 목록에만 있고 구현이 없는 액션: %s' % undeclared)
else: print('  OK   선언된 액션 %d개 모두 실제 분기 존재' % len(gs_actions))

# 7) 프론트가 호출하는 액션이 서버에 있는지
called = set(re.findall(r"api(?:Get|Post)\('([^']+)'", apply_ + admin))
unknown = sorted(a for a in called if a not in gs_actions)
if unknown: fail.append('호출 액션'); print('  MISMATCH 화면이 부르는데 서버에 없는 액션: %s' % unknown)
else: print('  OK   화면이 부르는 액션 %d개 모두 서버에 있음' % len(called))

# 8) API_URL 일치
u1 = re.search(r"API_URL: '([^']+)'", apply_).group(1)
u2 = re.search(r"API_URL: '([^']+)'", admin).group(1)
check('API_URL', u1, u2, 'apply.html', 'admin.html')

print()
print('불일치 %d건' % len(fail))
sys.exit(1 if fail else 0)
