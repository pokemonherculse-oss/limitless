// ==========================================
// ADMIN LOGIN (default credentials)
// NOTE: this is a front-end gate only - the page source is public on GitHub.
// ==========================================
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin@123bk';
const AUTH_KEY = 'limitless_admin_auth';
const isAdminAuthed = () => sessionStorage.getItem(AUTH_KEY) === '1';
function applyAuthState() {
    const gate = document.getElementById('admin-login');
    if (gate) gate.classList.toggle('hidden', isAdminAuthed());
}
window.adminLogout = function () {
    sessionStorage.removeItem(AUTH_KEY);
    window.location.reload();
};
document.getElementById('admin-login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const u = document.getElementById('admin-user').value.trim();
    const p = document.getElementById('admin-pass').value;
    if (u === ADMIN_USER && p === ADMIN_PASS) {
        sessionStorage.setItem(AUTH_KEY, '1');
        document.getElementById('admin-login-err').classList.add('hidden');
        this.reset();
        applyAuthState();
        renderCurrent();
    } else {
        document.getElementById('admin-login-err').classList.remove('hidden');
    }
});
applyAuthState();

// ==========================================
// LIMITLESS ADMIN  (same data format as the player app: limitless_db / v5)
// ==========================================
const DB_KEY = 'limitless_db';
const DB_VERSION = 'v5';

function normalizeDB(d) {
    d.players = d.players || [];
    d.tournaments = d.tournaments || [];
    d.activeTournamentData = d.activeTournamentData || [];
    d.history = d.history || [];
    return d;
}
function readDB() {
    try {
        const parsed = JSON.parse(localStorage.getItem(DB_KEY));
        if (parsed && parsed.version === DB_VERSION) return normalizeDB(parsed);
    } catch (e) { /* corrupted -> treated as missing */ }
    return null;
}

let db = readDB();
if (!db) {
    db = { version: DB_VERSION, players: [], tournaments: [], activeTournamentData: [], history: [] };
    localStorage.setItem(DB_KEY, JSON.stringify(db));
}
let lastRaw = localStorage.getItem(DB_KEY);

function saveDB() {
    const raw = JSON.stringify(db);
    localStorage.setItem(DB_KEY, raw);
    lastRaw = raw;
}
// ALWAYS call before changing anything, so players' newest data is never overwritten by a stale copy.
function reloadDB() {
    const fresh = readDB();
    if (fresh) { db = fresh; lastRaw = localStorage.getItem(DB_KEY); }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = id => db.players.find(p => p.id === id)?.username || 'Unknown';
const getActive = () => db.tournaments.find(t => t.status === 'ACTIVE');
const lastRound = t => t && t.pairings && t.pairings[t.pairings.length - 1];
// Check-in is a TIMER: minutes each pair gets, from the moment pairings go up, to check in.
const checkInMs = t => ((t && t.checkInMinutes) || 5) * 60 * 1000;
const newDeadline = t => Date.now() + checkInMs(t);

let activeSubTab = 'pairings';
let currentTab = 'dashboard';

// ==========================================
// NAVIGATION + LIVE SYNC
// ==========================================
window.switchTab = function (tabId, btnElement = null) {
    reloadDB();
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.add('hidden'));
    document.getElementById(tabId).classList.remove('hidden');

    if (btnElement) {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.remove('bg-pokered', 'text-white', 'border-red-400');
            btn.classList.add('text-gray-400', 'border-transparent');
        });
        btnElement.classList.add('bg-pokered', 'text-white', 'border-red-400');
        btnElement.classList.remove('text-gray-400', 'border-transparent');
    }
    currentTab = tabId;
    renderCurrent();
};

window.switchSubTab = function (tab) {
    activeSubTab = tab;
    renderActiveTournament();
};

function renderCurrent() {
    if (currentTab === 'dashboard') renderDashboard();
    else if (currentTab === 'players') renderPlayers();
    else if (currentTab === 'active') renderActiveTournament();
    else if (currentTab === 'history') renderHistory();
    renderReportAlerts();
    renderChatModal();
}

// Pull in changes made by the player app: instantly (storage event) + 1s safety net.
function syncFromStorage() {
    const raw = localStorage.getItem(DB_KEY);
    if (raw !== lastRaw) {
        reloadDB();
        renderCurrent();
        return true;
    }
    return false;
}
window.addEventListener('storage', e => { if (e.key === DB_KEY || e.key === null) syncFromStorage(); });
setInterval(() => {
    if (!isAdminAuthed()) return;   // no background actions while logged out
    const synced = syncFromStorage();
    const resolved = resolveCheckIns();      // auto-forfeit when a pair's check-in timer runs out
    if (!synced && !resolved && currentTab === 'active') updateTimer();
}, 1000);

// ==========================================
// DASHBOARD + PLAYERS
// ==========================================
function renderDashboard() {
    document.getElementById('dash-players').innerText = db.players.length;
    document.getElementById('dash-active').innerText = db.tournaments.filter(t => t.status === 'ACTIVE').length;
    document.getElementById('dash-completed').innerText = db.tournaments.filter(t => t.status === 'COMPLETED').length;
}

function renderPlayers() {
    const tbody = document.getElementById('players-tbody');
    const sorted = [...db.players].sort((a, b) =>
        (b.tournamentWins || 0) - (a.tournamentWins || 0) ||
        (b.runnerUps || 0) - (a.runnerUps || 0) ||
        (b.tournamentsPlayed || 0) - (a.tournamentsPlayed || 0) ||
        a.username.localeCompare(b.username));
    let html = '';
    sorted.forEach(p => {
        html += `<tr class="hover:bg-gray-800/70 transition-colors group">
            <td class="px-6 py-4 font-bold text-white text-lg tracking-wide group-hover:text-pokeblue transition-colors">${esc(p.username)}</td>
            <td class="px-6 py-4 text-gray-300 font-medium">${p.tournamentsPlayed || 0}</td>
            <td class="px-6 py-4 text-pokegold font-bold">${p.tournamentWins || 0}</td>
            <td class="px-6 py-4 text-gray-400 font-medium">${p.runnerUps || 0}</td>
            <td class="px-6 py-4 text-right"><button onclick="editPlayer(${p.id})" class="text-pokered border border-pokered px-4 py-1 rounded-tr-lg rounded-bl-lg font-bold text-xs tracking-widest uppercase">Update</button> <button onclick="deletePlayer(${p.id})" class="ml-2 text-gray-400 border border-gray-700 hover:text-white hover:border-pokered px-4 py-1 rounded-tr-lg rounded-bl-lg font-bold text-xs tracking-widest uppercase">Delete</button></td>
        </tr>`;
    });
    if (!html) html = `<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500 uppercase tracking-widest text-sm">No trainers registered yet.</td></tr>`;
    if (tbody.innerHTML !== html) tbody.innerHTML = html;
}

