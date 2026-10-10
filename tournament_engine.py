"""Atomic LIMITLESS tournament operations and deterministic Swiss standings.

All functions mutate a copied server state under the existing server lock.
Finished events retain only name, winner, runner-up and final placements.
"""
from __future__ import annotations
import random
import time


def find_active(state, tid=None):
    for t in state['tournaments']:
        if t.get('status') == 'ACTIVE' and (tid is None or str(t['id']) == str(tid)):
            return t
    raise ValueError('No active tournament found')


def last_round(t):
    return (t.get('pairings') or [None])[-1]


def pending(round_):
    if round_ is None:
        return 0
    return sum(1 for m in round_.get('matches', []) if m.get('p2') is not None and
               (not m.get('winner') or round_.get('phase') == 'TOP_CUT' and m.get('winner') not in ('p1', 'p2')))


def standings(state):
    """Derive standings from every decided Swiss match, including current round.

    Tie break: match points > opponents' match points (Buchholz) > wins >
    later-round weighted performance > fewer losses > stable player ID.
    Each round contributes at most once; no repeated score increments.
    """
    try:
        t = find_active(state)
    except ValueError:
        return
    data = [r for r in state.get('activeTournamentData', []) if str(r.get('tournamentId')) == str(t['id'])]
    by_id = {str(r['playerId']): r for r in data}
    for d in data:
        d.update(points=0, wins=0, losses=0, draws=0, tb=0, roundStrength=0, roundResults=[], opponents=[], hadBye=False)
    for index, rnd in enumerate(t.get('pairings') or []):
        if rnd.get('phase') != 'SWISS':
            continue
        for match in rnd.get('matches', []):
            a = by_id.get(str(match.get('p1')))
            b = by_id.get(str(match.get('p2'))) if match.get('p2') is not None else None
            if not a:
                continue
            result = match.get('winner')
            if b:
                a['opponents'].append(b['playerId'])
                b['opponents'].append(a['playerId'])
            if not b:
                a['hadBye'] = True
                a['roundResults'].append('B')
                if result == 'p1':
                    a['wins'] += 1
                    a['points'] += 3
                continue
            if result == 'p1':
                a['wins'] += 1
                a['points'] += 3
                a['roundStrength'] += index + 1
                b['losses'] += 1
                a['roundResults'].append('W')
                b['roundResults'].append('L')
            elif result == 'p2':
                b['wins'] += 1
                b['points'] += 3
                b['roundStrength'] += index + 1
                a['losses'] += 1
                a['roundResults'].append('L')
                b['roundResults'].append('W')
            elif result == 'noshow' or result == 'draw' and match.get('noShow'):
                a['losses'] += 1
                b['losses'] += 1
                a['roundResults'].append('N')
                b['roundResults'].append('N')
            elif result == 'draw':
                a['draws'] += 1
                b['draws'] += 1
                a['points'] += 1
                b['points'] += 1
                a['roundResults'].append('D')
                b['roundResults'].append('D')
            else:
                a['roundResults'].append('-')
                b['roundResults'].append('-')
    for d in data:
        d['tb'] = sum(by_id[str(o)]['points'] for o in d['opponents'] if str(o) in by_id)
    data.sort(key=lambda d: (-d['points'], -d['tb'], -d['wins'], -d['roundStrength'], d['losses'], str(d['playerId'])))
    for i, d in enumerate(data):
        d['position'] = i + 1
    others = [r for r in state.get('activeTournamentData', []) if str(r.get('tournamentId')) != str(t['id'])]
    state['activeTournamentData'] = data + others


def require_ready(t):
    rnd = last_round(t)
    if pending(rnd):
        raise ValueError('Finish all matches before advancing to the next round.')
    if rnd:
        rnd['processed'] = True


def checkin_deadline(t):
    return int(time.time() * 1000) + max(1, int(t.get('checkInMinutes') or 5)) * 60_000


def make_match(t, a, b, index=0, phase='SWISS'):
    return {'matchId': f'{"tc" if phase == "TOP_CUT" else "m"}_{time.time_ns()}_{index}',
            'p1':a, 'p2':b, 'p1CheckIn': b is None, 'p2CheckIn': b is None,
            'checkInDeadline':checkin_deadline(t) if b is not None else None,
            'winner':'p1' if b is None else None}


