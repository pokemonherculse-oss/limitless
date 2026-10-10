// ==========================================
// LIMITLESS PLAYER  (same data format as the admin app: limitless_db / v5)
// ==========================================
const DB_VERSION = 'v5';
let db = {version:DB_VERSION,players:[],tournaments:[],activeTournamentData:[],history:[]};
function saveDB() { LimitlessStore.save(db); }
function reloadDB() {} // Fresh state arrives from the server; no localStorage database.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);

let loggedInPlayerId = null;

let currentTab = 'active';
let currentMatchId = null;
let battleScores = { g1: null, g2: null, g3: null };
let battleLocked = false;
let viewRoundIdx = null;      // null = follow the latest round in Pairings

const getMe = () => db.players.find(p => p.id === loggedInPlayerId);
const getActive = () => db.tournaments.find(t => t.status === 'ACTIVE');
const nameOf = id => db.players.find(p => p.id === id)?.username || 'Unknown';
const lastRoundOf = t => t && t.pairings && t.pairings.length ? t.pairings[t.pairings.length - 1] : null;
const myDataOf = () => (db.activeTournamentData || []).find(d => d.playerId === loggedInPlayerId);

// ==========================================
// 1. AUTHENTICATION
// ==========================================
window.toggleAuth = function () {
    $('login-form').classList.toggle('hidden');
    $('register-form').classList.toggle('hidden');
    const authBox = document.querySelector('#auth-view .cyber-box');
    if (authBox.classList.contains('cyber-box-cyan')) {
        authBox.classList.replace('cyber-box-cyan', 'cyber-box-red');
        authBox.querySelector('h1').classList.replace('neon-text-cyan', 'neon-text-red');
    } else {
        authBox.classList.replace('cyber-box-red', 'cyber-box-cyan');
        authBox.querySelector('h1').classList.replace('neon-text-red', 'neon-text-cyan');
    }
};

window.handleRegister = async function (e) {
    e.preventDefault();
    const username = $('reg-username').value.trim();
    const password = $('reg-password').value;
    try {
        await LimitlessStore.auth('/api/register',{username,password});
        window.location.reload();
    } catch(err) { alert(err.message); }
    return false;
};
window.handleLogin = async function (e) {
    e.preventDefault();
    try {
        await LimitlessStore.auth('/api/login',{
            username:$('login-username').value.trim(), password:$('login-password').value
        });
        window.location.reload();
    } catch(err) { alert(err.message); }
    return false;
};
window.logout = async function () {
    await LimitlessStore.auth('/api/logout',{});
    window.location.reload();
};

// ==========================================
// 2. PAGE INITIALIZATION
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    setupPageNav();
    setupBattleControls();
    setupChat();
    LimitlessStore.init(fresh => {
        db = fresh;
        loggedInPlayerId = LimitlessStore.role === 'player' ? LimitlessStore.me?.id : null;
        if (!loggedInPlayerId) {
            $('auth-view').classList.remove('hidden');
            $('main-app').classList.add('hidden');
            return;
        }
        $('auth-view').classList.add('hidden');
        $('main-app').classList.remove('hidden');
        $('sidebar').classList.remove('hidden');
        $('main-content').classList.remove('hidden');
        if (!window.playerUiInitialized) {
            window.playerUiInitialized = true;
            switchTab('active', document.querySelectorAll('.nav-btn')[1]);
        } else renderCurrent();
    }).catch(err => console.error('Database connection:',err));
});

function updateIdentity() {
    const p = getMe();
    if (!p) return;
    if ($('display-username') && $('display-username').innerText !== p.username) $('display-username').innerText = p.username;
    if ($('avatar-initial')) $('avatar-initial').innerText = p.username.charAt(0).toUpperCase();
}

function setupPageNav() {
    const pageNavBtns = document.querySelectorAll('.page-nav-btn[data-tab]');
    const pageTabs = document.querySelectorAll('.page-tab');
    pageNavBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            pageNavBtns.forEach(b => b.classList.remove('active'));
            pageTabs.forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            const targetTab = $(`${btn.dataset.tab}-tab`);
            if (targetTab) targetTab.classList.add('active');
        });
    });
}

// ----- Battle: best of 3 (buttons are relative: "You" / "Opponent") -----
function setBanner(kind) {
    const el = $('match-status');
    if (!el) return;
    const base = "text-center py-4 tracking-widest uppercase text-xs font-bold clip-edge";
    if (kind === 'win') { el.innerText = "You Won this Match"; el.className = `bg-green-900/40 text-green-400 border border-green-500 ${base}`; }
    else if (kind === 'loss') { el.innerText = "Opponent Won this Match"; el.className = `bg-red-900/40 text-red-500 border border-red-500 ${base}`; }
    else if (kind === 'draw') { el.innerText = "Match ended in a draw"; el.className = `bg-gray-900 text-gray-300 border border-gray-600 ${base}`; }
    else { el.innerText = "Match in progress"; el.className = "bg-black text-center py-4 text-gray-400 tracking-widest uppercase text-xs border border-gray-800"; }
}

function resetBattleLocal() {
    battleScores = { g1: null, g2: null, g3: null };
    document.querySelectorAll('.g-btn').forEach(b => b.classList.remove('selected'));
    if ($('current-score')) $('current-score').innerText = '-';
}

function lockBattle(locked) {
    battleLocked = locked;
    document.querySelectorAll('.g-btn, #reset-match-btn').forEach(b => {
        b.disabled = locked;
        b.classList.toggle('opacity-40', locked);
        b.classList.toggle('cursor-not-allowed', locked);
    });
}