window.editPlayer = function (id) {
    reloadDB();
    const player = db.players.find(p => p.id === id);
    if (!player) return;
    const input = prompt("Update Trainer Name:", player.username);
    if (input === null) return;
    const newName = input.trim();
    if (!newName) return;
    reloadDB();
    const target = db.players.find(p => p.id === id);
    if (!target) return;
    if (db.players.some(p => p.id !== id && p.username.toLowerCase() === newName.toLowerCase())) return alert("That trainer name is already taken.");
    target.username = newName;
    // keep archived results in sync with the new name
    db.history.forEach(h => h.results.forEach(r => { if (r.playerId === id) r.playerName = newName; }));
    saveDB();
    renderPlayers();
};

// ==========================================
// CREATE TOURNAMENT
// ==========================================
document.getElementById('create-tournament-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const roundTime = parseInt(document.getElementById('t-time').value);
    const totalRounds = parseInt(document.getElementById('t-swiss-count').value);
    if (!(roundTime > 0)) return alert("Round time must be at least 1 minute.");
    if (!(totalRounds > 0)) return alert("Total Swiss rounds must be at least 1.");
    const checkInMinutes = parseInt(document.getElementById('t-checkin').value);
    if (!(checkInMinutes > 0)) return alert("Check-in time must be at least 1 minute.");

    reloadDB();
    db.tournaments.push({
        id: Date.now(),
        name: document.getElementById('t-name').value.trim(),
        bio: document.getElementById('t-bio').value,
        date: document.getElementById('t-date').value,
        checkInMinutes,
        registrationOpen: false,      // admin opens registration manually from Hall of Fame
        roundTime, totalRounds,
        topCut: parseInt(document.getElementById('t-cut').value),
        teamSheet: document.getElementById('t-sheet').value,
        status: 'UPCOMING',
        phase: 'SWISS',
        currentRound: 0,
        registeredPlayers: [],
        pairings: []
    });
    saveDB();
    this.reset();
    document.getElementById('t-time').value = 50;
    document.getElementById('t-swiss-count').value = 5;
    document.getElementById('t-checkin').value = 5;
    switchTab('history', document.querySelectorAll('.nav-btn')[4]);
});

// ==========================================
// TOURNAMENT ENGINE
// ==========================================
function isPending(m, phase) {
    if (m.p2 === null) return false;                       // bye
    if (!m.winner) return true;
    return phase === 'TOP_CUT' && (m.winner === 'draw' || m.winner === 'noshow');   // bracket needs a real winner
}
function pendingIn(round) { return round ? round.matches.filter(m => isPending(m, round.phase)).length : 0; }

function recomputeStandings() {
    const data = db.activeTournamentData;
    const pts = {};
    data.forEach(d => pts[d.playerId] = d.points);
    data.forEach(d => d.tb = (d.opponents || []).reduce((s, o) => s + (pts[o] || 0), 0)); // opponents' points (tiebreak)
    data.sort((a, b) => b.points - a.points || b.wins - a.wins || (b.tb || 0) - (a.tb || 0));
    data.forEach((d, i) => d.position = i + 1);
}

// Returns false while matches are unfinished. Scores each Swiss round exactly once.
function processRoundScores(t) {
    const round = lastRound(t);
    if (!round) return true;
    if (pendingIn(round) > 0) return false;

    if (round.phase === 'SWISS' && !round.processed) {
        round.matches.forEach(m => {
            const d1 = db.activeTournamentData.find(x => x.playerId === m.p1);
            const d2 = m.p2 ? db.activeTournamentData.find(x => x.playerId === m.p2) : null;
            if (m.winner === 'p1') { if (d1) { d1.wins++; d1.points += 3; } if (d2) d2.losses++; }
            else if (m.winner === 'p2') { if (d1) d1.losses++; if (d2) { d2.wins++; d2.points += 3; } }
            else if (m.winner === 'noshow') { if (d1) d1.losses++; if (d2) d2.losses++; }   // neither checked in: double loss
            else if (m.winner === 'draw') {
                if (d1) { d1.draws++; d1.points += 1; }
                if (d2) { d2.draws++; d2.points += 1; }
            }
        });
        round.processed = true;
        recomputeStandings();
    }
    return true;
}

// Finds a full set of pairings with no rematches (backtracking); falls back to fewest rematches.
function findPairs(ids, byId) {
    let budget = 20000;
    function solve(list) {
        if (list.length === 0) return [];
        if (--budget < 0) return null;
        const [first, ...rest] = list;
        const played = byId(first).opponents || [];
        for (let i = 0; i < rest.length; i++) {
            if (played.includes(rest[i])) continue;
            const sub = solve(rest.filter((_, j) => j !== i));
            if (sub) return [[first, rest[i]], ...sub];
        }
        return null;
    }
    const result = solve(ids);
    if (result) return result;

    const list = [...ids], out = [];
    while (list.length > 1) {
        const p1 = list.shift();
        const played = byId(p1).opponents || [];
        let idx = list.findIndex(p => !played.includes(p));
        if (idx === -1) idx = 0;
        out.push([p1, list.splice(idx, 1)[0]]);
    }
    return out;
}