def generate_pairs(ids, by_id):
    """Prefer never-played opponents, falling back to fewest repeats."""
    ids = list(ids)
    memo_budget = [25000]
    def backtrack(players):
        memo_budget[0] -= 1
        if memo_budget[0] < 0:
            return None
        if not players:
            return []
        a, rest = players[0], players[1:]
        for i, b in enumerate(rest):
            if str(b) in {str(x) for x in by_id[str(a)].get('opponents', [])}:
                continue
            result = backtrack(rest[:i] + rest[i+1:])
            if result is not None:
                return [(a, b)] + result
        return None
    result = backtrack(ids)
    if result is not None:
        return result
    result = []
    while len(ids) >= 2:
        a = ids.pop(0)
        opponents = {str(x) for x in by_id[str(a)].get('opponents', [])}
        i = next((i for i, x in enumerate(ids) if str(x) not in opponents), 0)
        result.append((a, ids.pop(i)))
    return result


def bracket_seeds(n):
    seeds = [1]
    while len(seeds) < n:
        k = len(seeds) * 2
        seeds = [v for s in seeds for v in (s, k + 1 - s)]
    return seeds


def bracket_label(n):
    return 'Finals' if n == 2 else 'Semi-Finals' if n == 4 else f'Top {n}'


def advance(state, action, tournament_id=None):
    if action == 'start':
        t = next((x for x in state['tournaments'] if str(x.get('id')) == str(tournament_id)), None)
        if not t or t.get('status') != 'UPCOMING':
            raise ValueError('Tournament cannot be started.')
        if any(x.get('status') == 'ACTIVE' for x in state['tournaments']):
            raise ValueError('Another tournament is already active.')
        roster = [pid for pid in dict.fromkeys(t.get('registeredPlayers', []))
                  if any(str(p['id']) == str(pid) for p in state['players'])]
        if len(roster) < 2:
            raise ValueError('At least two registered players are required.')
        t.update(registeredPlayers=roster, status='ACTIVE', registrationOpen=False,
                 phase='SWISS', currentRound=0, pairings=[], roundEndTime=0)
        state['activeTournamentData'] = [dict(tournamentId=t['id'],playerId=pid,points=0,wins=0,losses=0,
                                              draws=0,position=i+1,opponents=[],hadBye=False,tb=0)
                                         for i, pid in enumerate(roster)]
        return
    t = find_active(state, tournament_id)
    if action == 'nextSwiss':
        if t.get('phase') != 'SWISS':
            raise ValueError('Swiss phase has ended.')
        require_ready(t)
        if int(t.get('currentRound') or 0) >= int(t.get('totalRounds') or 1):
            raise ValueError('All Swiss rounds are finished. Start Top Cut.')
        standings(state)
        by_id = {str(d['playerId']):d for d in state['activeTournamentData']}
        order = [d['playerId'] for d in state['activeTournamentData'] if not d.get('dropped')]
        if len(order) < 2:
            raise ValueError('At least two players must remain.')
        if not t.get('currentRound'):
            random.shuffle(order)
        t['currentRound'] = int(t.get('currentRound') or 0) + 1
        bye = None
        if len(order) % 2:
            bye = next((x for x in reversed(order) if not by_id[str(x)].get('hadBye')), order[-1])
            order.remove(bye)
        matches = [make_match(t, a, b, i) for i,(a,b) in enumerate(generate_pairs(order, by_id))]
        if bye is not None:
            matches.append(make_match(t, bye, None, len(matches)))
        t['pairings'].append(dict(round=t['currentRound'], phase='SWISS', matches=matches))
        t['roundEndTime'] = int(time.time()*1000) + int(t.get('roundTime') or 20) * 60_000
        return
    if action == 'topCut':
        if t.get('phase') != 'SWISS':
            raise ValueError('Top Cut has already begun.')
        require_ready(t)
        if t.get('currentRound',0) < t.get('totalRounds',1):
            raise ValueError('All Swiss rounds must be completed first.')
        standings(state)
        ranked = [d for d in state['activeTournamentData'] if not d.get('dropped')]
        if len(ranked) < 2:
            raise ValueError('Not enough players remain.')
        limit = min(len(ranked), int(t.get('topCut') or 2))
        n = max(v for v in (2,4,8,16,32,64) if v <= max(2, limit))
        ids = [ranked[s-1]['playerId'] for s in bracket_seeds(n)]
        label = bracket_label(n)
        t.update(phase='TOP_CUT', topCutRoundStr=label)
        t['pairings'].append(dict(round=label,phase='TOP_CUT',matches=[make_match(t,ids[i],ids[i+1],i,'TOP_CUT') for i in range(0,n,2)]))
        t['roundEndTime'] = int(time.time()*1000) + int(t.get('roundTime') or 20)*60_000
        return
    if action == 'nextBracket':
        if t.get('phase') != 'TOP_CUT':
            raise ValueError('Top Cut has not started.')
        last = last_round(t)
        require_ready(t)
        if len(last['matches']) <= 1:
            raise ValueError('Final already reached. End the tournament instead.')
        winners = [m['p1'] if m['winner'] == 'p1' else m['p2'] for m in last['matches']]
        label = bracket_label(len(winners))
        dropped = {str(d['playerId']) for d in state['activeTournamentData'] if d.get('dropped')}
        matches = [make_match(t,winners[i],winners[i+1],i,'TOP_CUT') for i in range(0,len(winners),2)]
        for m in matches:
            if str(m['p1']) in dropped and str(m['p2']) not in dropped:
                m['winner'] = 'p2'
            elif str(m['p2']) in dropped and str(m['p1']) not in dropped:
                m['winner'] = 'p1'
        t['pairings'].append(dict(round=label,phase='TOP_CUT',matches=matches))
        t['topCutRoundStr'] = label
        t['roundEndTime'] = int(time.time()*1000) + int(t.get('roundTime') or 20)*60_000
        return
    raise ValueError('Unknown tournament action.')