function setupBattleControls() {
    document.querySelectorAll('.g-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (battleLocked || !currentMatchId) return;
            const game = btn.dataset.game;
            battleScores[`g${game}`] = btn.dataset.winner;
            document.querySelectorAll(`.g-btn[data-game="${game}"]`).forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');

            const mine = Object.values(battleScores).filter(v => v === 'p1').length;
            const theirs = Object.values(battleScores).filter(v => v === 'p2').length;
            if ($('current-score')) $('current-score').innerText = `${mine} - ${theirs}`;

            if (mine === 2) { setBanner('win'); reportScore(currentMatchId, 'win'); }
            else if (theirs === 2) { setBanner('loss'); reportScore(currentMatchId, 'loss'); }
            else setBanner('progress');
        });
    });
    const resetBtn = $('reset-match-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => { if (battleLocked) return; resetBattleLocal(); setBanner('progress'); });
}

function setupChat() {
    const sendBtn = $('send-msg-btn');
    const chatInput = $('chat-msg-input');
    if (!sendBtn || !chatInput) return;
    const sendAction = async () => {
        const text = chatInput.value.trim();
        if (!text || !currentMatchId) return;
        chatInput.value = '';
        try { await LimitlessStore.chat(currentMatchId, text); }
        catch (err) { chatInput.value = text; alert('Chat not sent: ' + err.message); }
    };
    sendBtn.addEventListener('click',sendAction);
    chatInput.addEventListener('keypress',e=>{if(e.key==='Enter') sendAction();});
}

// ==========================================
// 3. NAVIGATION + LIVE SYNC
// ==========================================
window.switchTab = function (tabId, btnElement = null) {
    reloadDB();
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.add('hidden'));
    const targetTab = $(tabId);
    if (targetTab) targetTab.classList.remove('hidden');

    if (btnElement) {
        document.querySelectorAll('.nav-btn').forEach(btn => btn.className = "nav-btn w-full text-left px-6 py-4 clip-edge bg-black text-gray-500 border border-gray-800 hover:border-gray-500 hover:text-white font-bold tracking-widest uppercase transition-all");
        btnElement.className = "nav-btn w-full text-left px-6 py-4 clip-edge bg-cyan-500/20 text-cyan-400 border border-cyan-400 font-bold tracking-widest uppercase transition-all shadow-[0_0_15px_rgba(0,243,255,0.2)]";
    }
    currentTab = tabId;
    renderCurrent();
};

function renderCurrent() {
    if (!loggedInPlayerId) return;
    updateIdentity();
    if (currentTab === 'profile') renderProfile();
    else if (currentTab === 'history') renderHistory();
    else if (currentTab === 'active') renderActiveTournament();
}

// Backend snapshots update shared tournament state and temporary chat.
setInterval(() => {
    if (loggedInPlayerId && currentTab === 'active') updateRoundBanner();
}, 1000);

function renderProfile() {
    const me = getMe();
    if (!me) return;
    if ($('stat-played')) $('stat-played').innerText = me.tournamentsPlayed || 0;
    if ($('stat-wins')) $('stat-wins').innerText = me.tournamentWins || 0;
    if ($('stat-runnerups')) $('stat-runnerups').innerText = me.runnerUps || 0;
}

// Replace HTML but keep whatever the player has typed / focused (so live refreshes never wipe a form)
function setHtmlKeepInputs(el, html) {
    const vals = {};
    el.querySelectorAll('input[id], textarea[id]').forEach(i => vals[i.id] = i.value);
    const ae = document.activeElement;
    const focusId = ae && el.contains(ae) && ae.id ? ae.id : null;
    const sel = focusId && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
    el.innerHTML = html;
    Object.keys(vals).forEach(id => { const i = $(id); if (i && vals[id] !== '') i.value = vals[id]; });
    if (focusId && $(focusId)) { const f = $(focusId); f.focus(); if (sel) { try { f.setSelectionRange(sel[0], sel[1]); } catch (e) { } } }
}

// ==========================================
// 4. TOURNAMENT REGISTRATION (Tournament Area, when no tour is live)
// ==========================================
let registrationBusy = false;
window.registerForTournament = async function (id) {
    if (registrationBusy) return;
    const ign = ($('ign-' + id)?.value || '').trim();
    const teamUrl = ($('team-' + id)?.value || '').trim();
    if (!ign) return alert('Enter your in-game name.');
    const teamText = ($('team-text-' + id)?.value || '').trim();
    let teamParsed = [];
    if (teamText) {
        const r = parseShowdown(teamText);
        if (r.errors.length) return alert('Fix your team first:\n- ' + r.errors.join('\n- '));
        teamParsed = r.team;
    }
    if (ign.length > 30) return alert('In-game name is too long (max 30 characters).');
    if (teamUrl) {
        try { const u = new URL(teamUrl); if (!/^https?:$/.test(u.protocol)) throw 0; }
        catch (e) { return alert('Team sheet must be a link starting with http:// or https://'); }
    }
    if (!loggedInPlayerId || !getMe()) return logout();
    registrationBusy = true;
    try {
        // Single atomic server operation; never replay other players' entries.
        await LimitlessStore.registerTournament(id, {
            ign, teamUrl, teamText, team: teamParsed, updatedAt: Date.now()
        });
        renderCurrent();
    } catch (error) {
        alert('Registration could not be saved: ' + error.message);
        await LimitlessStore.refresh(true);
    } finally { registrationBusy = false; }
};
window.enlistTournament = window.registerForTournament;

window.withdrawTournament = async function (id) {
    if (registrationBusy) return;
    if (!confirm('Withdraw from this tournament?')) return;
    registrationBusy = true;
    try {
        await LimitlessStore.withdrawTournament(id);
        renderCurrent();
    } catch (error) {
        alert('Withdrawal could not be saved: ' + error.message);
        await LimitlessStore.refresh(true);
    } finally { registrationBusy = false; }
};