function generateSwissPairing(t) {
    const data = db.activeTournamentData;
    const byId = id => data.find(d => d.playerId === id);

    let order = data.filter(d => !d.dropped).sort((a, b) => b.points - a.points || b.wins - a.wins || (b.tb || 0) - (a.tb || 0));
    if (t.currentRound === 1) {
        for (let i = order.length - 1; i > 0; i--) {           // fair shuffle for round 1
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
    }
    let ids = order.map(d => d.playerId);

    // Odd player count: the lowest-ranked player who hasn't had a bye yet gets it.
    let byeId = null;
    if (ids.length % 2 === 1) {
        for (let i = ids.length - 1; i >= 0; i--) { if (!byId(ids[i]).hadBye) { byeId = ids[i]; break; } }
        if (byeId === null) byeId = ids[ids.length - 1];
        ids = ids.filter(id => id !== byeId);
    }

    const matches = findPairs(ids, byId).map(([p1, p2]) => {
        byId(p1).opponents.push(p2);
        byId(p2).opponents.push(p1);
        return { matchId: 'm_' + Date.now() + '_' + p1, p1, p2, p1CheckIn: false, p2CheckIn: false, checkInDeadline: newDeadline(t), winner: null, chat: [] };
    });

    if (byeId !== null) {
        byId(byeId).hadBye = true;
        matches.push({ matchId: 'm_' + Date.now() + '_bye', p1: byeId, p2: null, p1CheckIn: true, p2CheckIn: true, winner: 'p1', chat: [] });
    }
    t.pairings.push({ round: t.currentRound, phase: 'SWISS', matches });
}

// Standard bracket seeding for any power of two (1v8, 4v5, 2v7, 3v6 ...)
function getBracketSeeds(n) {
    let seeds = [1];
    while (seeds.length < n) {
        const size = seeds.length * 2;
        seeds = seeds.flatMap(s => [s, size + 1 - s]);
    }
    return seeds;
}
const bracketLabel = n => n === 2 ? 'Finals' : (n === 4 ? 'Semi-Finals' : `Top ${n}`);

window.startTournament = function (id) {
    reloadDB();
    const t = db.tournaments.find(x => x.id === id);
    if (!t || t.status !== 'UPCOMING') return;
    if (db.tournaments.some(x => x.status === 'ACTIVE')) return alert("A tournament is already active!");

    const roster = (t.registeredPlayers || []).filter(pid => db.players.some(p => p.id === pid));
    if (roster.length < 2) return alert("At least 2 trainers must be registered to begin.");
    if (!confirm(`Begin "${t.name}" with ${roster.length} trainers? Registration will be locked.`)) return;

    reloadDB();   // pick up anyone who registered while the dialog was open
    const t2 = db.tournaments.find(x => x.id === id);
    const finalRoster = (t2.registeredPlayers || []).filter(pid => db.players.some(p => p.id === pid));
    if (finalRoster.length < 2) return alert("At least 2 trainers must be registered to begin.");

    t2.registeredPlayers = finalRoster;
    t2.status = 'ACTIVE';
    t2.registrationOpen = false;   // registration locks when the admin starts the event
    t2.phase = 'SWISS';
    t2.currentRound = 0;          // admin starts every round manually
    t2.pairings = [];
    t2.roundEndTime = 0;

    db.activeTournamentData = finalRoster.map((playerId, i) => ({
        tournamentId: t2.id, playerId, points: 0, wins: 0, losses: 0, draws: 0, position: i + 1, opponents: [], hadBye: false, tb: 0
    }));

    activeSubTab = 'pairings';
    saveDB();
    switchTab('active', document.querySelectorAll('.nav-btn')[3]);
};

window.deleteTournament = function (id) {
    reloadDB();
    const t = db.tournaments.find(x => x.id === id);
    if (!t || t.status !== 'UPCOMING') return;
    if (!confirm(`Cancel "${t.name}"? Its registrations will be lost.`)) return;
    reloadDB();
    db.tournaments = db.tournaments.filter(x => !(x.id === id && x.status === 'UPCOMING'));
    saveDB();
    renderHistory();
};

window.startNextRound = function () {
    reloadDB();
    const t = getActive();
    if (!t || t.phase !== 'SWISS') return;
    if (!processRoundScores(t)) return alert("Matches are still in progress! All matches must be finished.");
    if (db.activeTournamentData.filter(d => !d.dropped).length < 2) { saveDB(); return alert("Fewer than 2 trainers remain in the tournament."); }
    if (t.currentRound >= t.totalRounds) { saveDB(); renderActiveTournament(); return alert("All Swiss rounds are done. Start the Top Cut."); }
    t.currentRound++;
    t.roundEndTime = Date.now() + (t.roundTime * 60 * 1000);
    generateSwissPairing(t);
    saveDB();
    renderActiveTournament();
};

// Admin result override for a pending match (or a drawn bracket match).
window.adminSetWinner = function (matchId, result) {
    reloadDB();
    const t = getActive();
    const round = lastRound(t);
    if (!round || round.processed) return;
    if (result === 'draw' && round.phase === 'TOP_CUT') return alert("Bracket matches need a winner.");
    const m = round.matches.find(x => x.matchId === matchId);
    if (m && m.p2 !== null && isPending(m, round.phase)) {
        m.winner = result;
        saveDB();
        renderActiveTournament();
    }
};
window.adminForceDraw = function (matchId) { adminSetWinner(matchId, 'draw'); };

window.adminResetMatch = function (matchId) {
    reloadDB();
    const t = getActive();
    const round = lastRound(t);
    if (!round || round.processed) return;
    const m = round.matches.find(x => x.matchId === matchId);
    if (!m || m.p2 === null || !m.winner) return;
    if (!confirm("Reset this match result?")) return;
    reloadDB();
    const m2 = lastRound(getActive())?.matches.find(x => x.matchId === matchId);
    if (m2) { m2.winner = null; m2.forfeit = false; m2.noShow = false; m2.checkInDeadline = null; saveDB(); renderActiveTournament(); }
};

window.adminAddTime = function (minutes) {
    reloadDB();
    const t = getActive();
    if (!t || !t.pairings || t.pairings.length === 0) return;
    t.roundEndTime = Math.max(Date.now(), t.roundEndTime || 0) + minutes * 60 * 1000;
    saveDB();
    renderActiveTournament();
};

// Admin opens / closes registration for an upcoming tournament. Player app must only allow
// registering while t.registrationOpen === true.
window.deletePlayer = function (id) {
    reloadDB();
    const p = db.players.find(x => x.id === id);
    if (!p) return;
    const inActive = db.tournaments.some(t => t.status === 'ACTIVE' && (t.registeredPlayers || []).includes(id)) ||
        db.activeTournamentData.some(d => d.playerId === id);
    if (inActive) return alert("This trainer is in the active tournament. End or delete that tournament first.");
    if (!confirm(`Delete trainer "${p.username}"? Their account, stats and registrations will be removed. Past Hall of Fame entries keep the name.`)) return;
    reloadDB();
    db.players = db.players.filter(x => x.id !== id);
    db.tournaments.forEach(t => { if (t.status === 'UPCOMING') t.registeredPlayers = (t.registeredPlayers || []).filter(pid => pid !== id); });
    saveDB();
    renderPlayers();
};

// Deletes the live tournament without awarding any stats.
window.deleteActiveTournament = function () {
    reloadDB();
    const t = getActive();
    if (!t) return;
    if (!confirm(`DELETE "${t.name}" completely? All pairings and standings are lost and no stats are awarded.`)) return;
    reloadDB();
    db.tournaments = db.tournaments.filter(x => x.status !== 'ACTIVE');
    db.activeTournamentData = [];
    activeSubTab = 'pairings';
    saveDB();
    switchTab('history', document.querySelectorAll('.nav-btn')[4]);
};

// Deletes a finished tournament from Hall of Fame and takes its results back out of player stats.
window.deleteHistory = function (tid) {
    reloadDB();
    const h = db.history.find(x => x.tournamentId === tid);
    if (!h) return;
    if (!confirm(`Delete "${h.tournamentName}" from the Hall of Fame? Its wins/runner-ups/events-played will be removed from the trainers' stats.`)) return;
    reloadDB();
    const h2 = db.history.find(x => x.tournamentId === tid);
    if (!h2) return;
    h2.results.forEach(r => {
        const p = db.players.find(x => x.id === r.playerId);
        if (!p) return;
        p.tournamentsPlayed = Math.max(0, (p.tournamentsPlayed || 0) - 1);
        if (r.isWinner) p.tournamentWins = Math.max(0, (p.tournamentWins || 0) - 1);
        if (r.isRunnerUp) p.runnerUps = Math.max(0, (p.runnerUps || 0) - 1);
    });
    db.history = db.history.filter(x => x.tournamentId !== tid);
    db.tournaments = db.tournaments.filter(x => x.id !== tid);
    saveDB();
    renderHistory();
};

window.toggleRegistration = function (id) {
    reloadDB();
    const t = db.tournaments.find(x => x.id === id);
    if (!t || t.status !== 'UPCOMING') return;
    t.registrationOpen = !t.registrationOpen;
    saveDB();
    renderHistory();
};

// Check-in timer: when a pair's timer ends -> only one checked in = that player wins,
// nobody checked in = draw (in top cut the admin picks a winner).
function dueMatches(round, now) {
    return round.matches.filter(m => m.p2 !== null && !m.winner && m.checkInDeadline &&
        now >= m.checkInDeadline && !(m.p1CheckIn && m.p2CheckIn));
}
function resolveCheckIns() {
    let t = getActive(), round = lastRound(t);
    if (!t || !round || round.processed || dueMatches(round, Date.now()).length === 0) return false;
    reloadDB();   // never overwrite players' newest check-ins
    t = getActive(); round = lastRound(t);
    if (!t || !round || round.processed) return false;
    const due = dueMatches(round, Date.now());
    if (!due.length) return false;
    due.forEach(m => {
        if (m.p1CheckIn && !m.p2CheckIn) { m.winner = 'p1'; m.forfeit = true; }
        else if (m.p2CheckIn && !m.p1CheckIn) { m.winner = 'p2'; m.forfeit = true; }
        else { m.winner = 'draw'; m.forfeit = true; m.noShow = true; }   // nobody checked in: DRAW (1 pt each; top cut -> admin picks winner)
    });
    saveDB();
    renderCurrent();
    return true;
}

window.startTopCut = function () {
    reloadDB();
    const t = getActive();
    if (!t || t.phase !== 'SWISS') return;
    if (!processRoundScores(t)) return alert("Swiss Matches are still in progress!");
    if (t.currentRound < t.totalRounds) { saveDB(); return alert("Finish all Swiss rounds first."); }

    const maxCut = t.topCut;
    const contenders = db.activeTournamentData.filter(d => !d.dropped);
    const activeP = contenders.length;
    if (activeP < 2) { saveDB(); return alert("Fewer than 2 trainers remain in the tournament."); }
    let actualCut = 2;
    [2, 4, 8, 16, 32, 64].forEach(c => { if (c <= activeP && c <= maxCut) actualCut = c; });

    const cutPlayers = contenders.slice(0, actualCut).map(d => d.playerId);
    const roster = getBracketSeeds(actualCut).map(s => cutPlayers[s - 1]);

    const matches = [];
    for (let i = 0; i < roster.length; i += 2) {
        matches.push({ matchId: 'tc_' + Date.now() + '_' + i, p1: roster[i], p2: roster[i + 1], p1CheckIn: false, p2CheckIn: false, checkInDeadline: newDeadline(t), winner: null, chat: [] });
    }
    t.phase = 'TOP_CUT';
    t.topCutRoundStr = bracketLabel(actualCut);
    t.pairings.push({ round: t.topCutRoundStr, phase: 'TOP_CUT', matches });
    t.roundEndTime = Date.now() + (t.roundTime * 60 * 1000);

    activeSubTab = 'bracket';
    saveDB();
    renderActiveTournament();
};

window.startNextBracketRound = function () {
    reloadDB();
    const t = getActive();
    if (!t || t.phase !== 'TOP_CUT') return;
    if (!processRoundScores(t)) return alert("Bracket matches are still in progress!");

    const last = lastRound(t);
    if (last.matches.length < 2) return;
    const winners = last.matches.map(m => m.winner === 'p1' ? m.p1 : m.p2);

    const nextMatches = [];
    for (let i = 0; i < winners.length; i += 2) {
        nextMatches.push({ matchId: 'tc_' + Date.now() + '_' + i, p1: winners[i], p2: winners[i + 1], p1CheckIn: false, p2CheckIn: false, checkInDeadline: newDeadline(t), winner: null, chat: [] });
    }
    // a player who dropped after winning forfeits the next match
    const isDropped = id => db.activeTournamentData.some(d => d.playerId === id && d.dropped);
    nextMatches.forEach(m => { const a = isDropped(m.p1), b = isDropped(m.p2); if (a && !b) m.winner = 'p2'; else if (b && !a) m.winner = 'p1'; });
    t.topCutRoundStr = bracketLabel(winners.length);
    t.pairings.push({ round: t.topCutRoundStr, phase: 'TOP_CUT', matches: nextMatches });
    t.roundEndTime = Date.now() + (t.roundTime * 60 * 1000);

    saveDB();
    renderActiveTournament();
};

// Final order: topIds first (champion, runner-up), then everyone else by how late they were
// eliminated (players still alive in the bracket rank highest), then Swiss rank.
function buildFinalOrder(t, topIds) {
    const elimStage = {}, inBracket = new Set();
    t.pairings.filter(p => p.phase === 'TOP_CUT').forEach((round, idx) => {
        round.matches.forEach(m => {
            inBracket.add(m.p1); if (m.p2 != null) inBracket.add(m.p2);
            if (m.winner === 'p1' || m.winner === 'p2') {
                const loser = m.winner === 'p1' ? m.p2 : m.p1;
                if (loser != null) elimStage[loser] = idx;
            }
        });
    });
    const stage = id => elimStage[id] ?? (inBracket.has(id) ? 999 : -1);
    const rest = db.activeTournamentData.filter(d => !topIds.includes(d.playerId))
        .sort((a, b) => stage(b.playerId) - stage(a.playerId) || a.position - b.position)
        .map(d => d.playerId);
    return [...topIds, ...rest];
}

function archiveTournament(t, order) {
    const championId = order[0], runnerUpId = order[1];
    db.activeTournamentData.forEach(d => { d.position = order.indexOf(d.playerId) + 1; });
    const tourneyHistory = { tournamentId: t.id, tournamentName: t.name, completedAt: Date.now(), results: [] };
    db.activeTournamentData.forEach(d => {
        const isWinner = d.playerId === championId;
        const isRunnerUp = d.playerId === runnerUpId;
        const p = db.players.find(pl => pl.id === d.playerId);
        tourneyHistory.results.push({ playerId: d.playerId, playerName: p ? p.username : 'Unknown', finalPosition: d.position, isWinner, isRunnerUp });
        if (p) {
            p.tournamentsPlayed = (p.tournamentsPlayed || 0) + 1;
            if (isWinner) p.tournamentWins = (p.tournamentWins || 0) + 1;
            if (isRunnerUp) p.runnerUps = (p.runnerUps || 0) + 1;
        }
    });
    db.history.push(tourneyHistory);
    db.activeTournamentData = [];
    t.status = 'COMPLETED';
    t.registrationOpen = false;
    activeSubTab = 'pairings';
    saveDB();
    switchTab('history', document.querySelectorAll('.nav-btn')[4]);
}

// Normal finish: final match reported.
window.endTournament = function () {
    reloadDB();
    const activeT = getActive();
    if (!activeT || activeT.phase !== 'TOP_CUT') return;
    const finalRound = lastRound(activeT);
    const finalMatch = finalRound.matches[0];
    if (finalRound.matches.length !== 1 || (finalMatch.winner !== 'p1' && finalMatch.winner !== 'p2'))
        return alert("The final match result has not been reported yet!");
    if (!confirm("Conclude Tournament? Final placements will be permanently archived.")) return;

    reloadDB();
    const t = getActive();
    if (!t) return;
    const fm = lastRound(t).matches[0];
    const championId = fm.winner === 'p1' ? fm.p1 : fm.p2;
    const runnerUpId = fm.winner === 'p1' ? fm.p2 : fm.p1;
    archiveTournament(t, buildFinalOrder(t, [championId, runnerUpId]));
};

// Admin can end the event at ANY time. Placements = current standings / bracket progress.
window.forceEndTournament = function () {
    reloadDB();
    if (!getActive()) return;
    if (!confirm("END this tournament now? It will be archived using the CURRENT standings (#1 is champion). This cannot be undone.")) return;
    reloadDB();
    const t = getActive();
    if (!t) return;
    processRoundScores(t);                       // count the last Swiss round if it is fully reported
    const order = buildFinalOrder(t, []);
    if (order.length === 0) return;
    archiveTournament(t, order);
};

// ==========================================
// RENDERING: BATTLE CONTROL
// ==========================================
function generateBracketHtml(pairings) {
    const rounds = pairings.filter(p => p.phase === 'TOP_CUT');
    if (rounds.length === 0) return '';

    let html = '<div class="flex flex-row gap-12 overflow-x-auto p-4 w-full h-full items-center">';
    rounds.forEach(round => {
        html += `<div class="flex flex-col justify-center min-w-[200px] space-y-6">`;
        html += `<h4 class="text-center text-pokegold font-bold uppercase tracking-widest mb-2 border-b border-gray-700 pb-2">${esc(round.round)}</h4>`;
        round.matches.forEach(m => {
            const n1 = nameOf(m.p1);
            const n2 = m.p2 ? nameOf(m.p2) : 'BYE';
            const decided = m.winner === 'p1' || m.winner === 'p2';
            const w1 = m.winner === 'p1' ? 'text-pokegold font-bold' : (decided ? 'text-gray-600 line-through' : 'text-white font-bold');
            const w2 = m.winner === 'p2' ? 'text-pokegold font-bold' : (decided ? 'text-gray-600 line-through' : 'text-white font-bold');
            html += `
            <div class="bg-gray-900/80 border border-gray-700 rounded-lg p-3 flex flex-col relative shadow-lg">
                <div class="flex justify-between border-b border-gray-800 pb-2 mb-2"><span class="${w1} tracking-wide">${esc(n1)}</span></div>
                <div class="flex justify-between"><span class="${w2} tracking-wide">${esc(n2)}</span></div>
            </div>`;
        });
        html += `</div>`;
    });
    return html + '</div>';
}

function updateTimer() {
    const t = getActive();
    const el = document.getElementById('round-timer');
    if (!t || !el) return;
    if (!t.pairings || t.pairings.length === 0) {
        const w = `<span class="text-gray-500 text-4xl">NOT STARTED</span>`;
        if (el.innerHTML !== w) el.innerHTML = w;
        return;
    }
    const timeLeft = Math.max(0, Math.floor(((t.roundEndTime || 0) - Date.now()) / 1000));
    const html = timeLeft === 0
        ? `<span class="text-red-500 animate-pulse font-bold text-4xl">TIME CALLED</span>`
        : `${Math.floor(timeLeft / 60).toString().padStart(2, '0')}:${(timeLeft % 60).toString().padStart(2, '0')}`;
    if (el.innerHTML !== html) el.innerHTML = html;

    // per-pair check-in countdowns
    document.querySelectorAll('.ci-timer').forEach(span => {
        const left = Math.max(0, Math.floor((parseInt(span.dataset.deadline) - Date.now()) / 1000));
        const txt = left === 0 ? 'Check-in over' : `Check-in ${Math.floor(left / 60).toString().padStart(2, '0')}:${(left % 60).toString().padStart(2, '0')}`;
        if (span.textContent !== txt) span.textContent = txt;
    });
}

function renderActiveTournament() {
    const activeT = getActive();
    if (!activeT) {
        document.getElementById('active-content').classList.add('hidden');
        document.getElementById('no-active-msg').classList.remove('hidden');
        return;
    }
    document.getElementById('active-content').classList.remove('hidden');
    document.getElementById('no-active-msg').classList.add('hidden');

    if (activeSubTab === 'bracket' && activeT.phase !== 'TOP_CUT') activeSubTab = 'pairings';

    document.getElementById('active-t-name').innerText = activeT.name;
    document.getElementById('active-round-info').innerText =
        activeT.phase === 'SWISS' ? (activeT.currentRound === 0 ? `Ready - Round 1 not started` : `Swiss R${activeT.currentRound} / ${activeT.totalRounds}`) : (activeT.topCutRoundStr || 'Top Cut');
    updateTimer();

    const currentPairings = lastRound(activeT);
    const pendingCount = pendingIn(currentPairings);

    // ---- header controls (only re-written when something actually changed, so clicks are never lost) ----
    const baseBtn = 'px-8 py-3 rounded-tr-xl rounded-bl-xl font-bold tracking-widest uppercase transition-all';
    const waitBtn = (label) => `<button disabled class="${baseBtn} opacity-50 cursor-not-allowed bg-gray-600 text-white">${label}</button>`;
    let btnHtml = '';
    if (activeT.phase === 'SWISS') {
        if (pendingCount > 0) btnHtml = waitBtn(`Waiting on ${pendingCount} Match${pendingCount > 1 ? 'es' : ''}`);
        else if (activeT.currentRound >= activeT.totalRounds)
            btnHtml = `<button onclick="startTopCut()" class="${baseBtn} bg-pokegold text-black shadow-lg hover:bg-yellow-400">Start Top Cut</button>`;
        else btnHtml = `<button onclick="startNextRound()" class="${baseBtn} shadow-lg bg-pokeblue text-white hover:bg-blue-500">Start Round ${activeT.currentRound + 1}</button>`;
    } else if (currentPairings.matches.length > 1) {
        btnHtml = pendingCount > 0 ? waitBtn('Matches Pending')
            : `<button onclick="startNextBracketRound()" class="${baseBtn} shadow-lg bg-pokeblue text-white hover:bg-blue-500">Next Bracket Round</button>`;
    } else {
        btnHtml = pendingCount > 0 ? waitBtn('Final Pending')
            : `<button onclick="endTournament()" class="${baseBtn} bg-pokered hover:bg-red-500 shadow-lg text-white">Conclude Event</button>`;
    }

    const tabCls = name => `px-4 py-2 font-bold uppercase tracking-widest text-sm rounded ${activeSubTab === name ? 'bg-pokered text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`;
    const bracketBtnHtml = activeT.phase === 'TOP_CUT' ? `<button onclick="switchSubTab('bracket')" class="${tabCls('bracket')}">Graph Map</button>` : '';

    const controlsHtml = `
        <div class="flex justify-between w-full mb-4">
            <div class="flex gap-2">
                <button onclick="switchSubTab('pairings')" class="${tabCls('pairings')}">Pairings</button>
                <button onclick="switchSubTab('leaderboard')" class="${tabCls('leaderboard')}">Leaderboard</button>
                ${bracketBtnHtml}
            </div>
            <div class="flex gap-3 items-center">
                <button onclick="adminAddTime(5)" class="px-3 py-2 text-xs font-bold uppercase tracking-widest rounded bg-gray-800 text-gray-300 hover:text-white border border-gray-700">+5 Min</button>
                <button onclick="forceEndTournament()" class="px-3 py-2 text-xs font-bold uppercase tracking-widest rounded bg-red-900/70 text-red-200 hover:bg-red-700 border border-red-800">End Tournament</button>
                <button onclick="deleteActiveTournament()" class="px-3 py-2 text-xs font-bold uppercase tracking-widest rounded bg-gray-800 text-gray-300 hover:text-white hover:bg-pokered border border-gray-700">Delete</button>
                ${btnHtml}
            </div>
        </div>`;
    const controls = document.getElementById('admin-controls');
    if (controls.innerHTML !== controlsHtml) controls.innerHTML = controlsHtml;

    // ---- panels ----
    const pairingsContainer = document.getElementById('admin-pairings-list').parentElement;
    const standingsContainer = document.getElementById('active-tbody').parentElement.parentElement;

    let bracketContainer = document.getElementById('admin-bracket-container');
    if (!bracketContainer) {
        bracketContainer = document.createElement('div');
        bracketContainer.id = 'admin-bracket-container';
        bracketContainer.className = 'bg-dark/90 backdrop-blur border border-gray-700 rounded-xl overflow-auto shadow-2xl flex-1';
        standingsContainer.parentElement.appendChild(bracketContainer);
    }
    pairingsContainer.style.display = 'none';
    standingsContainer.style.display = 'none';
    bracketContainer.style.display = 'none';

    if (activeSubTab === 'pairings') {
        pairingsContainer.style.display = 'block';
        pairingsContainer.style.maxHeight = '45vh';   // room for all matches + result buttons
        const list = document.getElementById('admin-pairings-list');
        const roundLocked = currentPairings && currentPairings.processed;
        let pairingsHtml = '';
        if (currentPairings) {
            currentPairings.matches.forEach(m => {
                const n1 = esc(nameOf(m.p1));
                const n2 = m.p2 ? esc(nameOf(m.p2)) : 'BYE';
                const c1 = m.p1CheckIn ? 'text-green-400' : 'text-gray-500';
                const c2 = m.p2CheckIn ? 'text-green-400' : 'text-gray-500';
                const pending = isPending(m, currentPairings.phase);

                let status = `<span class="text-yellow-500 animate-pulse">Fighting</span>`;
                if (!m.p1CheckIn || !m.p2CheckIn) status = `<span class="text-gray-500">Wait/Check-in</span>`;
                if (m.winner === 'p1') status = `<span class="text-pokeblue">${n1} Won</span>`;
                if (m.winner === 'p2') status = `<span class="text-pokeblue">${n2} Won</span>`;
                if (m.p2 === null) status = `<span class="text-pokegold">Auto-Win</span>`;
                if (m.forfeit && (m.winner === 'p1' || m.winner === 'p2')) status = `<span class="text-orange-400">${m.winner === 'p1' ? n1 : n2} Won (opponent no-show)</span>`;
                if (m.winner === 'noshow') status = currentPairings.phase === 'TOP_CUT'
                    ? `<span class="text-red-400">No-show - pick winner</span>` : `<span class="text-red-400">No-show (both lose)</span>`;
                if (m.winner === 'draw') status = currentPairings.phase === 'TOP_CUT'
                    ? `<span class="text-red-400">${m.noShow ? 'No-show draw' : 'Draw'} - pick winner</span>`
                    : (m.noShow ? `<span class="text-orange-400">No-show (neither checked in) - Draw</span>` : `<span class="text-gray-400">Draw</span>`);

                const bCls = 'ml-2 bg-gray-800 hover:bg-pokered text-white text-[9px] px-2 py-1 rounded tracking-widest';
                let actions = '';
                if (pending) {
                    actions = `<button onclick="adminSetWinner('${m.matchId}','p1')" class="${bCls}">P1 WIN</button>
                               <button onclick="adminSetWinner('${m.matchId}','p2')" class="${bCls}">P2 WIN</button>`;
                    if (currentPairings.phase === 'SWISS') actions += `<button onclick="adminForceDraw('${m.matchId}')" class="${bCls} !bg-red-900/80">FORCE DRAW</button>`;
                } else if (m.p2 !== null && m.winner && !roundLocked) {
                    actions = `<button onclick="adminResetMatch('${m.matchId}')" class="${bCls}">RESET</button>`;
                }

                if (m.p2 !== null) {
                    const hasReport = m.report && m.report.status === 'OPEN';
                    actions += `<button onclick="openMatchChat('${m.matchId}')" class="${bCls} ${hasReport ? '!bg-red-600 animate-pulse' : ''}">${hasReport ? '&#9888; REPORT / CHAT' : 'CHAT'}</button>`;
                }

                const ciTimer = (m.p2 !== null && !m.winner && m.checkInDeadline && !(m.p1CheckIn && m.p2CheckIn))
                    ? `<span class="ci-timer text-[10px] font-mono text-pokegold mr-3" data-deadline="${m.checkInDeadline}"></span>` : '';
                pairingsHtml += `<li class="border-b border-gray-800 pb-2 mb-2 flex justify-between items-center bg-black/50 p-2 rounded gap-2"><div class="font-bold truncate max-w-[200px]"><span class="${c1}">${n1}</span> <span class="text-gray-600 font-normal italic px-2">vs</span> <span class="${c2}">${n2}</span></div><div class="flex items-center shrink-0">${ciTimer}<span class="text-[10px] uppercase tracking-widest font-bold">${status}</span>${actions}</div></li>`;
            });
        }
        if (list.innerHTML !== pairingsHtml) { list.innerHTML = pairingsHtml; updateTimer(); }
    } else if (activeSubTab === 'bracket') {
        bracketContainer.style.display = 'block';
        const html = generateBracketHtml(activeT.pairings);
        if (bracketContainer.innerHTML !== html) bracketContainer.innerHTML = html;
    } else {
        standingsContainer.style.display = 'table';
        const tbody = document.getElementById('active-tbody');
        let tbodyHtml = '';
        db.activeTournamentData.forEach(d => {
            const rankColor = d.position === 1 ? 'text-pokegold' : (d.position === 2 ? 'text-gray-300' : 'text-pokered');
            tbodyHtml += `<tr class="hover:bg-gray-800/50 transition-colors"><td class="px-6 py-4 font-bold ${rankColor} text-xl">${d.position}</td><td class="px-6 py-4 font-bold text-white tracking-wide">${esc(nameOf(d.playerId))}${d.dropped ? ' <span class="text-xs text-red-500 tracking-widest">DROPPED</span>' : ''}</td><td class="px-6 py-4 font-mono text-lg text-gray-300">${d.points} Pts (${d.wins}-${d.losses}-${d.draws})</td></tr>`;
        });
        if (tbody.innerHTML !== tbodyHtml) tbody.innerHTML = tbodyHtml;
    }
}

// ==========================================
// RENDERING: HALL OF FAME & SCHEDULE
// ==========================================
function renderHistory() {
    const container = document.getElementById('history-container');
    let html = '';

    const upcoming = db.tournaments.filter(t => t.status === 'UPCOMING')
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    upcoming.forEach(t => {
        const reg = t.registeredPlayers || [];
        const rosterNames = reg.length > 0 ? reg.map(id => esc(nameOf(id))).join(' &bull; ') : 'No trainers registered yet.';
        html += `
            <div class="bg-dark/80 backdrop-blur p-6 rounded-tr-3xl rounded-bl-3xl border border-gray-700 flex flex-col mb-5 shadow-lg border-l-4 border-l-pokeblue">
                <div class="flex justify-between items-start w-full border-b border-gray-700/50 pb-4 mb-4 gap-4">
                    <div>
                        <h3 class="text-2xl font-bold text-white italic">${esc(t.name)} ${t.registrationOpen
                            ? '<span class="ml-2 align-middle text-[10px] px-2 py-1 rounded bg-green-900/60 text-green-400 tracking-widest not-italic">REGISTRATION OPEN</span>'
                            : '<span class="ml-2 align-middle text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-400 tracking-widest not-italic">REGISTRATION CLOSED</span>'}</h3>
                        <p class="text-sm text-gray-400 mt-2 font-sans">${esc(t.date)} &nbsp;|&nbsp; Check-in: ${t.checkInMinutes || 5} min &nbsp;|&nbsp; Swiss Rounds: ${t.totalRounds} &nbsp;|&nbsp; ${t.roundTime} min rounds &nbsp;|&nbsp; Top ${t.topCut}</p>
                        ${t.bio ? `<p class="text-sm text-gray-500 mt-2 font-sans">${esc(t.bio)}</p>` : ''}
                    </div>
                    <div class="flex gap-3 shrink-0">
                        <button onclick="deleteTournament(${t.id})" class="text-gray-400 border border-gray-700 hover:text-white hover:border-pokered px-4 py-3 rounded-tr-xl rounded-bl-xl text-sm font-bold tracking-widest uppercase transition-colors">Delete</button>
                        <button onclick="toggleRegistration(${t.id})" class="${t.registrationOpen ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-800 hover:bg-gray-700 border border-gray-600'} text-white px-4 py-3 rounded-tr-xl rounded-bl-xl text-sm font-bold tracking-widest uppercase transition-colors">${t.registrationOpen ? 'Close Registration' : 'Open Registration'}</button>
                        <button onclick="startTournament(${t.id})" class="bg-gradient-to-r from-blue-600 to-blue-500 text-white px-6 py-3 rounded-tr-xl rounded-bl-xl text-sm font-bold tracking-widest uppercase shadow-[0_0_10px_rgba(59,130,246,0.3)] transition-transform hover:scale-105">Begin Tournament</button>
                    </div>
                </div>
                <div class="bg-gray-900/50 rounded-xl p-4 border border-gray-800">
                    <p class="text-xs text-pokered uppercase font-bold tracking-widest mb-2">Registered Roster (${reg.length})</p>
                    <p class="text-sm text-gray-300 font-sans leading-relaxed">${rosterNames}</p>
                </div>
            </div>`;
    });

    [...db.history].reverse().forEach(h => {
        const results = [...h.results].sort((a, b) => a.finalPosition - b.finalPosition);
        const winner = results.find(r => r.isWinner)?.playerName || 'N/A';
        const resultsHtml = results.map(r => `
            <div class="flex justify-between border-b border-gray-800 py-3 text-sm font-sans">
                <span class="${r.isWinner ? 'text-pokegold font-bold' : 'text-gray-300'}"><span class="w-6 inline-block text-gray-500 font-gaming">${r.finalPosition}.</span> ${esc(r.playerName)}</span>
            </div>`).join('');
        html += `
            <div class="bg-gray-900/80 backdrop-blur p-6 rounded-tr-3xl rounded-bl-3xl border border-gray-700 mb-6 shadow-xl border-l-4 border-l-pokegold relative overflow-hidden">
                <button onclick="deleteHistory(${h.tournamentId})" class="absolute top-4 right-4 text-gray-400 border border-gray-700 hover:text-white hover:border-pokered px-3 py-1 rounded text-xs font-bold tracking-widest uppercase">Delete</button>
                <div class="mb-5">
                    <h3 class="text-2xl font-bold text-white italic">${esc(h.tournamentName)}</h3>
                    <p class="text-sm text-gray-400 mt-2 font-sans">Champion: <span class="text-pokegold font-bold">${esc(winner)}</span></p>
                </div>
                <div class="bg-darker/50 p-5 rounded-xl border border-gray-800">${resultsHtml}</div>
            </div>`;
    });

    if (!html) html = `<div class="bg-dark/80 p-10 rounded-2xl border border-gray-800 text-gray-400 text-center text-lg tracking-wider uppercase">No tournaments yet. Create one to get started.</div>`;
    if (container.innerHTML !== html) container.innerHTML = html;
}

window.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('dash-players')) switchTab('dashboard', document.querySelectorAll('.nav-btn')[0]);
});


