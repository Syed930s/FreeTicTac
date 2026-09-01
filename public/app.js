const API_URL = "/api";

const SESSION_KEY = "freetictac_session_v2";
const CURRENT_LOBBY_KEY = "freetictac_current_lobby_v1";

const DEFAULT_AVATAR =
"data:image/svg+xml;utf8," +
encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
    <rect width="96" height="96" rx="10" fill="#89a7cf"></rect>
    <text x="48" y="60" font-size="32" text-anchor="middle" fill="white" font-family="Arial, sans-serif">:)</text>
    </svg>`
    );

    const WIN_LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
[0, 3, 6], [1, 4, 7], [2, 5, 8],
[0, 4, 8], [2, 4, 6]
    ];

    let session = loadSession();
    let pendingAvatarDataUrl = null;
    let authMode = "login";
    let currentLobbyId = localStorage.getItem(CURRENT_LOBBY_KEY);
    let gamePollTimer = null;
    let lobbyListTimer = null;
    let lastLobbyJson = "";
    let botGame = null;
    let currentModTarget = null;
    let currentModPerms = null;
    let currentModRelation = null;
    let pendingSocialLobby = null;

    const $ = (id) => document.getElementById(id);

    document.addEventListener("DOMContentLoaded", init);

    function loadSession() {
        try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
    }

    function saveSession(value) {
        session = value;
        localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    }

    function clearSession() {
        session = null;
        localStorage.removeItem(SESSION_KEY);
    }

    function init() {
        bindAuthEvents();
        bindLobbyEvents();
        bindGameEvents();
        bindBotEvents();
        bindSearchModEvents();
        bindSocialEvents();

        if (!session) { showAuthScreen(); return; }
        if (currentLobbyId) { showGameScreen(); } else { showLobbyScreen(); }
    }

    function showScreen(id) {
        ["auth-screen", "lobby-screen", "game-screen", "bot-screen", "mod-screen"].forEach((s) => $(s).classList.add("hidden"));
        $(id).classList.remove("hidden");
    }

    function showAuthScreen() {
        stopAllPolling();
        currentLobbyId = null;
        localStorage.removeItem(CURRENT_LOBBY_KEY);
        setAuthMode(session ? "edit" : "login");
        showScreen("auth-screen");
    }

    function showLobbyScreen() {
        stopGamePoll();
        showScreen("lobby-screen");
        renderProfileBar();
        startLobbyListPoll();
        loadLobbies();
        loadSocial();
    }

    function showGameScreen() {
        stopLobbyListPoll();
        if (!currentLobbyId) { showLobbyScreen(); return; }
        lastLobbyJson = "";
        showScreen("game-screen");
        startGamePoll();
    }

    function showBotScreen() {
        stopAllPolling();
        botGame = null;
        $("bot-setup").classList.remove("hidden");
        $("bot-game").classList.add("hidden");
        showScreen("bot-screen");
    }

    function bindAuthEvents() {
        $("tab-login").addEventListener("click", () => setAuthMode("login"));
        $("tab-register").addEventListener("click", () => setAuthMode("register"));
        $("auth-avatar").addEventListener("change", async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try { pendingAvatarDataUrl = await compressImageFile(file); $("auth-error").textContent = ""; renderAuthPreview(); }
            catch (error) { $("auth-error").textContent = error.message; }
        });
        $("auth-submit").addEventListener("click", submitAuth);
    }

    function setAuthMode(mode) {
        authMode = mode;
        $("register-fields").classList.toggle("hidden", mode === "login");
        $("auth-title").textContent = mode === "register" ? "Create account" : mode === "edit" ? "Update profile" : "Log in";
        $("auth-submit").textContent = mode === "register" ? "Create account" : mode === "edit" ? "Save changes" : "Log in";
        $("tab-login").classList.toggle("secondary", mode !== "login");
        $("tab-register").classList.toggle("secondary", mode !== "register");
        if (mode === "edit" && session) { $("auth-username").value = session.username; $("auth-displayname").value = session.displayName; pendingAvatarDataUrl = null; }
        $("auth-error").textContent = "";
        renderAuthPreview();
    }

    function renderAuthPreview() {
        $("auth-avatar-preview").src = pendingAvatarDataUrl || session?.avatarThumb || DEFAULT_AVATAR;
    }

    async function submitAuth() {
        const username = $("auth-username").value.trim().toLowerCase();
        const password = $("auth-password").value;
        const displayName = $("auth-displayname").value.trim();
        $("auth-error").textContent = "";
        try {
            if (authMode === "login") { enterSession((await api("login", { method: "POST", body: { username, password } })).session); return; }
            if (authMode === "register") { enterSession((await api("register", { method: "POST", body: { username, password, displayName, avatarThumb: pendingAvatarDataUrl || "" } })).session); return; }
            enterSession((await api("updateProfile", { method: "POST", body: { username: session.username, sessionToken: session.token, displayName: displayName || session.displayName, avatarThumb: pendingAvatarDataUrl !== null ? pendingAvatarDataUrl : session.avatarThumb } })).session);
        } catch (error) { $("auth-error").textContent = error.message; }
    }

    function enterSession(newSession) {
        saveSession(newSession);
        pendingAvatarDataUrl = null;
        $("auth-password").value = "";
        currentLobbyId = null;
        localStorage.removeItem(CURRENT_LOBBY_KEY);
        showLobbyScreen();
    }

    function bindLobbyEvents() {
        $("create-lobby").addEventListener("click", createLobby);
        $("refresh-lobbies").addEventListener("click", loadLobbies);
        $("play-bot").addEventListener("click", showBotScreen);
        $("edit-profile").addEventListener("click", showAuthScreen);
        $("logout").addEventListener("click", async () => {
            try { await api("logout", { method: "POST", body: { username: session.username, sessionToken: session.token } }); } catch {}
            clearSession(); showAuthScreen();
        });
    }

    function renderProfileBar() {
        $("lobby-avatar").src = session.avatarThumb || DEFAULT_AVATAR;
        $("lobby-displayname").textContent = session.displayName;
        const roleLabel = session.role === "owner" ? " • Owner" : session.role === "moderator" ? " • Mod" : "";
        $("lobby-username").textContent = `@${session.username}${roleLabel}`;
    }

    function authBody(extra = {}) {
        return { username: session.username, sessionToken: session.token, ...extra };
    }

    async function createLobby() {
        try {
            $("lobby-list-error").textContent = "";
            const data = await api("createLobby", { method: "POST", body: authBody({ public: true }) });
            currentLobbyId = data.lobbyId;
            localStorage.setItem(CURRENT_LOBBY_KEY, currentLobbyId);
            showGameScreen();
            renderLobby(data.lobby);
        } catch (error) { handleAuthError(error, "lobby-list-error"); }
    }

    async function loadLobbies() {
        try { $("lobby-list-error").textContent = ""; renderLobbyList((await api("listLobbies")).lobbies || []); }
        catch (error) { $("lobby-list-error").textContent = error.message; }
    }

    function renderLobbyList(lobbies) {
        const tbody = $("lobby-list"); tbody.innerHTML = "";
        if (!lobbies.length) {
            const tr = document.createElement("tr"); const td = document.createElement("td");
            td.colSpan = 4; td.textContent = "No public lobbies yet. Create one, or play with the bot!";
            tr.appendChild(td); tbody.appendChild(tr); return;
        }
        for (const lobby of lobbies) {
            const tr = document.createElement("tr");
            const idCell = document.createElement("td"); idCell.textContent = lobby.id;
            const hostCell = document.createElement("td"); hostCell.textContent = lobby.hostName || "Player";
            const playersCell = document.createElement("td"); playersCell.textContent = `${lobby.playerCount}/2`;
            const actionCell = document.createElement("td");
            const joinButton = document.createElement("button"); joinButton.className = "button-2010"; joinButton.textContent = "Join";
            joinButton.addEventListener("click", () => joinLobby(lobby.id));
            actionCell.appendChild(joinButton);
            tr.appendChild(idCell); tr.appendChild(hostCell); tr.appendChild(playersCell); tr.appendChild(actionCell);
            tbody.appendChild(tr);
        }
    }

    async function joinLobby(lobbyId) {
        try {
            $("lobby-list-error").textContent = "";
            const data = await api("joinLobby", { method: "POST", body: authBody({ lobbyId }) });
            currentLobbyId = lobbyId; localStorage.setItem(CURRENT_LOBBY_KEY, currentLobbyId);
            showGameScreen(); renderLobby(data.lobby);
        } catch (error) { handleAuthError(error, "lobby-list-error"); loadLobbies(); }
    }

    async function refreshLobby() {
        if (!currentLobbyId) { showLobbyScreen(); return; }
        try { renderLobby((await api("getLobby", { params: { lobbyId: currentLobbyId } })).lobby); }
        catch (error) { if (/not found/i.test(error.message)) leaveLobbyLocally(); else $("game-error").textContent = error.message; }
    }

    function handleAuthError(error, elementId) {
        if (/logged in|session invalid/i.test(error.message)) { clearSession(); showAuthScreen(); return; }
        if (/banned/i.test(error.message)) { clearSession(); showAuthScreen(); $("auth-error").textContent = error.message; return; }
        $(elementId).textContent = error.message;
    }

    function renderLobby(lobby) {
        if (!lobby) return;
        const j = JSON.stringify(lobby); if (j === lastLobbyJson) return; lastLobbyJson = j;
        $("game-error").textContent = "";
        renderPlayers(lobby); renderStatus(lobby); renderBoard(lobby); renderChat(lobby); renderRematchButton(lobby);
    }

    function renderPlayers(lobby) {
        const xP = lobby.players.find(p => p.symbol === "X");
        const oP = lobby.players.find(p => p.symbol === "O");
        $("player-x-panel").innerHTML = ""; $("player-o-panel").innerHTML = "";
        $("player-x-panel").appendChild(playerBadge(xP, "X"));
        $("player-o-panel").appendChild(playerBadge(oP, "O"));
    }

    function playerBadge(player, symbol) {
        const w = document.createElement("div"); w.className = "player-badge";
        const img = document.createElement("img"); img.className = "avatar"; img.src = player?.avatarThumb || DEFAULT_AVATAR; img.alt = "";
        const name = document.createElement("div"); name.className = "player-name";
        name.textContent = player ? `${player.displayName} (${symbol})` : `Waiting for ${symbol}...`;
        w.appendChild(img); w.appendChild(name); return w;
    }

    function renderStatus(lobby) {
        const me = lobby.players.find(p => p.playerId === session.username);
        let text = "";
        if (lobby.status === "waiting") text = "Waiting for another player...";
        else if (lobby.game.status === "active") text = lobby.game.currentTurn === me?.symbol ? "Your turn!" : `Waiting for ${lobby.game.currentTurn}...`;
        else if (lobby.game.status === "finished") {
            if (lobby.game.winner === "draw") text = "Draw!";
            else { const w = lobby.players.find(p => p.symbol === lobby.game.winner); text = w?.playerId === session.username ? "You win!" : `${w?.displayName || lobby.game.winner} wins!`; }
        }
        $("game-status").textContent = text;
    }

    function renderBoard(lobby) {
        const board = $("board"); board.innerHTML = "";
        const me = lobby.players.find(p => p.playerId === session.username);
        const canMove = lobby.status === "active" && lobby.game.status === "active" && Boolean(me) && lobby.game.currentTurn === me.symbol;
        lobby.game.board.forEach((value, index) => {
            const button = document.createElement("button");
            button.className = "cell" + (value ? ` ${value.toLowerCase()}` : "");
            button.textContent = value || ""; button.disabled = !canMove || value !== null;
            button.addEventListener("click", () => doMakeMove(index)); board.appendChild(button);
        });
    }

    async function doMakeMove(cell) {
        try { $("game-error").textContent = ""; await api("makeMove", { method: "POST", body: authBody({ lobbyId: currentLobbyId, cell }) }); await refreshLobby(); }
        catch (error) { handleAuthError(error, "game-error"); await refreshLobby(); }
    }

    async function requestRematch() {
        try { $("game-error").textContent = ""; await api("rematch", { method: "POST", body: authBody({ lobbyId: currentLobbyId }) }); await refreshLobby(); }
        catch (error) { handleAuthError(error, "game-error"); await refreshLobby(); }
    }

    function renderRematchButton(lobby) {
        const button = $("rematch-button");
        if (lobby.status !== "finished") { button.classList.add("hidden"); return; }
        button.classList.remove("hidden");
        const rematchList = Array.isArray(lobby.rematch) ? lobby.rematch : [];
        const iAccepted = rematchList.includes(session.username);
        const otherAccepted = rematchList.some(id => id !== session.username);
        if (iAccepted) { button.disabled = true; button.textContent = otherAccepted ? "Starting rematch..." : "Waiting for other player..."; }
        else { button.disabled = false; button.textContent = "Rematch"; }
    }

    function renderChat(lobby) {
        const box = $("chat-box"); box.innerHTML = "";
        for (const message of lobby.messages || []) {
            const line = document.createElement("div"); line.className = "chat-line";
            const img = document.createElement("img"); img.className = "avatar-small"; img.src = message.avatarThumb || DEFAULT_AVATAR; img.alt = "";
            const content = document.createElement("div"); content.className = "chat-content";
            const meta = document.createElement("div"); meta.className = "chat-meta";
            const name = document.createElement("strong"); name.textContent = message.displayName || message.username || "System";
            const time = document.createElement("span"); time.className = "muted";
            time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            meta.appendChild(name); meta.appendChild(time);
            const text = document.createElement("div"); text.textContent = message.text;
            content.appendChild(meta); content.appendChild(text);
            line.appendChild(img); line.appendChild(content); box.appendChild(line);
        }
        box.scrollTop = box.scrollHeight;
    }

    function bindGameEvents() {
        $("rematch-button").addEventListener("click", requestRematch);
        $("chat-form").addEventListener("submit", async (event) => {
            event.preventDefault(); const input = $("chat-input"); const text = input.value.trim(); if (!text) return;
            try { $("game-error").textContent = ""; await api("sendMessage", { method: "POST", body: authBody({ lobbyId: currentLobbyId, text }) }); input.value = ""; await refreshLobby(); }
            catch (error) { handleAuthError(error, "game-error"); }
        });
        $("leave-lobby").addEventListener("click", async () => {
            try { if (currentLobbyId && session) await api("leaveLobby", { method: "POST", body: authBody({ lobbyId: currentLobbyId }) }); } catch {}
            leaveLobbyLocally();
        });
    }

    function leaveLobbyLocally() { currentLobbyId = null; localStorage.removeItem(CURRENT_LOBBY_KEY); lastLobbyJson = ""; showLobbyScreen(); }

    function bindSocialEvents() {
        $("social-banner-join").addEventListener("click", () => {
            if (!pendingSocialLobby) return;
            currentLobbyId = pendingSocialLobby; localStorage.setItem(CURRENT_LOBBY_KEY, currentLobbyId); showGameScreen();
        });
    }

    async function loadSocial() {
        if (!session) return;
        try { renderSocial(await api("getSocial", { method: "POST", body: authBody() })); }
        catch (error) { if (/logged in|session invalid|banned/i.test(error.message)) { clearSession(); showAuthScreen(); } }
    }

    function renderSocial(data) {
        pendingSocialLobby = data.pendingLobby || null;
        const banner = $("social-banner");
        if (pendingSocialLobby && pendingSocialLobby !== currentLobbyId) {
            banner.classList.remove("hidden"); $("social-banner-text").textContent = "Your challenge was accepted! A private game is waiting for you.";
        } else { banner.classList.add("hidden"); }

        const challengesBox = $("challenges-box"); challengesBox.innerHTML = "";
        for (const ch of data.challengesIn || []) {
            const row = socialRow(ch, `${ch.displayName} challenges you to a game!`);
            const a = document.createElement("button"); a.className = "button-2010"; a.textContent = "Accept"; a.addEventListener("click", () => respondChallengeAction(ch.username, true));
            const d = document.createElement("button"); d.className = "button-2010 danger"; d.textContent = "Decline"; d.addEventListener("click", () => respondChallengeAction(ch.username, false));
            row.appendChild(a); row.appendChild(d); challengesBox.appendChild(row);
        }

        const requestsBox = $("requests-box"); requestsBox.innerHTML = "";
        for (const req of data.requestsIn || []) {
            const row = socialRow(req, `${req.displayName} (@${req.username}) sent you a friend request.`);
            const a = document.createElement("button"); a.className = "button-2010"; a.textContent = "Accept"; a.addEventListener("click", () => respondFriendRequestAction(req.username, true));
            const d = document.createElement("button"); d.className = "button-2010 danger"; d.textContent = "Decline"; d.addEventListener("click", () => respondFriendRequestAction(req.username, false));
            row.appendChild(a); row.appendChild(d); requestsBox.appendChild(row);
        }

        const friendsBox = $("friends-box"); friendsBox.innerHTML = "";
        const friends = data.friends || [];
        if (!friends.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No friends yet. Search a player and add them!"; friendsBox.appendChild(p); return; }

        for (const friend of friends) {
            const row = socialRow(friend, `${friend.displayName} (@${friend.username})`);
            const cb = document.createElement("button"); cb.className = "button-2010"; cb.textContent = "Challenge"; cb.addEventListener("click", () => challengeFriend(friend.username));
            const vb = document.createElement("button"); vb.className = "button-2010 secondary"; vb.textContent = "View"; vb.addEventListener("click", () => openProfile(friend.username));
            const rb = document.createElement("button"); rb.className = "button-2010 danger"; rb.textContent = "Remove"; rb.addEventListener("click", () => removeFriendAction(friend.username));
            row.appendChild(cb); row.appendChild(vb); row.appendChild(rb); friendsBox.appendChild(row);
        }
    }

    function socialRow(user, text) {
        const row = document.createElement("div"); row.className = "player-badge"; row.style.marginBottom = "8px";
        const img = document.createElement("img"); img.className = "avatar"; img.src = user.avatarThumb || DEFAULT_AVATAR; img.alt = "";
        const label = document.createElement("div"); label.className = "player-name"; label.style.flex = "1"; label.textContent = text;
        row.appendChild(img); row.appendChild(label); return row;
    }

    async function respondFriendRequestAction(fromUsername, accept) {
        try { await api("respondFriendRequest", { method: "POST", body: authBody({ fromUsername, accept }) }); await loadSocial(); }
        catch (error) { $("lobby-list-error").textContent = error.message; }
    }

    async function removeFriendAction(targetUsername) {
        try { await api("removeFriend", { method: "POST", body: authBody({ targetUsername }) }); await loadSocial(); }
        catch (error) { $("lobby-list-error").textContent = error.message; }
    }

    async function challengeFriend(targetUsername) {
        try { await api("challenge", { method: "POST", body: authBody({ targetUsername }) }); $("lobby-list-error").textContent = `Challenge sent to ${targetUsername}!`; await loadSocial(); }
        catch (error) { $("lobby-list-error").textContent = error.message; }
    }

    async function respondChallengeAction(fromUsername, accept) {
        try {
            const data = await api("respondChallenge", { method: "POST", body: authBody({ fromUsername, accept }) });
            if (accept && data.lobby) { currentLobbyId = data.lobby.id; localStorage.setItem(CURRENT_LOBBY_KEY, currentLobbyId); showGameScreen(); renderLobby(data.lobby); return; }
            await loadSocial();
        } catch (error) { $("lobby-list-error").textContent = error.message; }
    }

    function bindSearchModEvents() {
        $("search-button").addEventListener("click", runSearch);
        $("search-input").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
        $("mod-back").addEventListener("click", showLobbyScreen);
        $("mod-ban").addEventListener("click", doBan);
        $("mod-unban").addEventListener("click", () => doOwnerAction("moderateUnban"));
        $("mod-unip").addEventListener("click", () => doOwnerAction("moderateRemoveIpBan"));
        $("mod-promote").addEventListener("click", () => setRole("moderator"));
        $("mod-demote").addEventListener("click", () => setRole("user"));
        $("mod-wipe").addEventListener("click", doWipe);
        $("mod-friend").addEventListener("click", modFriendAction);
        $("mod-challenge").addEventListener("click", () => { if (currentModTarget) challengeFriend(currentModTarget.username); });
    }

    async function runSearch() {
        const query = $("search-input").value.trim(); const box = $("search-results"); box.innerHTML = ""; if (!query) return;
        try { $("lobby-list-error").textContent = ""; renderSearchResults((await api("searchUsers", { method: "POST", body: authBody({ query }) })).users || []); }
        catch (error) { handleAuthError(error, "lobby-list-error"); }
    }

    function renderSearchResults(users) {
        const box = $("search-results"); box.innerHTML = "";
        if (!users.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No players found."; box.appendChild(p); return; }
        for (const user of users) {
            const row = document.createElement("div"); row.className = "player-badge"; row.style.marginBottom = "8px";
            const img = document.createElement("img"); img.className = "avatar"; img.src = user.avatarThumb || DEFAULT_AVATAR; img.alt = "";
            const info = document.createElement("div"); info.className = "player-name"; info.style.flex = "1";
            const roleLabel = user.role === "owner" ? " • Owner" : user.role === "moderator" ? " • Mod" : "";
            const banLabel = user.banned ? " • BANNED" : "";
            info.textContent = `${user.displayName} (@${user.username})${roleLabel}${banLabel}`;
            const viewButton = document.createElement("button"); viewButton.className = "button-2010 secondary"; viewButton.textContent = "View";
            viewButton.addEventListener("click", () => openProfile(user.username));
            row.appendChild(img); row.appendChild(info); row.appendChild(viewButton); box.appendChild(row);
        }
    }

    async function openProfile(username) {
        try {
            $("lobby-list-error").textContent = "";
            const data = await api("getUserProfile", { method: "POST", body: authBody({ targetUsername: username }) });
            currentModTarget = data.user; currentModPerms = data.perms; currentModRelation = data.relation;
            renderModScreen(); showScreen("mod-screen");
        } catch (error) { handleAuthError(error, "lobby-list-error"); }
    }

    function addModInfoLine(text) { const p = document.createElement("div"); p.className = "muted"; p.textContent = text; $("mod-info").appendChild(p); }

    function renderModScreen() {
        const user = currentModTarget; const perms = currentModPerms; const rel = currentModRelation;
        $("mod-title").textContent = user.displayName;
        $("mod-avatar").src = user.avatarThumb || DEFAULT_AVATAR;
        const info = $("mod-info"); info.innerHTML = "";
        addModInfoLine(`@${user.username}`);
        addModInfoLine(`Role: ${user.role === "owner" ? "Owner" : user.role === "moderator" ? "Moderator" : "Player"}`);
        if (user.banned) {
            addModInfoLine(user.banned.until === null ? "Status: PERMANENTLY BANNED" : `Status: banned until ${new Date(user.banned.until).toLocaleString()}`);
            if (user.banned.reason) addModInfoLine(`Reason: ${user.banned.reason}`);
            if (user.banned.by) addModInfoLine(`Banned by: ${user.banned.by}`);
        } else { addModInfoLine("Status: active"); }
        if (user.ipBanned) addModInfoLine("IP ban: active (cannot create accounts)");

        const isSelf = user.username === session.username;
        const friendButton = $("mod-friend"); const challengeButton = $("mod-challenge");
        $("mod-friend-actions").classList.toggle("hidden", isSelf);
        friendButton.classList.add("hidden"); challengeButton.classList.add("hidden"); friendButton.disabled = false;
        if (!isSelf) {
            if (rel.isFriend) { friendButton.textContent = "Remove friend"; friendButton.classList.remove("hidden"); challengeButton.classList.remove("hidden"); }
            else if (rel.incomingPending) { friendButton.textContent = "Accept friend request"; friendButton.classList.remove("hidden"); }
            else if (rel.outgoingPending) { friendButton.textContent = "Request pending..."; friendButton.disabled = true; friendButton.classList.remove("hidden"); }
            else { friendButton.textContent = "Add friend"; friendButton.classList.remove("hidden"); }
        }

        const anyPerm = perms.canBan || perms.canUnban || perms.canSetRole || perms.canWipe;
        $("mod-controls").classList.toggle("hidden", !anyPerm); $("mod-error").textContent = "";
        const daysSelect = $("mod-days"); daysSelect.innerHTML = "";
        if (perms.canBan) {
            for (const days of perms.days) {
                const option = document.createElement("option");
                if (days === null) { option.value = "permanent"; option.textContent = "Permanent (owner only)"; }
                else { option.value = String(days); option.textContent = `${days} day${days === 1 ? "" : "s"}`; }
                daysSelect.appendChild(option);
            }
        }
        $("mod-ipban-row").classList.toggle("hidden", !perms.canBan); $("mod-ipban").checked = false; $("mod-reason").value = "";
        $("mod-ban").classList.toggle("hidden", !perms.canBan);
        $("mod-unban").classList.toggle("hidden", !(perms.canUnban && user.banned));
        $("mod-unip").classList.toggle("hidden", !(perms.canUnban && user.ipBanned));
        $("mod-promote").classList.toggle("hidden", !(perms.canSetRole && user.role === "user"));
        $("mod-demote").classList.toggle("hidden", !(perms.canSetRole && user.role === "moderator"));
        $("mod-wipe").classList.toggle("hidden", !perms.canWipe);
    }

    async function modFriendAction() {
        const rel = currentModRelation; const target = currentModTarget.username;
        try {
            $("mod-error").textContent = "";
            if (rel.isFriend) await api("removeFriend", { method: "POST", body: authBody({ targetUsername: target }) });
            else if (rel.incomingPending) await api("respondFriendRequest", { method: "POST", body: authBody({ fromUsername: target, accept: true }) });
            else if (!rel.outgoingPending) await api("sendFriendRequest", { method: "POST", body: authBody({ targetUsername: target }) });
            await openProfile(target);
        } catch (error) { $("mod-error").textContent = error.message; }
    }

    async function doBan() {
        try {
            $("mod-error").textContent = ""; const daysValue = $("mod-days").value;
            await api("moderateBan", { method: "POST", body: authBody({ targetUsername: currentModTarget.username, days: daysValue === "permanent" ? null : Number(daysValue), ipBan: $("mod-ipban").checked, reason: $("mod-reason").value.trim() }) });
            await openProfile(currentModTarget.username);
        } catch (error) { $("mod-error").textContent = error.message; }
    }

    async function doOwnerAction(action) {
        try { $("mod-error").textContent = ""; await api(action, { method: "POST", body: authBody({ targetUsername: currentModTarget.username }) }); await openProfile(currentModTarget.username); }
        catch (error) { $("mod-error").textContent = error.message; }
    }

    async function doWipe() {
        const target = currentModTarget.username;
        if (!confirm(`WIPE ${target}? This permanently deletes ALL accounts on their IP and blocks the IP from the site forever.`)) return;
        if (!confirm("Are you 100% sure? This CANNOT be undone.")) return;
        try {
            $("mod-error").textContent = "";
            const data = await api("moderateWipe", { method: "POST", body: authBody({ targetUsername: target }) });
            showLobbyScreen();
            $("lobby-list-error").textContent = `WIPE complete. Deleted account(s): ${(data.wiped || []).join(", ") || target}. Their IP is permanently 403'd.`;
        } catch (error) { $("mod-error").textContent = error.message; }
    }

    async function setRole(role) {
        try { $("mod-error").textContent = ""; await api("moderateSetRole", { method: "POST", body: authBody({ targetUsername: currentModTarget.username, role }) }); await openProfile(currentModTarget.username); }
        catch (error) { $("mod-error").textContent = error.message; }
    }

    function bindBotEvents() {
        $("bot-start").addEventListener("click", startBotGame);
        $("bot-back").addEventListener("click", showLobbyScreen);
        $("bot-exit").addEventListener("click", showLobbyScreen);
        $("bot-again").addEventListener("click", startBotGame);
    }

    function startBotGame() {
        const playerSymbol = $("bot-symbol").value;
        botGame = { board: Array(9).fill(null), difficulty: $("bot-difficulty").value, playerSymbol, botSymbol: playerSymbol === "X" ? "O" : "X", turn: "X", status: "active" };
        $("bot-setup").classList.add("hidden"); $("bot-game").classList.remove("hidden"); $("bot-again").classList.add("hidden");
        renderBot();
        if (botGame.turn === botGame.botSymbol) setTimeout(botMove, 500);
    }

    function renderBot() {
        const board = $("bot-board"); board.innerHTML = "";
        const canMove = botGame.status === "active" && botGame.turn === botGame.playerSymbol;
        botGame.board.forEach((value, index) => {
            const button = document.createElement("button");
            button.className = "cell" + (value ? ` ${value.toLowerCase()}` : "");
            button.textContent = value || ""; button.disabled = !canMove || value !== null;
            button.addEventListener("click", () => playerBotMove(index)); board.appendChild(button);
        });
        let text = "";
        if (botGame.status === "active") text = botGame.turn === botGame.playerSymbol ? "Your turn!" : "Bot is thinking...";
        else if (botGame.winner === "draw") text = "Draw!";
        else if (botGame.winner === botGame.playerSymbol) text = "You win!";
        else text = "Bot wins!";
        $("bot-status").textContent = text;
        $("bot-again").classList.toggle("hidden", botGame.status === "active");
    }

    function playerBotMove(index) {
        if (!botGame || botGame.status !== "active" || botGame.turn !== botGame.playerSymbol || botGame.board[index] !== null) return;
        placeBotMove(index, botGame.playerSymbol);
        if (botGame.status === "active") setTimeout(botMove, 450);
    }

    function botMove() {
        if (!botGame || botGame.status !== "active") return;
        const move = chooseBotMove(botGame.board, botGame.botSymbol, botGame.difficulty);
        if (move === null || move < 0) return;
        placeBotMove(move, botGame.botSymbol);
    }

    function placeBotMove(index, symbol) {
        botGame.board[index] = symbol;
        const winner = getWinnerLocal(botGame.board);
        if (winner) { botGame.status = "finished"; botGame.winner = winner; }
        else if (botGame.board.every(Boolean)) { botGame.status = "finished"; botGame.winner = "draw"; }
        else { botGame.turn = symbol === "X" ? "O" : "X"; }
        renderBot();
    }

    function getWinnerLocal(board) {
        for (const [a, b, c] of WIN_LINES) { if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]; }
        return null;
    }

    function emptyCells(board) { const c = []; board.forEach((v, i) => { if (v === null) c.push(i); }); return c; }
    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

    function findWinningMove(board, symbol) {
        for (const i of emptyCells(board)) { board[i] = symbol; const w = getWinnerLocal(board); board[i] = null; if (w === symbol) return i; }
        return null;
    }

    function bestMove(board, botSymbol) {
        let bestScore = -Infinity, move = null;
        for (const i of emptyCells(board)) { board[i] = botSymbol; const score = minimax(board, false, botSymbol, 0); board[i] = null; if (score > bestScore) { bestScore = score; move = i; } }
        return move;
    }

    function minimax(board, isBotTurn, botSymbol, depth) {
        const winner = getWinnerLocal(board);
        if (winner === botSymbol) return 10 - depth;
        if (winner) return depth - 10;
        const empties = emptyCells(board);
        if (!empties.length) return 0;
        const humanSymbol = botSymbol === "X" ? "O" : "X";
        if (isBotTurn) { let best = -Infinity; for (const i of empties) { board[i] = botSymbol; best = Math.max(best, minimax(board, false, botSymbol, depth + 1)); board[i] = null; } return best; }
        let best = Infinity; for (const i of empties) { board[i] = humanSymbol; best = Math.min(best, minimax(board, true, botSymbol, depth + 1)); board[i] = null; } return best;
    }

    function chooseBotMove(board, botSymbol, difficulty) {
        const empties = emptyCells(board); if (!empties.length) return null;
        const humanSymbol = botSymbol === "X" ? "O" : "X";
        const winMove = findWinningMove(board, botSymbol);
        const blockMove = findWinningMove(board, humanSymbol);
        if (difficulty === "veryeasy") return pick(empties);
        if (difficulty === "easy") { if (winMove !== null && Math.random() < 0.5) return winMove; if (blockMove !== null && Math.random() < 0.3) return blockMove; return pick(empties); }
        if (difficulty === "medium") { if (winMove !== null) return winMove; if (blockMove !== null) return blockMove; if (board[4] === null) return 4; const corners = [0, 2, 6, 8].filter(i => board[i] === null); if (corners.length) return pick(corners); return pick(empties); }
        if (difficulty === "hard") { if (Math.random() < 0.8) return bestMove(board, botSymbol); if (winMove !== null) return winMove; if (blockMove !== null) return blockMove; return pick(empties); }
        return bestMove(board, botSymbol);
    }

    function startLobbyListPoll() {
        stopLobbyListPoll();
        lobbyListTimer = setInterval(() => { if (document.hidden) return; loadLobbies(); loadSocial(); }, 6000);
    }
    function stopLobbyListPoll() { if (lobbyListTimer) { clearInterval(lobbyListTimer); lobbyListTimer = null; } }
    function startGamePoll() { stopGamePoll(); refreshLobby(); gamePollTimer = setInterval(() => { if (!document.hidden) refreshLobby(); }, 3000); }
    function stopGamePoll() { if (gamePollTimer) { clearInterval(gamePollTimer); gamePollTimer = null; } }
    function stopAllPolling() { stopLobbyListPoll(); stopGamePoll(); }

    async function compressImageFile(file, size = 96, quality = 0.72) {
        const objectUrl = URL.createObjectURL(file);
        try {
            const image = await loadImage(objectUrl);
            const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
            const scale = Math.max(size / image.width, size / image.height);
            const width = image.width * scale, height = image.height * scale;
            ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
            let dataUrl = canvas.toDataURL("image/webp", quality);
            if (!dataUrl.startsWith("data:image/webp")) dataUrl = canvas.toDataURL("image/jpeg", quality);
            if (dataUrl.length > 250000) throw new Error("Image is still too large after compression.");
            return dataUrl;
        } finally { URL.revokeObjectURL(objectUrl); }
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Could not load image.")); image.src = src; });
    }

    async function api(action, { method = "GET", body, params = {} } = {}) {
        const search = new URLSearchParams({ action, ...params });
        const options = { method };
        if (body !== undefined) { options.headers = { "Content-Type": "application/json" }; options.body = JSON.stringify(body); }
        const response = await fetch(`${API_URL}?${search.toString()}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
        return data;
    }