function renderRegistration() {
    const container = $('inactive-tour-view');
    if (!container) return;
    const upcoming = db.tournaments.filter(t => t.status === 'UPCOMING')
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    let html = `<h2 class="text-2xl font-bold italic tracking-widest uppercase border-b border-gray-800 pb-4 mb-6 text-cyan-400">Tournament Registration</h2>`;
    if (upcoming.length === 0) {
        html += `<div class="cyber-box p-8 border-l-4 border-l-gray-600 text-center max-w-2xl mx-auto mt-10">
                    <h3 class="text-xl font-bold text-gray-400 mb-2 uppercase tracking-widest">No Open Tournaments</h3>
                    <p class="text-gray-500 text-xs tracking-widest uppercase mt-2">Registration will appear here when the Admin sanctions a new tournament. Pairings, Leaderboard, Battle and Drop unlock once it starts.</p>
                 </div>`;
    }

    const me = getMe();
    upcoming.forEach(t => {
        const reg = t.registeredPlayers || [];
        const isRegistered = reg.includes(loggedInPlayerId);
        const entry = (t.entries && t.entries[loggedInPlayerId]) || {};
        const details = [
            t.date ? esc(t.date) + (t.checkInTime ? ' @ ' + esc(t.checkInTime) : '') : '',
            `Swiss Rounds: ${t.totalRounds}`,
            t.roundTime ? `${t.roundTime} min rounds` : '',
            t.topCut ? `Top ${t.topCut}` : '',
            t.teamSheet ? `${esc(t.teamSheet)} Team Sheet` : ''
        ].filter(Boolean).join(' &nbsp;//&nbsp; ');

        const buttons = isRegistered
            ? `<div class="flex gap-3">
                   <button onclick="registerForTournament(${t.id})" class="flex-1 bg-cyan-900/40 border border-cyan-400 text-cyan-400 py-3 font-bold uppercase tracking-widest text-xs hover:bg-cyan-400 hover:text-black transition-colors clip-edge">Update Entry</button>
                   <button onclick="withdrawTournament(${t.id})" class="px-6 py-3 border border-red-500/50 bg-red-900/30 hover:bg-red-500 hover:text-black text-red-400 font-bold uppercase tracking-[0.2em] text-xs clip-edge transition-all">Withdraw</button>
               </div>`
            : `<button onclick="registerForTournament(${t.id})" class="w-full bg-cyan-900/40 border border-cyan-400 text-cyan-400 py-3 font-bold uppercase tracking-widest hover:bg-cyan-400 hover:text-black transition-colors clip-edge shadow-[0_0_15px_rgba(0,243,255,0.2)]">Confirm Registration</button>`;

        html += `
            <div class="cyber-box clip-edge border-l-4 border-l-cyan-500 p-8 mb-6 max-w-3xl bg-gradient-to-r ${isRegistered ? 'from-cyan-900/30' : 'from-transparent'} to-transparent">
                <div class="flex items-center space-x-4 mb-2">
                    <h3 class="text-3xl font-bold text-white italic tracking-widest uppercase">${esc(t.name)}</h3>
                    ${isRegistered ? '<span class="px-3 py-1 bg-cyan-500 text-black text-[10px] font-bold uppercase tracking-[0.2em] clip-edge animate-pulse">REGISTERED</span>' : ''}
                </div>
                <p class="text-xs text-gray-500 uppercase tracking-[0.2em] font-bold">${details}</p>
                ${t.bio ? `<p class="text-sm text-gray-400 mt-3">${esc(t.bio)}</p>` : ''}
                <p class="text-xs text-gray-500 uppercase tracking-[0.2em] mt-3 mb-6">Trainers registered: <span class="text-cyan-400 font-bold">${reg.length}</span></p>
                <div class="mb-4">
                    <label class="block text-cyan-400 text-xs uppercase tracking-widest mb-2">In-Game Name:</label>
                    <input type="text" id="ign-${t.id}" maxlength="30" value="${esc(entry.ign || (me ? me.username : ''))}" placeholder="e.g. SeaWolfMikes" class="w-full p-3 bg-black border border-cyan-900 text-white focus:border-cyan-400 outline-none transition-colors">
                </div>
                <div class="mb-6">
                    <label class="block text-cyan-400 text-xs uppercase tracking-widest mb-2">Team Sheet / Paste URL <span class="text-gray-600">(optional)</span>:</label>
                    <input type="text" id="team-${t.id}" value="${esc(entry.teamUrl || '')}" placeholder="Paste your pokepaste link here" class="w-full p-3 bg-black border border-cyan-900 text-white focus:border-cyan-400 outline-none transition-colors">
                </div>
                <div class="mb-6">
                    <label class="block text-cyan-400 text-xs uppercase tracking-widest mb-2">Your Team <span class="text-gray-600">(Pokemon Showdown format, optional)</span>:</label>
                    <textarea id="team-text-${t.id}" rows="10" spellcheck="false" oninput="previewTeam(${t.id})" placeholder="Garchomp @ Choice Scarf&#10;Ability: Rough Skin&#10;Tera Type: Steel&#10;EVs: 4 HP / 252 Atk / 252 Spe&#10;Jolly Nature&#10;- Earthquake&#10;- Dragon Claw&#10;- Rock Slide&#10;- Protect" class="team-input w-full p-3 text-sm">${esc(entry.teamText || '')}</textarea>
                    <div id="team-preview-${t.id}" class="mt-4"></div>
                </div>
                ${buttons}
            </div>`;
    });
    setHtmlKeepInputs(container, html);
    upcoming.forEach(t => previewTeam(t.id));
}