// ==========================================
// REPORTS (illegal team) + ADMIN CHAT
// ------------------------------------------
// Data contract shared with the player app:
//   match.report = { id, by: <reporterPlayerId>, against?: <playerId>, reason, ts, status: 'OPEN' | 'RESOLVED' }
//   match.chat   = [ { from: <playerId> | 'ADMIN' | 'SYSTEM', text, ts } ]
// A player creates a report by setting match.report (status 'OPEN'); the admin is alerted instantly.
// ==========================================
let chatMatchId = null;
const seenReports = new Set();
let reportsInitialized = false;
const $id = id => document.getElementById(id);

function findMatch(matchId) {
    const t = getActive();
    if (!t || !t.pairings) return {};
    for (const round of t.pairings) {
        const m = round.matches.find(x => x.matchId === matchId);
        if (m) return { t, round, m };
    }
    return {};
}
function openReports() {
    const t = getActive(), out = [];
    if (!t || !t.pairings) return out;
    t.pairings.forEach(round => round.matches.forEach(m => {
        if (m.report && m.report.status === 'OPEN') out.push(m);
    }));
    return out;
}
const reportId = m => m.report.id || (m.matchId + '_' + m.report.ts);
const accusedOf = m => m.report.against || (m.report.by === m.p1 ? m.p2 : m.p1);

