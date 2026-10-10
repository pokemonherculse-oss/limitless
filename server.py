"""LIMITLESS: single-process HTTP server backed by an Excel workbook.

Deploy this application from a GitHub repository to a persistent Python/Docker server.
GitHub Pages alone cannot execute backend code or modify a workbook.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import secrets
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from github_excel import GitHubExcel, GitHubStorageError
from tournament_engine import advance, finish, standings, find_active, last_round

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
DATA_FILE = Path(os.getenv('LIMITLESS_EXCEL_PATH', str(ROOT / 'data' / 'limitless.xlsx'))).resolve()
REMOTE_EXCEL = GitHubExcel.from_environment()
ADMIN_USER = os.getenv('ADMIN_USER', 'admin')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', '')
COOKIE_SECRET = os.getenv('SESSION_SECRET', '') or secrets.token_hex(32)
LOCK = threading.RLock()
# Live battle chat exists only in process memory, never the workbook.
CHAT = {}
CHAT_REVISION = 0
CHAT_TTL = 3 * 3600
COLLECTIONS = ('players', 'tournaments', 'activeTournamentData', 'history')
EMPTY = {'version': 'v5', 'players': [], 'tournaments': [], 'activeTournamentData': [], 'history': []}
MISSING = object()
MAX_BODY = 2_000_000  # up to 2 MB per action; split data into workbook chunks


def password_hash(password):
    salt = secrets.token_bytes(16)
    key = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 200_000)
    return 'pbkdf2$' + salt.hex() + '$' + key.hex()


def verify_password(password, stored):
    if not isinstance(stored, str):
        return False
    if stored.startswith('pbkdf2$'):
        try:
            _, salt, hashed = stored.split('$')
            actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 200_000)
            return hmac.compare_digest(actual, bytes.fromhex(hashed))
        except (ValueError, TypeError):
            return False
    return hmac.compare_digest(password, stored)  # supports legacy localStorage migration


def json_clone(obj):
    return copy.deepcopy(obj)


def record_key(collection, item):
    if collection in ('players', 'tournaments'):
        return str(item['id'])
    if collection == 'activeTournamentData':
        return str(item['tournamentId']) + ':' + str(item['playerId'])
    return str(item['tournamentId'])


def excel_text(value):
    # Never allow user-provided names to become spreadsheet formulas.
    if isinstance(value, str) and value.startswith(('=', '+', '-', '@')):
        return "'" + value
    return value


def compact_completed_tournaments(state):
    """Retain final placements forever, not old pairings, teams or battle setup.

    Preserve a completed tournament's full record if it lacks a Hall of Fame
    result, so a legacy import never silently discards recoverable results.
    Upcoming/active tournaments are never stripped: a Render restart must be
    able to resume registrations, check-ins, matches and standings.
    """
    archived_ids = {str(h.get('tournamentId')) for h in state.get('history', [])}
    changed = False
    for index, tour in enumerate(state.get('tournaments', [])):
        if tour.get('status') != 'COMPLETED' or str(tour.get('id')) not in archived_ids:
            continue
        compact = {key: tour[key] for key in ('id', 'name', 'status', 'date') if key in tour}
        # Older screens can still identify and count the completed tournament.
        if tour != compact:
            state['tournaments'][index] = compact
            changed = True
    # Standings belong only to a live tournament; final standings live in history.
    if not any(t.get('status') == 'ACTIVE' for t in state.get('tournaments', [])) and state.get('activeTournamentData'):
        state['activeTournamentData'] = []
        changed = True
    return changed


def make_workbook(state, revision):
    wb = Workbook()
    meta = wb.active
    meta.title = 'Meta'
    meta.append(['Key', 'Value'])
    meta.append(['Schema', 'LIMITLESS-v5'])
    meta.append(['Revision', revision])
    meta.append(['Last Written UTC', datetime.now(timezone.utc).isoformat()])
    # Readable sheets expose ONLY the historical fields the organizer asked
    # to keep: tournament name, champion, runner-up and every final position.
    # The Records sheet below is the application's authoritative working state
    # (minimal account/login data plus recoverable *unfinished* tournaments).
    specs = [
        ('Players', ['ID', 'Username', 'Events', 'Championships', 'Runner-Ups'],
         lambda p: [str(p.get('id','')), excel_text(p.get('username','')), p.get('tournamentsPlayed',0), p.get('tournamentWins',0), p.get('runnerUps',0)], state['players']),
        ('Tournaments', ['ID', 'Name', 'Status', 'Date'],
         lambda t: [str(t.get('id','')), excel_text(t.get('name','')), t.get('status',''), excel_text(t.get('date',''))], state['tournaments']),
        ('ActivePlayers', ['Tournament ID', 'Player ID', 'Points', 'Wins', 'Losses'],
         lambda p: [str(p.get('tournamentId','')), str(p.get('playerId','')), p.get('points',0), p.get('wins',0), p.get('losses',0)], state['activeTournamentData']),
        ('History', ['Tournament ID', 'Tournament Name', 'Winner', 'Runner-Up', 'Players'],
         lambda h: [str(h.get('tournamentId','')), excel_text(h.get('tournamentName','')),
                    excel_text(next((r.get('playerName','') for r in h.get('results',[]) if r.get('isWinner')), '')),
                    excel_text(next((r.get('playerName','') for r in h.get('results',[]) if r.get('isRunnerUp')), '')),
                    len(h.get('results',[]))], state['history']),
    ]
    for sheet_name, headings, summarize, records in specs:
        ws = wb.create_sheet(sheet_name)
        ws.append(headings)
        for item in records:
            ws.append(summarize(item))
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = ws.dimensions
        for idx in range(1, len(headings)+1):
            ws.column_dimensions[__import__('openpyxl').utils.get_column_letter(idx)].width = 30 if idx == 2 else 19

    positions = wb.create_sheet('Final Positions')
    positions.append(['Tournament Name', 'Position', 'Player Name', 'Result'])
    positions.freeze_panes = 'A2'
    positions.column_dimensions['A'].width = 36
    positions.column_dimensions['B'].width = 14
    positions.column_dimensions['C'].width = 28
    positions.column_dimensions['D'].width = 18
    for history in state['history']:
        for item in sorted(history.get('results', []), key=lambda r: r.get('finalPosition', 9999)):
            positions.append([
                excel_text(history.get('tournamentName', '')),
                item.get('finalPosition',''),
                excel_text(item.get('playerName','')),
                'Winner' if item.get('isWinner') else ('Runner-Up' if item.get('isRunnerUp') else 'Participant'),
            ])
    positions.auto_filter.ref = positions.dimensions
    payload = wb.create_sheet('Records')
    payload.append(['Collection', 'Record Key', 'Part', 'JSON (authoritative)'])
    payload.freeze_panes = 'D2'
    payload.column_dimensions['A'].width = 24
    payload.column_dimensions['B'].width = 35
    payload.column_dimensions['C'].width = 10
    payload.column_dimensions['D'].width = 90
    for coll in COLLECTIONS:
        for record in state[coll]:
            content = json.dumps(record, separators=(',', ':'), ensure_ascii=True)
            for ix, start in enumerate(range(0, max(1,len(content)), 30000)):
                payload.append([coll, record_key(coll, record), ix, content[start:start+30000]])
    for ws in wb:
        ws.sheet_view.showGridLines = False
        for cell in ws[1]:
            cell.fill = PatternFill('solid', fgColor='17243E')
            cell.font = Font(bold=True, color='FFFFFF')
            cell.alignment = Alignment(vertical='center')
        ws.row_dimensions[1].height = 25
    return wb


def save_workbook(state, revision):
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    wb = make_workbook(state, revision)
    fd, tmp = tempfile.mkstemp(suffix='.xlsx', prefix='.limitless-', dir=DATA_FILE.parent)
    os.close(fd)
    try:
        wb.save(tmp)
        if DATA_FILE.is_file():
            # Keep a last-good backup in case a disk failure damages the workbook.
            shutil.copyfile(DATA_FILE, str(DATA_FILE) + '.bak')
        # Do not accept a registration or result until the durable GitHub copy succeeded.
        if REMOTE_EXCEL is not None:
            REMOTE_EXCEL.store(Path(tmp).read_bytes(), revision)
        os.replace(tmp, DATA_FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_workbook_data():
    if REMOTE_EXCEL is not None:
        downloaded = REMOTE_EXCEL.fetch()
        if downloaded is not None:
            DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
            DATA_FILE.write_bytes(downloaded)
        elif DATA_FILE.exists():
            # On Render the local filesystem is throwaway. Never upload stale local
            # copies into a brand-new GitHub repository unintentionally.
            DATA_FILE.unlink()
    if not DATA_FILE.is_file():
        save_workbook(json_clone(EMPTY), 0)
    wb = load_workbook(DATA_FILE, read_only=True, data_only=True)
    try:
        revision = int(wb['Meta']['B3'].value or 0)
        chunks = {}
        for coll, key, part, content in list(wb['Records'].values)[1:]:
            if coll not in COLLECTIONS:
                continue
            chunks.setdefault((coll, str(key)), []).append((int(part), str(content)))
        state = json_clone(EMPTY)
        for (coll, _), parts in chunks.items():
            state[coll].append(json.loads(''.join(x[1] for x in sorted(parts))))
        return state, revision
    finally:
        wb.close()


with LOCK:
    STATE, REVISION = load_workbook_data()


def safe_state(state):
    result = json_clone(state)
    for p in result['players']:
        p.pop('passwordHash', None)
    return result


def signed_session(role, identifier, expiry=None):
    expiry = expiry or (int(time.time()) + 7*86400)
    msg = f'{role}:{identifier}:{expiry}'
    mac = hmac.new(COOKIE_SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return f'{msg}:{mac}'


def decode_session(cookie_text):
    try:
        cookie = SimpleCookie()
        cookie.load(cookie_text or '')
        value = cookie.get('limitless_session')
        if not value:
            return None, None
        role, identifier, expiry, mac = value.value.split(':')
        msg = f'{role}:{identifier}:{expiry}'
        expected = hmac.new(COOKIE_SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()
        if int(expiry) < time.time() or not hmac.compare_digest(mac, expected):
            return None, None
        if role == 'admin':
            return ('admin', None) if identifier == ADMIN_USER else (None, None)
        if role == 'player':
            pid = int(identifier)
            if any(p['id'] == pid for p in STATE['players']):
                return 'player', pid
    except (ValueError, IndexError):
        pass
    return None, None


def id_value(item, selector):
    if isinstance(selector, dict):
        return all(str(item.get(k)) == str(v) for k, v in selector.items())
    return False


def resolve(root, path):
    item = root
    for component in path:
        if isinstance(component, dict) and isinstance(item, list):
            item = next((v for v in item if isinstance(v, dict) and id_value(v, component)), MISSING)
        elif isinstance(item, dict) and isinstance(component, str):
            item = item.get(component, MISSING)
        else:
            return MISSING
        if item is MISSING:
            return MISSING
    return item


def apply_op(root, op):
    kind, path = op.get('op'), op.get('path')
    if not isinstance(path, list) or not path or len(path) > 15:
        raise ValueError('Invalid path')
    parent = resolve(root, path[:-1])
    if parent is MISSING:
        # Allow creating intermediate plain dictionaries (e.g. tournament.entries).
        node = root
        for component in path[:-1]:
            if isinstance(node, dict) and isinstance(component, str):
                node = node.setdefault(component, {})
            elif isinstance(node, list) and isinstance(component, dict):
                node = next((v for v in node if isinstance(v, dict) and id_value(v, component)), MISSING)
            else:
                raise ValueError('Cannot resolve parent')
            if node is MISSING:
                raise ValueError('Cannot find parent record')
        parent = node
    final = path[-1]
    old = resolve(root, path)
    if 'before' in op:
        before = op['before']
        if old is MISSING:
            if before is not None:
                raise Conflict('Data has changed on another device')
        elif old != before:
            raise Conflict('Data has changed on another device')
    if kind == 'set':
        value = op.get('value')
        if isinstance(parent, dict) and isinstance(final, str):
            parent[final] = value
        elif isinstance(parent, list) and isinstance(final, dict):
            ix = next((i for i, v in enumerate(parent) if isinstance(v, dict) and id_value(v, final)), None)
            if ix is None:
                parent.append(value)
            else:
                parent[ix] = value
        else:
            raise ValueError('Unsupported set path')
    elif kind == 'delete':
        if isinstance(parent, dict) and isinstance(final, str):
            parent.pop(final, None)
        elif isinstance(parent, list) and isinstance(final, dict):
            parent[:] = [v for v in parent if not (isinstance(v, dict) and id_value(v, final))]
        else:
            raise ValueError('Unsupported delete path')
    elif kind in ('addSet','removeSet','append'):
        target = resolve(root, path)
        if target is MISSING and kind != 'removeSet' and isinstance(parent, dict) and isinstance(final, str):
            parent[final] = []
            target = parent[final]
        if not isinstance(target, list):
            raise ValueError('Expected an array')
        value = op.get('value')
        if kind == 'addSet' and value not in target:
            target.append(value)
        elif kind == 'removeSet':
            target[:] = [x for x in target if x != value]
        elif kind == 'append':
            target.append(value)
    else:
        raise ValueError('Unsupported operation')


class Conflict(Exception):
    pass


def find_match(state, tid, match_id):
    tour = next((t for t in state['tournaments'] if str(t.get('id')) == str(tid)), None)
    if not tour or tour.get('status') != 'ACTIVE' or not tour.get('pairings'):
        raise ValueError('No active tournament')
    last = tour['pairings'][-1]
    match = next((m for m in last.get('matches',[]) if m.get('matchId') == match_id), None)
    if match is None:
        raise ValueError('Match not found')
    return tour, last, match


def authorize_player_op(state, op, pid):
    path = op.get('path', [])
    kind = op.get('op')
    if not isinstance(path, list) or len(path) < 2:
        raise ValueError('Unauthorized change')
    if path[0] == 'tournaments' and isinstance(path[1], dict) and 'id' in path[1]:
        tid = path[1]['id']
        tour = next((t for t in state['tournaments'] if str(t['id']) == str(tid)), None)
        if not tour:
            raise ValueError('Tournament not found')
        if len(path) == 3 and path[2] == 'registeredPlayers':
            if tour['status'] != 'UPCOMING' or not tour.get('registrationOpen') or kind not in ('addSet','removeSet') or op.get('value') != pid:
                raise ValueError('Registration closed or forbidden')
            return
        if len(path) == 4 and path[2] == 'entries' and path[3] == str(pid):
            if tour['status'] != 'UPCOMING' or not tour.get('registrationOpen') or kind not in ('set','delete'):
                raise ValueError('Registration closed or forbidden')
            if kind == 'set' and (not isinstance(op.get('value'), dict) or len(json.dumps(op['value'])) > 16000):
                raise ValueError('Invalid team entry')
            return
        if len(path) >= 7 and path[2] == 'pairings' and isinstance(path[3], dict) and path[4] == 'matches' and isinstance(path[5], dict):
            tour, rnd, match = find_match(state, tid, path[5].get('matchId'))
            if rnd.get('processed') or pid not in (match.get('p1'), match.get('p2')):
                raise ValueError('Match already complete or inaccessible')
            field = path[6] if len(path) == 7 else None
            if field == 'winner' and kind == 'set' and op.get('value') in ('p1','p2') and not match.get('winner'):
                return
            if field == ('p1CheckIn' if match['p1'] == pid else 'p2CheckIn') and kind == 'set' and op.get('value') is True:
                return
            raise ValueError('Unauthorized match update')
    if path[0] == 'activeTournamentData' and len(path) == 3 and path[1] == {'playerId': pid} and path[2] == 'dropped' and kind == 'set' and op.get('value') is True:
        if any(t['status'] == 'ACTIVE' for t in state['tournaments']):
            return
    raise ValueError('Unauthorized change')


def resolve_due(state, now_ms):
    changed = False
    for t in state['tournaments']:
        if t.get('status') != 'ACTIVE' or not t.get('pairings'):
            continue
        rnd = t['pairings'][-1]
        if rnd.get('processed'):
            continue
        for m in rnd.get('matches', []):
            if m.get('p2') is None or m.get('winner') or not m.get('checkInDeadline') or now_ms < m['checkInDeadline']:
                continue
            if m.get('p1CheckIn') and m.get('p2CheckIn'):
                continue  # both checked in: let them finish the battle
            if m.get('p1CheckIn') and not m.get('p2CheckIn'):
                m['winner'] = 'p1'
            elif m.get('p2CheckIn') and not m.get('p1CheckIn'):
                m['winner'] = 'p2'
            else:
                m['winner'] = 'draw'
                m['noShow'] = True
            m['forfeit'] = True
            changed = True
    return changed


def clean_chat(state):
    # Chat is explicitly ephemeral, including in historical / imported matches.
    removed = False
    for tournament in state.get('tournaments', []):
        for pairing in tournament.get('pairings', []):
            for match in pairing.get('matches', []):
                if 'chat' in match:
                    match.pop('chat', None)
                    removed = True
    return removed


with LOCK:
    # One-time, non-destructive migration for old backups: old completed
    # pairings/team sheets disappear only AFTER Hall of Fame is recorded.
    chat_cleaned = clean_chat(STATE)
    archive_compacted = compact_completed_tournaments(STATE)
    if chat_cleaned or archive_compacted:
        REVISION += 1
        save_workbook(STATE, REVISION)

def chat_key(match_id):
    return str(match_id)


def prune_chat():
    global CHAT_REVISION
    now = time.time()
    live = set()
    for t in STATE['tournaments']:
        if t.get('status') != 'ACTIVE' or not t.get('pairings'):
            continue
        rnd = t['pairings'][-1]
        if not rnd.get('processed'):
            live.update(str(m['matchId']) for m in rnd.get('matches', []))
    for key in list(CHAT):
        if key not in live or now-CHAT[key]['updated'] > CHAT_TTL:
            CHAT.pop(key, None)
            CHAT_REVISION += 1


def visible_chat_state(state, role, pid):
    for t in state['tournaments']:
        if t.get('status') != 'ACTIVE' or not t.get('pairings'):
            continue
        r = t['pairings'][-1]
        if r.get('processed'):
            continue
        for m in r.get('matches', []):
            if role == 'admin' or (role == 'player' and pid in (m.get('p1'),m.get('p2'))):
                m['chat'] = json_clone(CHAT.get(chat_key(m['matchId']), {}).get('messages', []))
    return state


def commit_state(new_state):
    global STATE, REVISION
    standings(new_state)
    clean_chat(new_state)
    compact_completed_tournaments(new_state)
    rev = REVISION + 1
    save_workbook(new_state, rev)
    STATE, REVISION = new_state, rev
    prune_chat()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        if self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        elif self.path.endswith(('.html','.js')) or '.js?' in self.path:
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def send_json(self, obj, status=200, cookie=None):
        data = json.dumps(obj, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(data)

    def user_role(self):
        return decode_session(self.headers.get('Cookie'))

    def state_response(self):
        role, pid = self.user_role()
        prune_chat()
        return {'state':visible_chat_state(safe_state(STATE),role,pid), 'revision':REVISION, 'chatRevision':CHAT_REVISION, 'role':role, 'me': next(({'id':p['id'],'username':p['username']} for p in STATE['players'] if p['id']==pid), None) if pid is not None else None}

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/':
            self.send_response(302)
            self.send_header('Location', '/player/')
            self.end_headers()
            return
        if route == '/api/state':
            with LOCK:
                self.send_json(self.state_response())
            return
        if route == '/api/health':
            self.send_json({'status':'ok', 'storage':'github-excel' if REMOTE_EXCEL else 'local-excel', 'registrationFix':'atomic-v3', 'tournamentEngine':'server-v3', 'standings':'round-buchholz-v1'})
            return
        if route == '/api/export':
            with LOCK:
                role, _ = self.user_role()
                if role != 'admin':
                    return self.send_json({'error':'Admin login required'},403)
                data = DATA_FILE.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            self.send_header('Content-Disposition','attachment; filename="limitless.xlsx"')
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if route == '/admin':
            self.send_response(302)
            self.send_header('Location','/admin/')
            self.end_headers()
            return
        if route == '/player':
            self.send_response(302)
            self.send_header('Location','/player/')
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        route = urlsplit(self.path).path
        origin = self.headers.get('Origin')
        if origin:
            parsed = urlsplit(origin)
            if parsed.netloc != self.headers.get('Host') or parsed.scheme not in ('http','https'):
                return self.send_json({'error':'Invalid request origin'},403)
        try:
            size = int(self.headers.get('Content-Length',0))
            if not 0 < size <= MAX_BODY:
                return self.send_json({'error':'Invalid payload size'},413)
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                return self.send_json({'error':'Expected an object'},400)
            with LOCK:
                role, pid = self.user_role()
                if route == '/api/admin/login':
                    if not ADMIN_PASSWORD:
                        return self.send_json({'error':'Set ADMIN_PASSWORD on the server before admin login'},503)
                    if (hmac.compare_digest(str(payload.get('username','')), ADMIN_USER)
                            and hmac.compare_digest(str(payload.get('password','')), ADMIN_PASSWORD)):
                        token = signed_session('admin',ADMIN_USER)
                        return self.send_json({'ok':True},cookie=f'limitless_session={token}; Path=/; HttpOnly; SameSite=Lax'+('; Secure' if self.headers.get('X-Forwarded-Proto')=='https' else ''))
                    return self.send_json({'error':'Invalid admin credentials'},401)
                if route == '/api/logout':
                    return self.send_json({'ok':True},cookie='limitless_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
                if route == '/api/register':
                    username = str(payload.get('username','')).strip()
                    password = str(payload.get('password',''))
                    if not (3 <= len(username) <= 20) or not (6 <= len(password) <= 128):
                        return self.send_json({'error':'Username must be 3-20 characters and password at least 6 characters'},400)
                    if any(p['username'].casefold() == username.casefold() for p in STATE['players']):
                        return self.send_json({'error':'Username already registered'},409)
                    new = json_clone(STATE)
                    new_pid = (time.time_ns() // 1000) % (2**53-1)
                    while any(p['id'] == new_pid for p in new['players']):
                        new_pid += 1
                    new['players'].append({'id':new_pid,'username':username,'passwordHash':password_hash(password),'tournamentsPlayed':0,'tournamentWins':0,'runnerUps':0})
                    commit_state(new)
                    return self.send_json({'ok':True},cookie=f'limitless_session={signed_session("player",new_pid)}; Path=/; HttpOnly; SameSite=Lax'+('; Secure' if self.headers.get('X-Forwarded-Proto')=='https' else ''))
                if route == '/api/login':
                    username = str(payload.get('username','')).strip()
                    password = str(payload.get('password',''))
                    player = next((p for p in STATE['players'] if p['username'].casefold() == username.casefold() and verify_password(password,p.get('passwordHash',''))),None)
                    if player is None:
                        return self.send_json({'error':'Invalid username or password'},401)
                    if not player['passwordHash'].startswith('pbkdf2$'):
                        new = json_clone(STATE)
                        next(p for p in new['players'] if p['id']==player['id'])['passwordHash'] = password_hash(password)
                        commit_state(new)
                    return self.send_json({'ok':True},cookie=f'limitless_session={signed_session("player",player["id"])}; Path=/; HttpOnly; SameSite=Lax'+('; Secure' if self.headers.get('X-Forwarded-Proto')=='https' else ''))
                # Registration must be an atomic, authenticated server action.
                # Do not let an out-of-date browser resubmit or modify another
                # player's tournament entry through the generic patch endpoint.
                if route in ('/api/tournament/register', '/api/tournament/withdraw'):
                    if role != 'player':
                        return self.send_json({'error':'Player login required'},401)
                    tid = payload.get('tournamentId')
                    if not isinstance(tid, (str, int)) or isinstance(tid, bool):
                        return self.send_json({'error':'Invalid tournament'},400)
                    new = json_clone(STATE)
                    tournament = next((t for t in new['tournaments'] if str(t.get('id')) == str(tid)), None)
                    if tournament is None:
                        return self.send_json({'error':'Tournament not found'},404)
                    if tournament.get('status') != 'UPCOMING' or not tournament.get('registrationOpen'):
                        return self.send_json({'error':'Registration is closed'},409)
                    roster = tournament.setdefault('registeredPlayers', [])
                    entries = tournament.setdefault('entries', {})
                    if not isinstance(roster, list) or not isinstance(entries, dict):
                        return self.send_json({'error':'Tournament registration data is invalid'},409)
                    if route == '/api/tournament/register':
                        entry = payload.get('entry')
                        if not isinstance(entry, dict):
                            return self.send_json({'error':'Invalid registration entry'},400)
                        ign = entry.get('ign')
                        if not isinstance(ign, str) or not ign.strip() or len(ign.strip()) > 30:
                            return self.send_json({'error':'In-game name must contain 1-30 characters'},400)
                        # Existing team format remains intact for the tournament UI.
                        if not isinstance(entry.get('teamUrl', ''), str) or not isinstance(entry.get('teamText', ''), str) or not isinstance(entry.get('team', []), list):
                            return self.send_json({'error':'Invalid team entry'},400)
                        if len(json.dumps(entry)) > 16000:
                            return self.send_json({'error':'Registration entry too large'},400)
                        clean_entry = json_clone(entry)
                        clean_entry['ign'] = ign.strip()
                        if pid not in roster:
                            roster.append(pid)
                        entries[str(pid)] = clean_entry
                    else:
                        roster[:] = [member for member in roster if str(member) != str(pid)]
                        entries.pop(str(pid), None)
                    if new != STATE:
                        commit_state(new)
                    return self.send_json(self.state_response())
                # Atomic match updates: apply to the latest server state, never
                # replay an outdated client's copy of the whole tournament.
                if route == '/api/match/action':
                    action = payload.get('action')
                    tid = payload.get('tournamentId')
                    mid = payload.get('matchId')
                    if role not in ('admin','player'):
                        return self.send_json({'error':'Login required'},401)
                    if action not in ('checkin','result','reset','drop','addTime','resolveReport','joinReport'):
                        return self.send_json({'error':'Invalid match action'},400)
                    new = json_clone(STATE)
                    t = find_active(new, tid)
                    rnd = last_round(t)
                    if action == 'addTime':
                        if role != 'admin' or not rnd:
                            return self.send_json({'error':'Admin round access required'},403)
                        minutes = payload.get('minutes')
                        if not isinstance(minutes,int) or not 1 <= minutes <= 60:
                            return self.send_json({'error':'Invalid additional minutes'},400)
                        t['roundEndTime'] = max(int(time.time()*1000),t.get('roundEndTime') or 0) + minutes*60000
                    elif action == 'drop':
                        if role != 'player':
                            return self.send_json({'error':'Player login required'},403)
                        d=next((x for x in new['activeTournamentData'] if str(x.get('playerId'))==str(pid) and str(x.get('tournamentId'))==str(t['id'])), None)
                        if not d:
                            return self.send_json({'error':'Not registered for this tournament'},403)
                        if d.get('dropped'):
                            return self.send_json(self.state_response())
                        d['dropped']=True
                        if rnd and not rnd.get('processed'):
                            m=next((m for m in rnd['matches'] if pid in (m.get('p1'),m.get('p2'))),None)
                            if m and m.get('p2') is not None and not m.get('winner'):
                                m['winner']='p2' if m['p1']==pid else 'p1'
                                m['forfeit']=True
                    else:
                        if not rnd or rnd.get('processed'):
                            return self.send_json({'error':'This round is closed'},409)
                        m=next((m for m in rnd['matches'] if m.get('matchId')==mid),None)
                        if not m or m.get('p2') is None:
                            return self.send_json({'error':'Match not found'},404)
                        if role=='player' and pid not in (m['p1'],m['p2']):
                            return self.send_json({'error':'Not your match'},403)
                        if action == 'checkin':
                            if role != 'player':
                                return self.send_json({'error':'Player login required'},403)
                            if m.get('winner'):
                                return self.send_json({'error':'Match already decided'},409)
                            if m.get('checkInDeadline') and int(time.time()*1000)>m['checkInDeadline']:
                                return self.send_json({'error':'Check-in time has ended'},409)
                            m['p1CheckIn' if m['p1']==pid else 'p2CheckIn']=True
                        elif action == 'result':
                            result=payload.get('result')
                            if role=='player':
                                if result not in ('win','loss'):
                                    return self.send_json({'error':'Invalid result'},400)
                                if m.get('winner'):
                                    return self.send_json({'error':'Result already submitted; ask admin to reset it'},409)
                                win_first=(m['p1']==pid) == (result=='win')
                                m['winner']='p1' if win_first else 'p2'
                            else:
                                if result not in ('p1','p2','draw') or result=='draw' and rnd['phase']=='TOP_CUT':
                                    return self.send_json({'error':'Invalid bracket winner'},400)
                                if m.get('winner') and m['winner'] not in ('draw','noshow'):
                                    return self.send_json({'error':'Reset the result before changing it'},409)
                                m['winner']=result
                            m.pop('noShow',None)
                        elif action in ('resolveReport','joinReport'):
                            if role != 'admin':
                                return self.send_json({'error':'Admin login required'},403)
                            report=m.get('report')
                            if not isinstance(report,dict):
                                return self.send_json({'error':'Report not found'},404)
                            if action=='joinReport':
                                report['adminJoined']=True
                            else:
                                if report.get('status')!='OPEN':
                                    return self.send_json({'error':'Report already resolved'},409)
                                result=payload.get('result')
                                if result not in ('p1','p2','draw','dismiss') or result=='draw' and rnd['phase']=='TOP_CUT':
                                    return self.send_json({'error':'Invalid report decision'},400)
                                if result!='dismiss':
                                    if rnd.get('processed'):
                                        return self.send_json({'error':'Round is already finalized'},409)
                                    m['winner']=result
                                    m['forfeit']=False
                                    m['noShow']=False
                                report.update(status='RESOLVED',resolution=payload.get('resolution') or ('Report dismissed.' if result=='dismiss' else 'Admin decision: '+str(result)),resolvedTs=int(time.time()*1000))
                        elif action == 'reset':
                            if role != 'admin':
                                return self.send_json({'error':'Admin login required'},403)
                            m.update(winner=None,forfeit=False,noShow=False,checkInDeadline=int(time.time()*1000)+int(t.get('checkInMinutes') or 5)*60_000)
                    if new != STATE:
                        commit_state(new)
                    return self.send_json(self.state_response())
                if route in ('/api/tournament/advance','/api/tournament/finish'):
                    if role != 'admin':
                        return self.send_json({'error':'Admin login required'},403)
                    new=json_clone(STATE)
                    tid=payload.get('tournamentId')
                    if route.endswith('/advance'):
                        advance(new,payload.get('action'),tid)
                    else:
                        finish(new,tid,payload.get('force') is True)
                    commit_state(new)
                    return self.send_json(self.state_response())
                if route == '/api/chat/send':
                    global CHAT_REVISION
                    text = payload.get('text')
                    match_id = payload.get('matchId')
                    if not isinstance(match_id, str) or not isinstance(text, str) or not 0 < len(text.strip()) <= 500:
                        return self.send_json({'error':'Message must contain 1-500 characters'},400)
                    t = next((t for t in STATE['tournaments'] if t.get('status') == 'ACTIVE' and t.get('pairings')), None)
                    rnd = t['pairings'][-1] if t else {}
                    m = next((m for m in rnd.get('matches',[]) if m.get('matchId') == match_id), None)
                    if not m or rnd.get('processed'):
                        return self.send_json({'error':'Battle chat is closed'},409)
                    if role != 'admin' and not (role == 'player' and pid in (m.get('p1'),m.get('p2'))):
                        return self.send_json({'error':'Not authorized for this battle'},403)
                    key=chat_key(match_id)
                    channel=CHAT.setdefault(key,{'messages':[],'updated':time.time()})
                    channel['messages'].append({'from':'ADMIN' if role=='admin' else pid,
                                                'senderId':'ADMIN' if role=='admin' else pid,
                                                'text':text.strip(),'ts':int(time.time()*1000)})
                    channel['messages']=channel['messages'][-100:]
                    channel['updated']=time.time()
                    CHAT_REVISION += 1
                    return self.send_json({'ok':True})
                if route == '/api/import':
                    if role != 'admin':
                        return self.send_json({'error':'Admin login required'},403)
                    if any(STATE[c] for c in COLLECTIONS):
                        return self.send_json({'error':'Excel database already has records. Import is allowed only into an empty database.'},409)
                    new = payload.get('state')
                    if not isinstance(new,dict) or new.get('version') != 'v5' or any(not isinstance(new.get(c),list) for c in COLLECTIONS):
                        return self.send_json({'error':'Not a LIMITLESS v5 database'},400)
                    clean_chat(new)
                    for p in new['players']:
                        if 'passwordHash' in p and not str(p['passwordHash']).startswith('pbkdf2$'):
                            p['passwordHash'] = password_hash(str(p['passwordHash']))
                    commit_state(new)
                    return self.send_json(self.state_response())
                if route == '/api/patch':
                    if role not in ('admin','player'):
                        return self.send_json({'error':'Login required'},401)
                    ops = payload.get('ops')
                    if not isinstance(ops,list) or len(ops) > 500:
                        return self.send_json({'error':'Invalid changes'},400)
                    new = json_clone(STATE)
                    for op in ops:
                        if not isinstance(op,dict):
                            raise ValueError('Invalid change')
                        if 'chat' in op.get('path', []):
                            raise ValueError('Chat messages must use the temporary chat endpoint')
                        if role == 'player':
                            authorize_player_op(new, op, pid)
                        apply_op(new,op)
                    if new != STATE:
                        commit_state(new)
                    return self.send_json(self.state_response())
                return self.send_json({'error':'Endpoint not found'},404)
        except Conflict as e:
            return self.send_json({'error':str(e)},409)
        except (ValueError,KeyError,TypeError) as e:
            return self.send_json({'error':str(e)},400)
        except Exception:
            import traceback
            traceback.print_exc()
            return self.send_json({'error':'Could not save to GitHub Excel. Check Render logs and retry.' if REMOTE_EXCEL else 'Server could not save the Excel workbook'},500)


def tick_loop():
    while True:
        time.sleep(3)
        with LOCK:
            new = json_clone(STATE)
            if resolve_due(new, int(time.time()*1000)):
                try:
                    commit_state(new)
                except Exception:
                    import traceback
                    traceback.print_exc()


if __name__ == '__main__':
    threading.Thread(target=tick_loop, daemon=True).start()
    port = int(os.environ.get('PORT','8000'))
    host = os.environ.get('HOST','0.0.0.0')
    print('LIMITLESS listening on http://%s:%s; Excel: %s' % (host,port,DATA_FILE), flush=True)
    ThreadingHTTPServer((host,port),Handler).serve_forever()