// ==========================================
// 5. LIVE TOURNAMENT (Pairings / Leaderboard / Battle / Drop)
// ==========================================
function pendingMatch(m, phase) {
    if (m.p2 === null) return false;
    return !m.winner || (phase === 'TOP_CUT' && m.winner === 'draw');
}

window.reportScore = function (matchId, result) {
    reloadDB();
    const t = getActive();
    const r = lastRoundOf(t);
    const m = r && r.matches.find(x => x.matchId === matchId);
    if (!m || m.p2 === null) return;
    if (m.p1 !== loggedInPlayerId && m.p2 !== loggedInPlayerId) return;
    if (r.processed) { alert("This round has already been finalized."); return renderActiveTournament(); }
    if (m.winner) { alert("A result has already been reported for this match. Ask the admin if it needs to be changed."); return renderActiveTournament(); }

    const isP1 = (m.p1 === loggedInPlayerId);
    if (result === 'win') m.winner = isP1 ? 'p1' : 'p2';
    if (result === 'loss') m.winner = isP1 ? 'p2' : 'p1';
    saveDB();
    renderActiveTournament();
};

window.checkIn = function () {
    reloadDB();
    const r = lastRoundOf(getActive());
    const m = r && r.matches.find(x => x.p1 === loggedInPlayerId || x.p2 === loggedInPlayerId);
    if (!m) return;
    if (m.p1 === loggedInPlayerId) m.p1CheckIn = true; else m.p2CheckIn = true;
    saveDB();
    renderActiveTournament();
};

window.dropFromTournament = function () {
    reloadDB();
    const t = getActive();
    const d = t && myDataOf();
    if (!t || !d) return alert("You are not part of an active tournament.");
    if (d.dropped) return;
    if (!confirm("Drop from the tournament? This cannot be undone.")) return;

    reloadDB();
    const t2 = getActive();
    const d2 = t2 && myDataOf();
    if (!t2 || !d2 || d2.dropped) return renderActiveTournament();
    d2.dropped = true;

    // A pending match is forfeited: the opponent is awarded the win.
    const r = lastRoundOf(t2);
    const m = r && !r.processed && r.matches.find(x => (x.p1 === loggedInPlayerId || x.p2 === loggedInPlayerId));
    if (m && m.p2 !== null && pendingMatch(m, r.phase)) m.winner = (m.p1 === loggedInPlayerId) ? 'p2' : 'p1';
    saveDB();
    renderActiveTournament();
};

window.selectPairingRound = function (i) {
    const t = getActive();
    const last = t ? t.pairings.length - 1 : 0;
    viewRoundIdx = (i >= last) ? null : i;
    renderActiveTournament();
};

function roundLabel(r) { return r.phase === 'SWISS' ? `R${r.round}` : String(r.round); }

function updateRoundBanner() {
    const t = getActive();
    const nameEl = $('round-banner-name'), timerEl = $('round-banner-timer');
    if (!t || !nameEl || !timerEl) return;
    const phase = t.phase === 'SWISS' ? `Swiss R${t.currentRound} / ${t.totalRounds}` : (t.topCutRoundStr || 'Top Cut');
    const label = `${esc(t.name)} <span class="text-gray-500">//</span> <span class="text-cyan-400">${esc(phase)}</span>`;
    if (nameEl.innerHTML !== label) nameEl.innerHTML = label;
    const left = Math.max(0, Math.floor(((t.roundEndTime || 0) - Date.now()) / 1000));
    const html = left === 0 ? `<span class="text-red-500 animate-pulse">TIME CALLED</span>`
        : `${Math.floor(left / 60).toString().padStart(2, '0')}:${(left % 60).toString().padStart(2, '0')}`;
    if (timerEl.innerHTML !== html) timerEl.innerHTML = html;
    const hp = $('round-hp');
    if (hp) {
        const total = (t.roundTime || 0) * 60, pct = total ? Math.min(100, left / total * 100) : 0;
        hp.style.display = total ? '' : 'none';
        hp.firstElementChild.style.width = pct + '%';
        hp.classList.toggle('mid', pct <= 50 && pct > 20);
        hp.classList.toggle('low', pct <= 20);
    }
}

function bracketHtml(pairings) {
    const rounds = pairings.filter(p => p.phase === 'TOP_CUT');
    if (!rounds.length) return '';
    let html = `<h3 class="text-sm text-yellow-500 uppercase font-bold tracking-[0.3em] mb-4 border-b border-gray-800 pb-2">Top Cut Bracket</h3><div class="flex flex-row gap-10 overflow-x-auto pb-4">`;
    rounds.forEach(round => {
        html += `<div class="flex flex-col justify-center min-w-[190px] space-y-4"><h4 class="text-center text-yellow-500 font-bold uppercase tracking-widest text-xs mb-1">${esc(round.round)}</h4>`;
        round.matches.forEach(m => {
            const decided = m.winner === 'p1' || m.winner === 'p2';
            const cls = (side, id) => (id === loggedInPlayerId ? 'text-cyan-400 ' : '') +
                (m.winner === side ? 'font-bold neon-text-gold' : (decided ? 'text-gray-600 line-through' : 'text-white font-bold'));
            html += `<div class="bg-black/80 border border-gray-800 p-3 text-sm tracking-wide">
                        <div class="${cls('p1', m.p1)} border-b border-gray-800 pb-2 mb-2">${esc(nameOf(m.p1))}</div>
                        <div class="${cls('p2', m.p2)}">${m.p2 ? esc(nameOf(m.p2)) : 'BYE'}</div>
                     </div>`;
        });
        html += `</div>`;
    });
    return html + '</div>';
}