function beep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 660, 880].forEach((f, i) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
            g.gain.value = 0.08; o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.12);
        });
    } catch (e) { /* audio blocked until first click - banner still shows */ }
}

function renderReportAlerts() {
    const open = openReports();
    const banner = $id('report-banner'), badge = $id('report-badge');

    if (banner) {
        const html = open.map(m => `
            <div class="flex items-center justify-between gap-4 bg-red-950/80 border border-red-500 rounded-lg px-4 py-3">
                <div class="text-sm">
                    <span class="text-red-400 font-bold uppercase tracking-widest mr-2">&#9888; Team report</span>
                    <span class="text-white font-bold">${esc(nameOf(m.report.by))}</span>
                    <span class="text-gray-300"> reported </span>
                    <span class="text-white font-bold">${esc(nameOf(accusedOf(m)))}</span>
                    <span class="text-gray-400"> &mdash; ${esc(m.report.reason || 'illegal / false team')}</span>
                </div>
                <button onclick="openMatchChat('${m.matchId}')" class="shrink-0 px-4 py-2 bg-pokered hover:bg-red-500 text-white text-xs font-bold uppercase tracking-widest rounded-tr-lg rounded-bl-lg">Join Chat</button>
            </div>`).join('');
        if (banner.innerHTML !== html) banner.innerHTML = html;
        banner.classList.toggle('hidden', open.length === 0);
    }
    if (badge) {
        badge.textContent = open.length;
        badge.classList.toggle('hidden', open.length === 0);
    }
    document.title = (open.length ? `(${open.length}) \u26A0 ` : '') + 'LIMITLESS | Admin Dashboard';

    let fresh = false;
    open.forEach(m => { const id = reportId(m); if (!seenReports.has(id)) { seenReports.add(id); fresh = true; } });
    if (fresh && reportsInitialized) beep();
    reportsInitialized = true;
}