def final_order(state, t, champion=None, runner=None):
    # Bracket results outrank Swiss results. Within equal elimination stages,
    # compare round-aware Swiss standings.
    ranked = [d['playerId'] for d in state['activeTournamentData']]
    seeds = [x for x in (champion,runner) if x is not None]
    stage = {}
    bracket = set()
    for index, rnd in enumerate(r for r in t.get('pairings',[]) if r.get('phase') == 'TOP_CUT'):
        for m in rnd.get('matches', []):
            bracket.add(str(m['p1']))
            if m.get('p2') is not None:
                bracket.add(str(m['p2']))
            if m.get('winner') in ('p1','p2'):
                eliminated = m['p2'] if m['winner']=='p1' else m['p1']
                if eliminated is not None:
                    stage[str(eliminated)] = index
    swiss_position = {str(pid):i for i,pid in enumerate(ranked)}
    def score(pid):
        return (-(stage.get(str(pid),999 if str(pid) in bracket else -1)), swiss_position.get(str(pid),9999))
    rest = sorted([pid for pid in ranked if pid not in seeds],key=score)
    return seeds + rest


def finish(state, tournament_id=None, force=False):
    t = find_active(state, tournament_id)
    if any(str(h.get('tournamentId')) == str(t['id']) for h in state['history']):
        raise ValueError('Tournament has already been archived.')
    standings(state)
    champion = runner = None
    if not force:
        rnd = last_round(t)
        if t.get('phase') != 'TOP_CUT' or not rnd or len(rnd.get('matches', [])) != 1:
            raise ValueError('Reach the Top Cut final before concluding the tournament.')
        match = rnd['matches'][0]
        if match.get('winner') not in ('p1','p2'):
            raise ValueError('Report the final match winner first.')
        champion = match['p1'] if match['winner']=='p1' else match['p2']
        runner = match['p2'] if match['winner']=='p1' else match['p1']
    order = final_order(state,t,champion,runner)
    if len(order) < 2:
        raise ValueError('At least two players are needed for final placements.')
    if champion is None:
        champion, runner = order[:2]
    by_id = {str(p['id']):p for p in state['players']}
    records=[]
    for index,pid in enumerate(order):
        p=by_id.get(str(pid))
        records.append(dict(playerId=pid, playerName=p.get('username','Unknown') if p else 'Unknown',
                            finalPosition=index+1, isWinner=pid==champion,isRunnerUp=pid==runner))
        if p:
            p['tournamentsPlayed']=int(p.get('tournamentsPlayed') or 0)+1
            if pid==champion: p['tournamentWins']=int(p.get('tournamentWins') or 0)+1
            if pid==runner: p['runnerUps']=int(p.get('runnerUps') or 0)+1
    state['history'].append(dict(tournamentId=t['id'],tournamentName=t['name'],completedAt=int(time.time()*1000),results=records))
    state['activeTournamentData']=[d for d in state['activeTournamentData'] if str(d.get('tournamentId'))!=str(t['id'])]
    for key in list(t):
        if key not in ('id','name','status','date'):
            del t[key]
    t['status']='COMPLETED'
    return records