function renderBattle(activeT, currentPairings) {
    const matchView = $('battle-match-view'), emptyView = $('battle-empty');
    if (!matchView || !emptyView) return;

    const myData = myDataOf();
    const myMatch = currentPairings && currentPairings.matches.find(m => m.p1 === loggedInPlayerId || m.p2 === loggedInPlayerId);

    let emptyMsg = null;
    if (!myData) emptyMsg = "You are not part of this tournament.";
    else if (myData.dropped) emptyMsg = "You have dropped from this tournament.";
    else if (!myMatch) emptyMsg = activeT.phase === 'TOP_CUT' ? "You are not in the current bracket round." : "You have no match this round.";
    else if (myMatch.p2 === null) emptyMsg = "You have a BYE this round. A win has been awarded automatically.";

    if (emptyMsg) {
        currentMatchId = null;
        matchView.classList.add('hidden');
        emptyView.classList.remove('hidden');
        emptyView.innerHTML = `<div class="cyber-box p-8 border-l-4 border-l-gray-600 text-center max-w-2xl mx-auto"><p class="text-gray-400 text-sm tracking-widest uppercase">${emptyMsg}</p></div>`;
        return;
    }
    matchView.classList.remove('hidden');
    emptyView.classList.add('hidden');

    if (currentMatchId !== myMatch.matchId) {          // new match -> clean slate
        currentMatchId = myMatch.matchId;
        resetBattleLocal();
        setBanner('progress');
        lockBattle(false);
    }

    const amP1 = myMatch.p1 === loggedInPlayerId;
    const oppId = amP1 ? myMatch.p2 : myMatch.p1;
    const oppData = (db.activeTournamentData || []).find(d => d.playerId === oppId);
    const rec = d => d ? `${d.wins} wins, ${d.losses} losses${d.draws ? ', ' + d.draws + ' draws' : ''}` : '';
    const roundText = currentPairings.phase === 'SWISS' ? `Swiss Round ${currentPairings.round}` : currentPairings.round;

    $('battle-title').innerText = `${activeT.name} - ${roundText}`;
    $('battle-p1-name').innerText = nameOf(loggedInPlayerId);
    $('battle-p1-record').innerText = rec(myData);
    $('battle-p2-name').innerText = nameOf(oppId);
    $('battle-p2-record').innerText = rec(oppData);

    const myChecked = amP1 ? myMatch.p1CheckIn : myMatch.p2CheckIn;
    const oppChecked = amP1 ? myMatch.p2CheckIn : myMatch.p1CheckIn;
    const ci = $('checkin-btn');
    if (ci) {
        ci.disabled = !!myChecked;
        ci.innerText = myChecked ? 'Checked In' : 'Check In';
        ci.classList.toggle('opacity-50', !!myChecked);
        ci.classList.toggle('cursor-not-allowed', !!myChecked);
    }
    if ($('checkin-status')) $('checkin-status').innerText = oppChecked ? 'Opponent is checked in' : 'Waiting for opponent to check in';

    if (myMatch.winner) {
        lockBattle(true);
        if (myMatch.winner === 'draw') setBanner('draw');
        else setBanner((myMatch.winner === 'p1') === amP1 ? 'win' : 'loss');
    } else if (battleLocked) {                         // admin reset a reported result
        lockBattle(false);
        resetBattleLocal();
        setBanner('progress');
    }

    const chatHistory = $('chat-history');
    if (chatHistory) {
        const chatHtml = (myMatch.chat || []).map(c => {
            if (c.senderId === loggedInPlayerId) {
                return `<div class="flex justify-end mb-2"><div class="bg-cyan-900/20 border-r-2 border-cyan-400 p-3 max-w-[80%] clip-edge"><div class="text-[9px] text-cyan-400 mb-1 tracking-widest uppercase">YOU</div><div class="text-sm text-gray-300">${esc(c.text)}</div></div></div>`;
            }
            return `<div class="flex justify-start mb-2"><div class="bg-red-900/20 border-l-2 border-red-500 p-3 max-w-[80%] clip-edge-reverse"><div class="text-[9px] text-red-500 mb-1 tracking-widest uppercase">${c.senderId === 'ADMIN' ? 'ADMIN' : esc(nameOf(c.senderId))}</div><div class="text-sm text-gray-300">${esc(c.text)}</div></div></div>`;
        }).join('');
        if (chatHistory.dataset.html !== chatHtml) {
            chatHistory.dataset.html = chatHtml;
            chatHistory.innerHTML = chatHtml;
            chatHistory.scrollTop = chatHistory.scrollHeight;
        }
    }
}