window.openMatchChat = function (matchId) {
    reloadDB();
    const { m } = findMatch(matchId);
    if (!m) return;
    chatMatchId = matchId;
    if (m.report && m.report.status === 'OPEN' && !m.report.adminJoined) {
        m.report.adminJoined = true;
        (m.chat = m.chat || []).push({ from: 'SYSTEM', text: 'An admin has joined the chat.', ts: Date.now() });
        saveDB();
    }
    $id('chat-modal').classList.remove('hidden');
    renderChatModal(true);
    $id('chat-input').focus();
};
window.closeMatchChat = function () {
    chatMatchId = null;
    $id('chat-modal').classList.add('hidden');
};
document.addEventListener('keydown', e => { if (e.key === 'Escape' && chatMatchId) closeMatchChat(); });

function renderChatModal(forceScroll) {
    if (!chatMatchId) return;
    const { t, round, m } = findMatch(chatMatchId);
    if (!m) return closeMatchChat();

    const n1 = esc(nameOf(m.p1)), n2 = esc(nameOf(m.p2));
    $id('chat-title').innerHTML = `${n1} <span class="text-gray-500 italic px-1">vs</span> ${n2}`;
    $id('chat-sub').textContent = `${round.phase === 'TOP_CUT' ? 'Top Cut' : 'Swiss'} match`;

    // report box
    const rb = $id('chat-report');
    if (m.report) {
        const open = m.report.status === 'OPEN';
        rb.className = `mx-4 mt-4 p-3 rounded-lg text-sm border ${open ? 'bg-red-950/60 border-red-500' : 'bg-gray-900 border-gray-700'}`;
        rb.innerHTML = open
            ? `<b class="text-red-400 uppercase tracking-widest text-xs">&#9888; Open report</b><br><b class="text-white">${esc(nameOf(m.report.by))}</b> reported <b class="text-white">${esc(nameOf(accusedOf(m)))}</b>: <span class="text-gray-300">${esc(m.report.reason || 'illegal / false team')}</span>`
            : `<b class="text-green-400 uppercase tracking-widest text-xs">Report resolved</b><br><span class="text-gray-300">${esc(m.report.resolution || '')}</span>`;
    } else rb.className = 'hidden';

    // messages
    const log = $id('chat-log');
    const html = (m.chat || []).map(c => {
        const who = c.from ?? c.sender ?? c.playerId ?? c.by;
        const body = esc(c.text ?? c.message ?? c.msg ?? '');
        const ts = c.ts ?? c.time ?? c.timestamp;
        const time = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        if (who === 'SYSTEM') return `<div class="text-center text-xs text-gray-500 italic">${body}</div>`;
        if (who === 'ADMIN') return `<div class="flex justify-end"><div class="max-w-[80%] bg-pokegold/20 border border-pokegold/60 rounded-lg px-3 py-2"><div class="text-[10px] text-pokegold font-bold uppercase tracking-widest">Admin &middot; ${time}</div><div class="text-white text-sm">${body}</div></div></div>`;
        const side = who === m.p1 ? 'bg-blue-900/40 border-blue-700' : 'bg-gray-800 border-gray-600';
        return `<div class="flex"><div class="max-w-[80%] ${side} border rounded-lg px-3 py-2"><div class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">${esc(nameOf(who))} &middot; ${time}</div><div class="text-white text-sm">${body}</div></div></div>`;
    }).join('') || '<div class="text-center text-gray-500 text-sm mt-8">No messages yet.</div>';
    if (log.innerHTML !== html) {
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.innerHTML = html;
        if (forceScroll || nearBottom) log.scrollTop = log.scrollHeight;
    }

    // resolution buttons
    const acts = $id('chat-actions');
    let aHtml = '';
    if (m.report && m.report.status === 'OPEN') {
        const locked = round.processed || round !== lastRound(t);
        const b = 'px-3 py-2 text-xs font-bold uppercase tracking-widest rounded border';
        const dis = locked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-pokered';
        aHtml = `<span class="w-full text-[10px] text-gray-500 uppercase tracking-widest">Resolve report ${locked ? '(round already scored - dismiss only)' : ''}</span>
            <button ${locked ? 'disabled' : ''} onclick="resolveReport('${m.matchId}','p1')" class="${b} bg-gray-800 border-gray-600 text-white ${dis}">${n1} wins</button>
            <button ${locked ? 'disabled' : ''} onclick="resolveReport('${m.matchId}','p2')" class="${b} bg-gray-800 border-gray-600 text-white ${dis}">${n2} wins</button>
            ${round.phase === 'SWISS' ? `<button ${locked ? 'disabled' : ''} onclick="resolveReport('${m.matchId}','draw')" class="${b} bg-gray-800 border-gray-600 text-white ${dis}">Draw</button>` : ''}
            <button onclick="resolveReport('${m.matchId}','dismiss')" class="${b} bg-gray-900 border-gray-600 text-gray-300 hover:text-white ml-auto">Dismiss report</button>`;
    }
    if (acts.innerHTML !== aHtml) acts.innerHTML = aHtml;
    acts.classList.toggle('hidden', !aHtml);
}

