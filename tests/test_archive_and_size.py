"""Regression test: keep live event functionality, but archive only final results.

Mock GitHub's Excel file interface; the test never calls actual GitHub/Render.
"""
import base64
import hashlib
import importlib
import io
import json
import os
import sys
import tempfile
import threading
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import HTTPCookieProcessor, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

with tempfile.TemporaryDirectory() as d:
    remote = Path(d) / 'remote.xlsx'
    os.environ.update({
        'GITHUB_DATA_REPO': 'sample/limitless-data',
        'GITHUB_TOKEN': 'fake-test-token',
        'ADMIN_USER': 'admin',
        'ADMIN_PASSWORD': 'testing-only-secret',
        'SESSION_SECRET': 'testing-long-fixed-session-secret',
        'LIMITLESS_EXCEL_PATH': str(Path(d) / 'local.xlsx')
    })
    import github_excel

    def mocked_github(self, path, method='GET', payload=None):
        if path == '/repos/sample/limitless-data':
            return 200, {'full_name':'sample/limitless-data'}
        if path.startswith('/repos/sample/limitless-data/contents/') and method == 'GET':
            if not remote.exists():
                return 404, None
            raw = remote.read_bytes()
            return 200, {'type':'file','sha':hashlib.sha1(raw).hexdigest(),
                         'encoding':'base64','content':base64.b64encode(raw).decode()}
        if path == '/repos/sample/limitless-data/contents/limitless.xlsx' and method == 'PUT':
            if remote.exists():
                assert payload['sha'] == hashlib.sha1(remote.read_bytes()).hexdigest()
            else:
                assert 'sha' not in payload
            raw = base64.b64decode(payload['content'])
            remote.write_bytes(raw)
            return 200, {'content':{'sha':hashlib.sha1(raw).hexdigest()}}
        raise AssertionError((path,method))

    github_excel.GitHubExcel._request = mocked_github
    import server
    httpd = ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
    base = f'http://127.0.0.1:{httpd.server_port}'
    thread = threading.Thread(target=httpd.serve_forever,daemon=True)
    thread.start()

    def client():
        return build_opener(HTTPCookieProcessor(CookieJar()))

    def req(opener,route,data=None):
        payload = None if data is None else json.dumps(data).encode()
        with opener.open(Request(base+route,data=payload,
                                 headers={'Content-Type':'application/json'} if payload else {}),timeout=8) as r:
            if route == '/api/export':
                return r.read()
            return json.load(r)

    admin, a, b = client(), client(), client()
    assert req(admin,'/api/admin/login',{'username':'admin','password':'testing-only-secret'})['ok']
    assert req(a,'/api/register',{'username':'TrainerOne','password':'abc123456'})['ok']
    assert req(b,'/api/register',{'username':'TrainerTwo','password':'abc123456'})['ok']
    state = req(admin,'/api/state')['state']
    pid1,pid2 = [p['id'] for p in state['players']]
    active = {
        'id':500,'name':'Sunday Pokémon Cup','status':'ACTIVE','date':'2026-10-11',
        'registrationOpen':False,'currentRound':1,'roundTime':50,'totalRounds':1,
        'bio':'Should disappear after completion','teamSheet':'long rules',
        'entries':{str(pid1):{'teamUrl':'https://example.invalid/team-private'}},
        'registeredPlayers':[pid1,pid2],
        'pairings':[{'round':1,'phase':'SWISS','processed':False,'matches':[
            {'matchId':'battle-500','p1':pid1,'p2':pid2,'winner':None,'chat':[
                {'from':pid1,'text':'old forbidden chat'}
            ]}]}]
    }
    rows = [
        {'playerId':pid1,'tournamentId':500,'position':1,'points':3,'wins':1,'losses':0},
        {'playerId':pid2,'tournamentId':500,'position':2,'points':0,'wins':0,'losses':1},
    ]
    req(admin,'/api/patch',{'ops':[
        {'op':'set','path':['tournaments',{'id':500}],'value':active},
        {'op':'set','path':['activeTournamentData',{'playerId':pid1}],'value':rows[0]},
        {'op':'set','path':['activeTournamentData',{'playerId':pid2}],'value':rows[1]}
    ]})
    assert req(a,'/api/chat/send',{'matchId':'battle-500','text':'123-456 temporary battle ID'})['ok']
    view = req(b,'/api/state')['state']
    assert view['tournaments'][0]['pairings'][0]['matches'][0]['chat'][0]['text'] == '123-456 temporary battle ID'

    results = [
        {'playerId':pid1,'playerName':'TrainerOne','finalPosition':1,'isWinner':True,'isRunnerUp':False},
        {'playerId':pid2,'playerName':'TrainerTwo','finalPosition':2,'isWinner':False,'isRunnerUp':True},
    ]
    # Simulate admin finishing the tournament. Server must prune the round
    # even if an older browser sends a heavyweight full record.
    finished = dict(active,status='COMPLETED',registrationOpen=False)
    final = {'tournamentId':500,'tournamentName':'Sunday Pokémon Cup','completedAt':12345678,'results':results}
    req(admin,'/api/patch',{'ops':[
        {'op':'set','path':['tournaments',{'id':500}],'value':finished},
        {'op':'set','path':['history',{'tournamentId':500}],'value':final},
    ]})
    current = req(admin,'/api/state')['state']
    assert current['tournaments'] == [{'id':500,'name':'Sunday Pokémon Cup','status':'COMPLETED','date':'2026-10-11'}], current['tournaments']
    assert current['activeTournamentData'] == []
    assert current['history'][0]['results'] == results
    assert len(current['players']) == 2
    assert 'chat' not in json.dumps(current)

    from openpyxl import load_workbook
    raw = req(admin,'/api/export')
    book = load_workbook(io.BytesIO(raw),read_only=True)
    try:
        assert book['History']['C2'].value == 'TrainerOne'
        assert book['History']['D2'].value == 'TrainerTwo'
        assert [book['Final Positions']['B2'].value,book['Final Positions']['C2'].value] == [1,'TrainerOne']
        assert [book['Final Positions']['B3'].value,book['Final Positions']['C3'].value] == [2,'TrainerTwo']
        for sh in book:
            cells = '\n'.join(str(row) for row in sh.values)
            assert '123-456 temporary battle ID' not in cells
            assert 'old forbidden chat' not in cells
            assert 'https://example.invalid/team-private' not in cells
            assert 'long rules' not in cells
    finally:
        book.close()

    # Render restart, even with total loss of the local workbook.
    httpd.shutdown()
    httpd.server_close()
    Path(os.environ['LIMITLESS_EXCEL_PATH']).unlink()
    server = importlib.reload(server)
    assert len(server.STATE['players']) == 2
    assert server.STATE['history'][0]['results'] == results
    assert server.STATE['tournaments'][0]['name'] == 'Sunday Pokémon Cup'
    assert server.CHAT == {}
    assert server.STATE['tournaments'][0]['status'] == 'COMPLETED'
    print('PASS: active match + cross-player chat, final positions and podium stored, old pairings and chat removed, remote Excel recovery, player logins preserved')