function renderActiveTournament() {
    const activeT = getActive();
    const activeView = $('active-tour-view');
    const inactiveView = $('inactive-tour-view');

    // NO LIVE TOURNAMENT -> registration only
    if (!activeT) {
        currentMatchId = null;
        if (activeView) activeView.classList.add('hidden');
        if (inactiveView) inactiveView.classList.remove('hidden');
        renderRegistration();
        return;
    }

    // LIVE TOURNAMENT -> Pairings / Leaderboard / Battle / Drop
    if (activeView) activeView.classList.remove('hidden');
    if (inactiveView) inactiveView.classList.add('hidden');
    updateRoundBanner();

    // Leaderboard
    const tbody = $('active-tbody');
    if (tbody) {
        const sorted = [...(db.activeTournamentData || [])].sort((a, b) => (b.points - a.points) || (b.wins - a.wins));
        let html = '';
        sorted.forEach((d, index) => {
            const p = db.players.find(pl => pl.id === d.playerId);
            if (!p) return;
            const isMe = p.id === loggedInPlayerId;
            const rowClass = isMe ? 'bg-cyan-900/20 border-l-4 border-cyan-400' : 'border-l-4 border-transparent';
            const dropTag = d.dropped ? ' <span class="text-[9px] text-red-500 tracking-widest">DROPPED</span>' : '';
            html += `<tr class="${rowClass}"><td class="px-6 py-4 font-bold text-gray-500 italic">${index + 1}</td><td class="px-6 py-4 font-bold tracking-widest uppercase ${isMe ? 'text-cyan-400' : 'text-gray-300'}">${esc(p.username)}${dropTag}</td><td class="px-6 py-4 font-mono text-white">${d.points} Pts (${d.wins}-${d.losses}-${d.draws})</td></tr>`;
        });
        if (tbody.dataset.html !== html) { tbody.dataset.html = html; tbody.innerHTML = html; }
    }

    // Pairings (with round selector)
    const rounds = activeT.pairings || [];
    const currentPairings = lastRoundOf(activeT);
    const viewIdx = (viewRoundIdx === null || viewRoundIdx >= rounds.length) ? rounds.length - 1 : viewRoundIdx;
    const nav = $('rounds-nav');
    if (nav) {
        const navHtml = rounds.map((r, i) => `<button onclick="selectPairingRound(${i})" class="page-nav-btn ${i === viewIdx ? 'active' : ''}">${esc(roundLabel(r))}</button>`).join('');
        if (nav.dataset.html !== navHtml) { nav.dataset.html = navHtml; nav.innerHTML = navHtml; }
    }
    const pairingsList = $('pairings-list');
    if (pairingsList && rounds[viewIdx]) {
        const vr = rounds[viewIdx];
        let html = '';
        vr.matches.forEach(m => {
            const n1 = esc(nameOf(m.p1));
            const n2 = m.p2 ? esc(nameOf(m.p2)) : 'BYE';
            const c1 = (m.p1 === loggedInPlayerId ? 'text-cyan-400 font-bold' : 'text-gray-300') + (m.winner === 'p1' ? ' neon-text-gold' : '');
            const c2 = (m.p2 === loggedInPlayerId ? 'text-cyan-400 font-bold' : 'text-gray-300') + (m.winner === 'p2' ? ' neon-text-gold' : '');
            let status;
            if (m.p2 === null) status = `<span class="text-yellow-500 text-[10px] tracking-widest uppercase border border-yellow-500/30 px-2 py-1">Bye</span>`;
            else if (m.winner === 'draw') status = `<span class="text-gray-400 text-[10px] tracking-widest uppercase border border-gray-700 px-2 py-1">Draw</span>`;
            else if (m.winner) status = `<span class="text-gray-500 text-[10px] tracking-widest uppercase border border-gray-700 px-2 py-1">Finished</span>`;
            else status = `<span class="text-yellow-500 animate-pulse text-[10px] tracking-widest uppercase border border-yellow-500/30 px-2 py-1">In Progress</span>`;
            html += `<div class="bg-black/80 border border-gray-800 p-4 flex justify-between items-center clip-edge mb-2">
                        <div class="text-sm tracking-widest uppercase"><span class="${c1}">${n1}</span> <span class="text-red-500 italic px-2">VS</span> <span class="${c2}">${n2}</span></div>
                        ${status}
                     </div>`;
        });
        if (pairingsList.dataset.html !== html) { pairingsList.dataset.html = html; pairingsList.innerHTML = html; }
    }

    renderBattle(activeT, currentPairings);

    const bt = $('battle-team');
    if (bt) {
        const e = activeT.entries && activeT.entries[loggedInPlayerId];
        const h = e && e.team && e.team.length ? `<h3 class="section-title">Your team</h3>${teamGridHtml(e.team, true)}` : '';
        if (bt.dataset.html !== h) { bt.dataset.html = h; bt.innerHTML = h; }
    }

    const bracket = $('player-bracket-container');
    if (bracket) {
        const bh = bracketHtml(rounds);
        if (bracket.dataset.html !== bh) { bracket.dataset.html = bh; bracket.innerHTML = bh; }
    }

    // Drop
    const dropStatus = $('drop-status'), dropBtn = $('drop-btn');
    if (dropStatus && dropBtn) {
        const myData = myDataOf();
        let msg = "Dropping from the tournament cannot be undone.", disabled = false;
        if (!myData) { msg = "You are not part of this tournament."; disabled = true; }
        else if (myData.dropped) { msg = "You have dropped from this tournament."; disabled = true; }
        dropStatus.innerText = msg;
        dropBtn.disabled = disabled;
        dropBtn.classList.toggle('opacity-40', disabled);
        dropBtn.classList.toggle('cursor-not-allowed', disabled);
    }
}