$id('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const input = $id('chat-input');
    const text = input.value.trim();
    if (!text || !chatMatchId) return;
    reloadDB();   // never overwrite the players' newest messages
    const { m } = findMatch(chatMatchId);
    if (!m) return;
    (m.chat = m.chat || []).push({ from: 'ADMIN', text, ts: Date.now(), admin: true });
    saveDB();
    input.value = '';
    renderChatModal(true);
});

window.resolveReport = function (matchId, result) {
    reloadDB();
    const { t, round, m } = findMatch(matchId);
    if (!m || !m.report) return;
    let resolution = 'Report dismissed by admin.';
    if (result !== 'dismiss') {
        if (round.processed || round !== lastRound(t)) return alert('That round is already scored.');
        if (result === 'draw' && round.phase === 'TOP_CUT') return alert('Bracket matches need a winner.');
        if (m.winner && m.winner !== result && !confirm('This match already has a result. Override it?')) return;
        m.winner = result; m.forfeit = false; m.noShow = false;
        resolution = result === 'draw' ? 'Admin ruled the match a draw.'
            : `Admin ruled: ${nameOf(result === 'p1' ? m.p1 : m.p2)} wins.`;
    }
    m.report.status = 'RESOLVED';
    m.report.resolution = resolution;
    m.report.resolvedTs = Date.now();
    (m.chat = m.chat || []).push({ from: 'SYSTEM', text: resolution, ts: Date.now() });
    saveDB();
    renderCurrent();
};

renderReportAlerts();