// ==========================================
// 6. HISTORY (only tournaments this player played)
// ==========================================
function renderHistory() {
    const container = $('history-container');
    if (!container) return;
    const played = db.history.filter(h => h.results.some(r => r.playerId === loggedInPlayerId));

    let html = '';
    if (played.length === 0) {
        html = `<div class="cyber-box p-8 border-l-4 border-l-gray-600 text-center max-w-2xl mx-auto mt-10">
                    <h3 class="text-xl font-bold text-gray-400 mb-2 uppercase tracking-widest">No Played Tournaments</h3>
                    <p class="text-gray-500 text-xs tracking-widest uppercase mt-2">Tournaments you finish will be archived here.</p>
                </div>`;
    }
    [...played].reverse().forEach(h => {
        const results = [...h.results].sort((a, b) => a.finalPosition - b.finalPosition);
        const mine = results.find(r => r.playerId === loggedInPlayerId);
        const winner = results.find(r => r.isWinner)?.playerName || 'UNCLAIMED';

        const resultsHtml = results.map(r => {
            const isMe = r.playerId === loggedInPlayerId;
            const rankColor = r.isWinner ? 'neon-text-gold text-lg' : (isMe ? 'neon-text-cyan' : 'text-gray-400');
            return `
                <div class="flex justify-between items-center border-b border-gray-800/50 py-4 ${isMe ? 'bg-cyan-900/10 px-4 -mx-4 border-l-2 border-cyan-400' : ''}">
                    <span class="${rankColor} font-bold uppercase tracking-widest"><span class="w-8 inline-block text-gray-600">${r.finalPosition}.</span> ${esc(r.playerName)} ${isMe ? '<span class="text-[9px] ml-2 text-cyan-500">YOU</span>' : ''}</span>
                    ${r.isWinner ? '<span class="text-[10px] border border-yellow-500 bg-yellow-500/10 text-yellow-500 px-3 py-1 font-bold uppercase tracking-[0.2em] clip-edge">Champion</span>' : ''}
                </div>`;
        }).join('');

        html += `
            <div class="cyber-box clip-edge border-l-4 border-l-yellow-500 p-8 bg-gradient-to-br from-black to-zinc-900/50 relative overflow-hidden mb-6">
                <div class="absolute -right-10 -bottom-10 text-9xl font-bold italic text-white/[0.02] tracking-tighter pointer-events-none">LMTLSS</div>
                <div class="mb-8 border-b border-gray-800 pb-6 relative z-10 flex justify-between items-end">
                    <div>
                        <h3 class="text-4xl font-bold text-white italic uppercase tracking-widest mb-3">${esc(h.tournamentName)}</h3>
                        <p class="text-xs text-gray-500 uppercase tracking-[0.2em] font-bold">Victor: <span class="neon-text-gold text-lg">${esc(winner)}</span></p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-gray-500 uppercase tracking-[0.2em] mb-1">Your Final Rank</p>
                        <p class="text-3xl font-bold ${mine.isWinner ? 'neon-text-gold' : 'text-cyan-400'}">${mine.finalPosition}</p>
                    </div>
                </div>
                <div class="relative z-10">
                    <p class="text-[10px] text-gray-600 font-bold mb-4 uppercase tracking-[0.3em]">Final Standings</p>
                    ${resultsHtml}
                </div>
            </div>`;
    });
    if (container.dataset.html !== html) { container.dataset.html = html; container.innerHTML = html; }
}

// ==========================================
// 7. SHOWDOWN TEAM IMPORT
// ==========================================
const NATURES = new Set('hardy lonely brave adamant naughty bold docile relaxed impish lax timid hasty serious jolly naive modest mild quiet bashful rash calm gentle sassy careful quirky'.split(' '));
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
const TYPE_COLORS = { normal: '#a8a77a', fire: '#ee8130', water: '#6390f0', electric: '#f7d02c', grass: '#7ac74c', ice: '#96d9d6', fighting: '#c22e28', poison: '#a33ea1', ground: '#e2bf65', flying: '#a98ff3', psychic: '#f95587', bug: '#a6b91a', rock: '#b6a136', ghost: '#735797', dragon: '#6f35fc', dark: '#705746', steel: '#b7b7ce', fairy: '#d685ad', stellar: '#44e0c8' };
const HYPHEN_NAMES = ['ho-oh', 'porygon-z', 'jangmo-o', 'hakamo-o', 'kommo-o', 'ting-lu', 'chien-pao', 'wo-chien', 'chi-yu'];
const toID = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const toSlug = s => String(s || '').toLowerCase().replace(/[\u2019'.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "Urshifu-Rapid-Strike" -> "urshifu-rapidstrike" (the file name Showdown uses for sprites)
function spriteId(species) {
    const s = String(species || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.:'\u2019%]/g, '').replace(/\s+/g, '');
    let base = s, forme = '';
    const h = HYPHEN_NAMES.find(x => s === x || s.startsWith(x + '-'));
    if (h) { base = h.replace('-', ''); forme = s.slice(h.length + 1); }
    else { const i = s.indexOf('-'); if (i > 0) { base = s.slice(0, i); forme = s.slice(i + 1); } }
    return base.replace(/[^a-z0-9]/g, '') + (forme ? '-' + forme.replace(/[^a-z0-9]/g, '') : '');
}

function parseStats(str) {
    const out = {};
    str.split('/').forEach(p => {
        const m = p.trim().match(/^(\d+)\s*(HP|Atk|Def|SpA|SpD|Spe)$/i);
        if (m) out[toID(m[2])] = parseInt(m[1], 10);
    });
    return out;
}

function parseShowdown(text) {
    const team = [], errors = [], warnings = [];
    const blocks = String(text || '').replace(/\r/g, '').split(/\n\s*\n/)
        .map(b => b.split('\n').map(l => l.trim()).filter(l => l && !/^===.*===$/.test(l)))
        .filter(b => b.length);
    blocks.forEach((lines, n) => {
        let first = lines[0], item = '', gender = '', nickname = '';
        if (/^(ability|evs|ivs|level|tera type|shiny|happiness|-)/i.test(first) || /\snature$/i.test(first)) {
            errors.push(`Pokemon ${n + 1} is missing its first line (for example "Garchomp @ Choice Scarf").`);
            return;
        }
        const at = first.indexOf(' @ ');
        if (at > -1) { item = first.slice(at + 3).trim(); first = first.slice(0, at).trim(); }
        const g = first.match(/\s\((M|F)\)$/);
        if (g) { gender = g[1]; first = first.slice(0, g.index).trim(); }
        let species = first;
        const sp = first.match(/^(.+?)\s\(([^()]+)\)$/);
        if (sp) { nickname = sp[1].trim(); species = sp[2].trim(); }
        const m = { species, nickname, gender, item: /^\(?none\)?$/i.test(item) ? '' : item, ability: '', level: 100, tera: '', nature: '', shiny: false, evs: {}, ivs: {}, moves: [] };
        lines.slice(1).forEach(l => {
            let x;
            if (/^[-\u2013]/.test(l)) { const mv = l.replace(/^[-\u2013]\s*/, '').trim(); if (mv) m.moves.push(mv); }
            else if ((x = l.match(/^ability:\s*(.+)$/i))) m.ability = x[1].trim();
            else if ((x = l.match(/^level:\s*(\d+)/i))) m.level = parseInt(x[1], 10);
            else if ((x = l.match(/^tera type:\s*(.+)$/i))) m.tera = x[1].trim();
            else if (/^shiny:\s*yes/i.test(l)) m.shiny = true;
            else if ((x = l.match(/^evs:\s*(.+)$/i))) m.evs = parseStats(x[1]);
            else if ((x = l.match(/^ivs:\s*(.+)$/i))) m.ivs = parseStats(x[1]);
            else if ((x = l.match(/^(\S+)\s+nature$/i))) m.nature = x[1];
        });
        const evSum = Object.values(m.evs).reduce((a, b) => a + b, 0);
        if (m.moves.length > 4) errors.push(`${species} has ${m.moves.length} moves (max 4).`);
        else if (!m.moves.length) warnings.push(`${species} has no moves listed.`);
        if (Object.values(m.evs).some(v => v > 252)) errors.push(`${species} has more than 252 EVs in one stat.`);
        if (evSum > 510) errors.push(`${species} has ${evSum} EVs in total (max 510).`);
        if (Object.values(m.ivs).some(v => v > 31)) errors.push(`${species} has an IV above 31.`);
        if (m.level < 1 || m.level > 100) errors.push(`${species} has an invalid level.`);
        if (m.nature && !NATURES.has(toID(m.nature))) warnings.push(`${species}: "${m.nature}" is not a known nature.`);
        team.push(m);
    });
    if (team.length > 6) errors.push(`A team can have at most 6 Pokemon (found ${team.length}).`);
    const seen = new Set();
    team.forEach(m => { const id = toID(m.species); if (seen.has(id)) warnings.push(`${m.species} appears more than once.`); seen.add(id); });
    return { team, errors, warnings };
}

window.spriteFallback = function (img) {
    if (!img.dataset.f) { img.dataset.f = '1'; img.src = `https://play.pokemonshowdown.com/sprites/gen5${img.dataset.shiny ? '-shiny' : ''}/${img.dataset.id}.png`; }
    else { img.onerror = null; img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; img.classList.add('missing'); }
};

function monCardHtml(m, i, animate) {
    const id = spriteId(m.species), sh = m.shiny ? '-shiny' : '';
    const evs = Object.entries(m.evs).filter(([, v]) => v > 0).map(([k, v]) => `<span class="stat-chip">${v} ${STAT_LABEL[k] || esc(k)}</span>`).join('');
    const tags = [
        m.tera ? `<span class="tag"><i class="tera-gem" style="--tc:${TYPE_COLORS[toID(m.tera)] || '#b69cff'}"></i>Tera ${esc(m.tera)}</span>` : '',
        m.item ? `<span class="tag"><img src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/${toSlug(m.item)}.png" alt="" onerror="this.remove()">${esc(m.item)}</span>` : '',
        m.level !== 100 ? `<span class="tag">Lv ${m.level}</span>` : ''
    ].join('');
    return `<article class="mon-card${animate ? ' pop' : ''}" style="--i:${i}">
        <div class="mon-stage"><img class="mon-sprite" src="https://play.pokemonshowdown.com/sprites/ani${sh}/${id}.gif" data-id="${id}" ${sh ? 'data-shiny="1"' : ''} alt="${esc(m.species)}" onerror="spriteFallback(this)"></div>
        <div class="mon-body">
            <h4 class="mon-name">${esc(m.nickname || m.species)}${m.gender ? `<span class="gender g-${m.gender}">${m.gender === 'M' ? '\u2642' : '\u2640'}</span>` : ''}</h4>
            ${m.nickname ? `<p class="mon-sub">${esc(m.species)}</p>` : ''}
            ${tags ? `<div class="mon-tags">${tags}</div>` : ''}
            ${m.ability ? `<p class="mon-line"><b>Ability</b>${esc(m.ability)}</p>` : ''}
            <div class="mon-moves">${m.moves.map(mv => `<span title="${esc(mv)}">${esc(mv)}</span>`).join('')}</div>
            ${evs || m.nature ? `<div class="mon-tags">${m.nature ? `<span class="stat-chip nat">${esc(m.nature)}</span>` : ''}${evs}</div>` : ''}
        </div>
    </article>`;
}

function teamGridHtml(team, animate) {
    return team.length ? `<div class="team-grid">${team.map((m, i) => monCardHtml(m, i, animate)).join('')}</div>` : '';
}

function teamIssuesHtml(r) {
    const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');
    return (r.errors.length ? `<ul class="team-issues err">${li(r.errors)}</ul>` : '') +
        (r.warnings.length ? `<ul class="team-issues warn">${li(r.warnings)}</ul>` : '');
}

window.previewTeam = function (id) {
    const ta = $('team-text-' + id), box = $('team-preview-' + id);
    if (!ta || !box) return;
    const txt = ta.value;
    let h;
    if (!txt.trim()) h = '<p class="team-empty">Paste a team exported from Pokemon Showdown. It appears here as you type.</p>';
    else { const r = parseShowdown(txt); h = teamIssuesHtml(r) + teamGridHtml(r.team, false); }
    if (box.dataset.html !== h) { box.dataset.html = h; box.innerHTML = h; }
};
