const LOBBY_PREFIX = "lobby:";
const USER_PREFIX = "user:";
const IPBAN_PREFIX = "ipban:";
const WIPE_PREFIX = "wipe:";
const META_LOBBIES = "meta:public_lobbies";
const META_USERS = "meta:user_index";
const OWNER_USERNAME = "syed";
const WAITING_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGES = 100;
const MOD_DAYS = [1, 2, 3, 4, 5, 7, 14, 30];
const PBKDF2_ITERATIONS = 100000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_FRIEND_REQUESTS = 50;

const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
[0, 3, 6], [1, 4, 7], [2, 5, 8],
[0, 4, 8], [2, 4, 6]
];

export async function onRequest({ request, env }) {
    const kv = env.STORE;
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "";

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
        if (request.method === "GET") {
            if (action === "listLobbies") return json(200, { lobbies: await listPublicLobbies(kv) });
            if (action === "getLobby") {
                const lobby = await readLobby(kv, url.searchParams.get("lobbyId") || "");
                if (!lobby) throw httpError(404, "Lobby not found.");
                return json(200, { lobby: sanitizeLobby(lobby) });
            }
            throw httpError(400, "Unknown action.");
        }

        if (request.method === "POST") {
            const body = await safeParseBody(request);

            if (action === "register") return await register(kv, body, request);
            if (action === "login") return await login(kv, body);
            if (action === "logout") return await logout(kv, body);
            if (action === "updateProfile") return await updateProfile(kv, body);
            if (action === "searchUsers") return await searchUsers(kv, body);
            if (action === "getUserProfile") return await getUserProfile(kv, body);
            if (action === "moderateBan") return await moderateBan(kv, body);
            if (action === "moderateUnban") return await moderateUnban(kv, body);
            if (action === "moderateRemoveIpBan") return await moderateRemoveIpBan(kv, body);
            if (action === "moderateSetRole") return await moderateSetRole(kv, body);
            if (action === "moderateWipe") return await moderateWipe(kv, body);
            if (action === "getSocial") return await getSocial(kv, body);
            if (action === "sendFriendRequest") return await sendFriendRequest(kv, body);
            if (action === "respondFriendRequest") return await respondFriendRequest(kv, body);
            if (action === "removeFriend") return await removeFriend(kv, body);
            if (action === "challenge") return await challengeAction(kv, body);
            if (action === "respondChallenge") return await respondChallenge(kv, body);
            if (action === "createLobby") return await createLobby(kv, body);
            if (action === "joinLobby") return await joinLobby(kv, body);
            if (action === "makeMove") return await makeMove(kv, body);
            if (action === "sendMessage") return await sendMessage(kv, body);
            if (action === "leaveLobby") return await leaveLobby(kv, body);
            if (action === "rematch") return await rematch(kv, body);

            throw httpError(400, "Unknown action.");
        }

        throw httpError(405, "Method not allowed.");
    } catch (error) {
        return json(error.statusCode || 500, { error: error.message || "Server error." });
    }
}

/* ---------- crypto ---------- */

function bytesToHex(buf) {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    return bytes;
}

function randomHex(byteCount) {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

async function hashPassword(password, saltHex) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
                                                key, 256
    );
    return bytesToHex(bits);
}

async function sha256hex(input) {
    const data = new TextEncoder().encode(input);
    return bytesToHex(await crypto.subtle.digest("SHA-256", data));
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

/* ---------- storage ---------- */

async function readRecord(kv, key) {
    const raw = await kv.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function writeRecord(kv, key, value) {
    await kv.put(key, JSON.stringify(value));
}

async function deleteKey(kv, key) {
    await kv.delete(key);
}

async function readUserRecord(kv, username) {
    if (!username) return null;
    return await readRecord(kv, USER_PREFIX + username);
}

async function saveUserRecord(kv, record) {
    await writeRecord(kv, USER_PREFIX + record.username, record);
}

async function readLobby(kv, id) {
    if (!id) return null;
    return await readRecord(kv, LOBBY_PREFIX + id);
}

async function writeLobby(kv, lobby) {
    lobby.updatedAt = Date.now();
    await writeRecord(kv, LOBBY_PREFIX + lobby.id, lobby);
}

async function deleteLobby(kv, id) {
    await deleteKey(kv, LOBBY_PREFIX + id);
    await removeFromLobbyIndex(kv, id);
}

/* ---------- indexes ---------- */

async function readLobbyIndex(kv) {
    const raw = await kv.get(META_LOBBIES);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

async function writeLobbyIndex(kv, index) {
    await kv.put(META_LOBBIES, JSON.stringify(index));
}

async function addToLobbyIndex(kv, entry) {
    const index = await readLobbyIndex(kv);
    index.push(entry);
    await writeLobbyIndex(kv, index);
}

async function removeFromLobbyIndex(kv, lobbyId) {
    const index = await readLobbyIndex(kv);
    const filtered = index.filter(e => e.id !== lobbyId);
    if (filtered.length !== index.length) await writeLobbyIndex(kv, filtered);
}

async function readUserIndex(kv) {
    const raw = await kv.get(META_USERS);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

async function writeUserIndex(kv, index) {
    await kv.put(META_USERS, JSON.stringify(index));
}

async function addToUserIndex(kv, username, displayName) {
    const index = await readUserIndex(kv);
    if (!index.some(e => e.u === username)) {
        index.push({ u: username, d: displayName });
        await writeUserIndex(kv, index);
    }
}

async function removeFromUserIndex(kv, usernames) {
    const index = await readUserIndex(kv);
    const filtered = index.filter(e => !usernames.includes(e.u));
    if (filtered.length !== index.length) await writeUserIndex(kv, filtered);
}

/* ---------- auth helpers ---------- */

function normalizeUsername(input) {
    return String(input || "").trim().toLowerCase();
}

async function hashIp(ip) {
    return await sha256hex("freetictac-ip:" + ip);
}

function getClientIp(request) {
    return request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
}

function normalizeSocialFields(record) {
    if (!record) return record;
    record.friends = Array.isArray(record.friends) ? record.friends : [];
    record.reqIn = Array.isArray(record.reqIn) ? record.reqIn : [];
    record.reqOut = Array.isArray(record.reqOut) ? record.reqOut : [];
    record.chIn = Array.isArray(record.chIn) ? record.chIn : [];
    record.chOut = Array.isArray(record.chOut) ? record.chOut : [];
    return record;
}

function effectiveRole(record) {
    if (record.username === OWNER_USERNAME) return "owner";
    return record.role === "moderator" ? "moderator" : "user";
}

function activeBan(record) {
    if (!record.ban) return null;
    if (record.ban.until === null) return record.ban;
    if (record.ban.until > Date.now()) return record.ban;
    return null;
}

function banMessage(ban) {
    if (ban.until === null) return "This account is permanently banned.";
    return `This account is banned until ${new Date(ban.until).toLocaleString()}.`;
}

async function hasActiveIpBan(kv, record) {
    if (!record.ipHash) return false;
    const rec = await readRecord(kv, IPBAN_PREFIX + record.ipHash);
    if (!rec) return false;
    return rec.until === null || rec.until > Date.now();
}

async function loadAuthenticatedPlayer(kv, body) {
    const username = normalizeUsername(body?.username);
    const sessionToken = String(body?.sessionToken || "");
    if (!username || !sessionToken) throw httpError(401, "You must be logged in.");

    const record = await readUserRecord(kv, username);
    if (!record || record.token !== sessionToken) throw httpError(401, "Session invalid. Please log in again.");

    const ban = activeBan(record);
    if (ban) throw httpError(403, banMessage(ban));

    const profile = record.profile || {};
    return {
        playerId: username, username,
        role: effectiveRole(record),
        displayName: profile.displayName || username,
        avatarThumb: profile.avatarThumb || ""
    };
}

/* ---------- auth actions ---------- */

async function register(kv, body, request) {
    const username = normalizeUsername(body?.username);
    const password = String(body?.password || "");
    const displayName = String(body?.displayName || username).trim().slice(0, 24) || username;
    const avatarThumb = typeof body?.avatarThumb === "string" ? body.avatarThumb.slice(0, 300000) : "";

    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw httpError(400, "Username must be 3-20 characters: letters, numbers, underscores.");
    if (password.length < 6) throw httpError(400, "Password must be at least 6 characters.");

    const ipHash = await hashIp(getClientIp(request));

    const ipRec = await readRecord(kv, IPBAN_PREFIX + ipHash);
    if (ipRec && (ipRec.until === null || ipRec.until > Date.now())) {
        throw httpError(403, "Account creation is blocked on this network.");
    }

    const wipeRec = await readRecord(kv, WIPE_PREFIX + ipHash);
    if (wipeRec) throw httpError(403, "Account creation is permanently blocked on this network.");

    const existing = await readUserRecord(kv, username);
    if (existing) throw httpError(409, "Username is already taken.");

    const salt = randomHex(32);
    const hash = await hashPassword(password, salt);
    const token = crypto.randomUUID();

    const record = {
        username, salt, hash, token,
        profile: { displayName, avatarThumb },
        role: username === OWNER_USERNAME ? "owner" : "user",
        ipHash, ban: null,
        friends: [], reqIn: [], reqOut: [], chIn: [], chOut: [],
        pendingLobby: null, createdAt: Date.now()
    };

    await saveUserRecord(kv, record);
    await addToUserIndex(kv, username, displayName);

    return json(200, { session: { username, token, displayName, avatarThumb, role: effectiveRole(record) } });
}

async function login(kv, body) {
    const username = normalizeUsername(body?.username);
    const password = String(body?.password || "");

    const record = await readUserRecord(kv, username);
    if (!record) throw httpError(401, "Wrong username or password.");

    const candidate = await hashPassword(password, record.salt);
    if (!timingSafeEqual(candidate, record.hash)) throw httpError(401, "Wrong username or password.");

    const ban = activeBan(record);
    if (ban) throw httpError(403, banMessage(ban));

    record.token = crypto.randomUUID();
    await saveUserRecord(kv, record);

    const profile = record.profile || {};
    return json(200, {
        session: { username, token: record.token, displayName: profile.displayName || username, avatarThumb: profile.avatarThumb || "", role: effectiveRole(record) }
    });
}

async function logout(kv, body) {
    const username = normalizeUsername(body?.username);
    const record = await readUserRecord(kv, username);
    if (record && record.token === String(body?.sessionToken || "")) {
        record.token = null;
        await saveUserRecord(kv, record);
    }
    return json(200, { ok: true });
}

async function updateProfile(kv, body) {
    const username = normalizeUsername(body?.username);
    const sessionToken = String(body?.sessionToken || "");
    const displayName = String(body?.displayName || username).trim().slice(0, 24) || username;
    const avatarThumb = typeof body?.avatarThumb === "string" ? body.avatarThumb.slice(0, 300000) : "";

    const record = await readUserRecord(kv, username);
    if (!record || record.token !== sessionToken) throw httpError(401, "Session invalid. Please log in again.");

    const ban = activeBan(record);
    if (ban) throw httpError(403, banMessage(ban));

    record.profile = { displayName, avatarThumb };
    await saveUserRecord(kv, record);

    const index = await readUserIndex(kv);
    const entry = index.find(e => e.u === username);
    if (entry) { entry.d = displayName; await writeUserIndex(kv, index); }

    return json(200, { session: { username, token: record.token, displayName, avatarThumb, role: effectiveRole(record) } });
}

/* ---------- search + moderation ---------- */

async function searchUsers(kv, body) {
    await loadAuthenticatedPlayer(kv, body);
    const query = String(body?.query || "").trim().toLowerCase();
    if (!query) return json(200, { users: [] });

    const index = await readUserIndex(kv);
    const matches = index.filter(e => e.u.includes(query) || e.d.toLowerCase().includes(query)).slice(0, 20);

    const users = [];
    for (const match of matches) {
        const record = await readUserRecord(kv, match.u);
        if (!record) continue;
        const profile = record.profile || {};
        users.push({
            username: record.username,
            displayName: profile.displayName || record.username,
            avatarThumb: profile.avatarThumb || "",
            role: effectiveRole(record),
                   banned: Boolean(activeBan(record))
        });
    }
    return json(200, { users });
}

function moderationPermissions(actor, target) {
    const perms = { canBan: false, canUnban: false, canSetRole: false, canWipe: false, days: [] };
    if (!actor || !target || actor.username === target.username) return perms;

    if (actor.role === "owner") {
        perms.canBan = true; perms.canUnban = true;
        perms.canSetRole = target.role !== "owner";
        perms.canWipe = target.role !== "owner";
        perms.days = [...MOD_DAYS, null];
    } else if (actor.role === "moderator" && target.role === "user") {
        perms.canBan = true; perms.days = [...MOD_DAYS];
    }
    return perms;
}

async function getUserProfile(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const targetUsername = normalizeUsername(body?.targetUsername);

    const record = await readUserRecord(kv, targetUsername);
    if (!record) throw httpError(404, "Player not found.");

    const actorRecord = normalizeSocialFields(await readUserRecord(kv, actor.username));
    const profile = record.profile || {};
    const ban = activeBan(record);
    const targetRole = effectiveRole(record);

    return json(200, {
        user: {
            username: record.username,
            displayName: profile.displayName || record.username,
            avatarThumb: profile.avatarThumb || "",
            role: targetRole,
            banned: ban ? { until: ban.until, by: ban.by || "", reason: ban.reason || "" } : null,
            ipBanned: await hasActiveIpBan(kv, record),
                createdAt: record.createdAt || null
        },
        perms: moderationPermissions(actor, { username: record.username, role: targetRole }),
                relation: {
                    isFriend: actorRecord.friends.includes(record.username),
                outgoingPending: actorRecord.reqOut.includes(record.username),
                incomingPending: actorRecord.reqIn.some(r => (typeof r === "string" ? r : r.from) === record.username)
                }
    });
}

async function moderateBan(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const targetUsername = normalizeUsername(body?.targetUsername);
    const record = await readUserRecord(kv, targetUsername);
    if (!record) throw httpError(404, "Player not found.");

    const perms = moderationPermissions(actor, { username: record.username, role: effectiveRole(record) });
    if (!perms.canBan) throw httpError(403, "You are not allowed to ban this player.");

    let until;
    if (body.days === null || body.days === "permanent") {
        if (actor.role !== "owner") throw httpError(403, "Only the owner can ban permanently.");
        until = null;
    } else {
        const days = Number(body.days);
        if (!perms.days.includes(days)) throw httpError(400, "Invalid ban duration.");
        until = Date.now() + days * 86400000;
    }

    const ipBan = Boolean(body.ipBan);
    record.ban = { until, by: actor.username, reason: String(body?.reason || "").slice(0, 140), ipBanned: ipBan, at: Date.now() };
    record.token = null;
    await saveUserRecord(kv, record);

    if (ipBan && record.ipHash) {
        await writeRecord(kv, IPBAN_PREFIX + record.ipHash, { until, by: actor.username, at: Date.now() });
    }
    return json(200, { ok: true });
}

async function moderateUnban(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    if (actor.role !== "owner") throw httpError(403, "Only the owner can unban.");
    const record = await readUserRecord(kv, normalizeUsername(body?.targetUsername));
    if (!record) throw httpError(404, "Player not found.");
    record.ban = null;
    await saveUserRecord(kv, record);
    return json(200, { ok: true });
}

async function moderateRemoveIpBan(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    if (actor.role !== "owner") throw httpError(403, "Only the owner can remove IP bans.");
    const record = await readUserRecord(kv, normalizeUsername(body?.targetUsername));
    if (!record) throw httpError(404, "Player not found.");
    if (record.ipHash) await deleteKey(kv, IPBAN_PREFIX + record.ipHash);
    return json(200, { ok: true });
}

async function moderateSetRole(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    if (actor.role !== "owner") throw httpError(403, "Only the owner can change roles.");
    const record = await readUserRecord(kv, normalizeUsername(body?.targetUsername));
    if (!record) throw httpError(404, "Player not found.");
    if (record.username === OWNER_USERNAME) throw httpError(403, "The owner role cannot be changed.");
    record.role = body?.role === "moderator" ? "moderator" : "user";
    await saveUserRecord(kv, record);
    return json(200, { ok: true });
}

async function moderateWipe(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    if (actor.role !== "owner") throw httpError(403, "Only the owner can wipe.");

    const targetUsername = normalizeUsername(body?.targetUsername);
    const record = await readUserRecord(kv, targetUsername);
    if (!record) throw httpError(404, "Player not found.");
    if (record.username === OWNER_USERNAME) throw httpError(403, "Cannot wipe the owner.");
    if (!record.ipHash) throw httpError(400, "This account has no stored IP hash.");

    const userIndex = await readUserIndex(kv);
    const wipedUsernames = [];

    for (const entry of userIndex) {
        const rec = await readUserRecord(kv, entry.u);
        if (!rec) continue;
        if (rec.ipHash === record.ipHash && rec.username !== OWNER_USERNAME) {
            wipedUsernames.push(rec.username);
            await deleteKey(kv, USER_PREFIX + rec.username);
        }
    }

    const lobbyIndex = await readLobbyIndex(kv);
    for (const entry of lobbyIndex) {
        const lobby = await readLobby(kv, entry.id);
        if (lobby && (lobby.players || []).some(p => wipedUsernames.includes(p.playerId))) {
            await deleteKey(kv, LOBBY_PREFIX + lobby.id);
        }
    }

    await removeFromUserIndex(kv, wipedUsernames);
    await writeLobbyIndex(kv, []);

    await writeRecord(kv, WIPE_PREFIX + record.ipHash, { by: actor.username, at: Date.now(), wiped: wipedUsernames });
    await writeRecord(kv, IPBAN_PREFIX + record.ipHash, { until: null, by: actor.username, at: Date.now() });

    return json(200, { wiped: wipedUsernames });
}

/* ---------- friends + challenges ---------- */

async function publicProfileOf(kv, username) {
    const record = await readUserRecord(kv, username);
    if (!record) return null;
    const profile = record.profile || {};
    return { username, displayName: profile.displayName || username, avatarThumb: profile.avatarThumb || "" };
}

async function getSocial(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const record = normalizeSocialFields(await readUserRecord(kv, actor.username));

    const now = Date.now();
    const before = record.chIn.length;
    record.chIn = record.chIn.filter(c => now - (c.at || 0) < CHALLENGE_TTL_MS);
    if (record.chIn.length !== before) await saveUserRecord(kv, record);

    const friends = [];
    for (const u of record.friends) { const p = await publicProfileOf(kv, u); if (p) friends.push(p); }

    const requestsIn = [];
    for (const req of record.reqIn) { const from = typeof req === "string" ? req : req.from; const p = await publicProfileOf(kv, from); if (p) requestsIn.push(p); }

    const challengesIn = [];
    for (const ch of record.chIn) { const from = typeof ch === "string" ? ch : ch.from; const p = await publicProfileOf(kv, from); if (p) challengesIn.push(p); }

    let pendingLobby = null;
    if (record.pendingLobby) {
        const lobby = await readLobby(kv, record.pendingLobby);
        if (lobby && lobby.status !== "finished") { pendingLobby = record.pendingLobby; }
        else { record.pendingLobby = null; await saveUserRecord(kv, record); }
    }

    return json(200, { friends, requestsIn, challengesIn, pendingLobby });
}

async function sendFriendRequest(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const targetUsername = normalizeUsername(body?.targetUsername);
    if (!targetUsername || targetUsername === actor.username) throw httpError(400, "Invalid player.");

    const actorRecord = normalizeSocialFields(await readUserRecord(kv, actor.username));
    const targetRecord = normalizeSocialFields(await readUserRecord(kv, targetUsername));
    if (!targetRecord) throw httpError(404, "Player not found.");
    if (actorRecord.friends.includes(targetUsername)) throw httpError(400, "You are already friends.");
    if (actorRecord.reqOut.includes(targetUsername)) throw httpError(400, "Request already sent.");

    if (targetRecord.reqOut.includes(actor.username)) {
        targetRecord.reqOut = targetRecord.reqOut.filter(u => u !== actor.username);
        actorRecord.reqIn = actorRecord.reqIn.filter(r => (typeof r === "string" ? r : r.from) !== targetUsername);
        if (!actorRecord.friends.includes(targetUsername)) actorRecord.friends.push(targetUsername);
        if (!targetRecord.friends.includes(actor.username)) targetRecord.friends.push(actor.username);
        await saveUserRecord(kv, actorRecord);
        await saveUserRecord(kv, targetRecord);
        return json(200, { accepted: true });
    }

    if (actorRecord.reqOut.length >= MAX_FRIEND_REQUESTS) throw httpError(400, "Too many pending friend requests.");

    actorRecord.reqOut.push(targetUsername);
    targetRecord.reqIn.push({ from: actor.username, at: Date.now() });
    await saveUserRecord(kv, actorRecord);
    await saveUserRecord(kv, targetRecord);
    return json(200, { accepted: false });
}

async function respondFriendRequest(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const fromUsername = normalizeUsername(body?.fromUsername);
    const accept = Boolean(body?.accept);

    const actorRecord = normalizeSocialFields(await readUserRecord(kv, actor.username));
    if (!actorRecord.reqIn.some(r => (typeof r === "string" ? r : r.from) === fromUsername)) throw httpError(404, "Friend request not found.");

    actorRecord.reqIn = actorRecord.reqIn.filter(r => (typeof r === "string" ? r : r.from) !== fromUsername);

    const fromRecord = normalizeSocialFields(await readUserRecord(kv, fromUsername));
    if (fromRecord) {
        fromRecord.reqOut = fromRecord.reqOut.filter(u => u !== actor.username);
        if (accept) {
            if (!actorRecord.friends.includes(fromUsername)) actorRecord.friends.push(fromUsername);
            if (!fromRecord.friends.includes(actor.username)) fromRecord.friends.push(actor.username);
        }
        await saveUserRecord(kv, fromRecord);
    }
    await saveUserRecord(kv, actorRecord);
    return json(200, { ok: true });
}

async function removeFriend(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const targetUsername = normalizeUsername(body?.targetUsername);

    const actorRecord = normalizeSocialFields(await readUserRecord(kv, actor.username));
    actorRecord.friends = actorRecord.friends.filter(u => u !== targetUsername);
    await saveUserRecord(kv, actorRecord);

    const targetRecord = normalizeSocialFields(await readUserRecord(kv, targetUsername));
    if (targetRecord) {
        targetRecord.friends = targetRecord.friends.filter(u => u !== actor.username);
        await saveUserRecord(kv, targetRecord);
    }
    return json(200, { ok: true });
}

async function challengeAction(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const targetUsername = normalizeUsername(body?.targetUsername);

    const actorRecord = normalizeSocialFields(await readUserRecord(kv, actor.username));
    if (!actorRecord.friends.includes(targetUsername)) throw httpError(403, "You can only challenge friends.");

    const targetRecord = normalizeSocialFields(await readUserRecord(kv, targetUsername));
    if (!targetRecord) throw httpError(404, "Player not found.");

    const now = Date.now();
    targetRecord.chIn = targetRecord.chIn.filter(c => (typeof c === "string" ? c : c.from) !== actor.username);
    targetRecord.chIn.push({ from: actor.username, at: now });
    if (!actorRecord.chOut.includes(targetUsername)) actorRecord.chOut.push(targetUsername);

    await saveUserRecord(kv, actorRecord);
    await saveUserRecord(kv, targetRecord);
    return json(200, { ok: true });
}

async function respondChallenge(kv, body) {
    const actor = await loadAuthenticatedPlayer(kv, body);
    const fromUsername = normalizeUsername(body?.fromUsername);
    const accept = Boolean(body?.accept);

    const actorRecord = normalizeSocialFields(await readUserRecord(kv, actor.username));
    if (!actorRecord.chIn.some(c => (typeof c === "string" ? c : c.from) === fromUsername)) throw httpError(404, "Challenge not found.");

    actorRecord.chIn = actorRecord.chIn.filter(c => (typeof c === "string" ? c : c.from) !== fromUsername);

    const fromRecord = normalizeSocialFields(await readUserRecord(kv, fromUsername));
    if (fromRecord) fromRecord.chOut = fromRecord.chOut.filter(u => u !== actor.username);

    if (!accept) {
        await saveUserRecord(kv, actorRecord);
        if (fromRecord) await saveUserRecord(kv, fromRecord);
        return json(200, { ok: true });
    }

    if (!fromRecord) throw httpError(404, "Player not found.");

    const now = Date.now();
    const challengerProfile = fromRecord.profile || {};
    const lobbyId = "lobby_" + crypto.randomUUID().slice(0, 12);

    const lobby = {
        id: lobbyId, public: false, status: "active", createdAt: now, updatedAt: now,
        players: [
            { playerId: fromUsername, username: fromUsername, displayName: challengerProfile.displayName || fromUsername, avatarThumb: challengerProfile.avatarThumb || "", symbol: "X", joinedAt: now },
            { playerId: actor.username, username: actor.username, displayName: actor.displayName, avatarThumb: actor.avatarThumb, symbol: "O", joinedAt: now }
        ],
        game: { board: Array(9).fill(null), currentTurn: "X", status: "active", winner: null },
        messages: [systemMessage("Challenge accepted. Game started!")]
    };

    await writeLobby(kv, lobby);
    actorRecord.pendingLobby = lobbyId;
    fromRecord.pendingLobby = lobbyId;
    await saveUserRecord(kv, actorRecord);
    await saveUserRecord(kv, fromRecord);
    return json(200, { lobby: sanitizeLobby(lobby) });
}

/* ---------- lobby / game ---------- */

async function createLobby(kv, body) {
    const player = await loadAuthenticatedPlayer(kv, body);
    const id = "lobby_" + crypto.randomUUID().slice(0, 12);
    const now = Date.now();

    const lobby = {
        id, public: body?.public !== false, status: "waiting", createdAt: now, updatedAt: now,
        players: [{ playerId: player.playerId, username: player.username, displayName: player.displayName, avatarThumb: player.avatarThumb, symbol: "X", joinedAt: now }],
        game: emptyGame(),
        messages: [systemMessage("Lobby created. Waiting for another player...")]
    };

    await writeLobby(kv, lobby);

    if (lobby.public) {
        await addToLobbyIndex(kv, { id, status: "waiting", playerCount: 1, hostName: player.displayName, createdAt: now, updatedAt: now });
    }

    return json(200, { lobbyId: id, lobby: sanitizeLobby(lobby) });
}

async function joinLobby(kv, body) {
    const lobbyId = String(body?.lobbyId || "");
    const player = await loadAuthenticatedPlayer(kv, body);
    const lobby = await readLobby(kv, lobbyId);

    if (!lobby) throw httpError(404, "Lobby not found.");
    if (lobby.status !== "waiting") throw httpError(400, "This lobby is not waiting.");
    if (lobby.players.length >= 2) throw httpError(400, "This lobby is full.");

    if (lobby.players.some(p => p.playerId === player.playerId)) return json(200, { lobby: sanitizeLobby(lobby) });

    lobby.players.push({ playerId: player.playerId, username: player.username, displayName: player.displayName, avatarThumb: player.avatarThumb, symbol: "O", joinedAt: Date.now() });
    lobby.status = "active";
    lobby.game.status = "active";
    lobby.game.currentTurn = "X";
    lobby.messages.push(systemMessage(`${player.displayName} joined. Game started.`));
    lobby.messages = lobby.messages.slice(-MAX_MESSAGES);

    await writeLobby(kv, lobby);
    await removeFromLobbyIndex(kv, lobbyId);

    return json(200, { lobby: sanitizeLobby(lobby) });
}

async function makeMove(kv, body) {
    const lobbyId = String(body?.lobbyId || "");
    const cell = Number(body?.cell);
    const player = await loadAuthenticatedPlayer(kv, body);

    if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw httpError(400, "Invalid cell.");

    const lobby = await readLobby(kv, lobbyId);
    if (!lobby) throw httpError(404, "Lobby not found.");
    if (lobby.status !== "active" || lobby.game.status !== "active") throw httpError(400, "This game is not active.");

    const lp = lobby.players.find(p => p.playerId === player.playerId);
    if (!lp) throw httpError(403, "You are not in this lobby.");
    if (lobby.game.currentTurn !== lp.symbol) throw httpError(400, "It is not your turn.");
    if (lobby.game.board[cell] !== null) throw httpError(400, "That cell is already taken.");

    lobby.game.board[cell] = lp.symbol;
    const winner = getWinner(lobby.game.board);

    if (winner) {
        lobby.game.status = "finished"; lobby.game.winner = winner; lobby.status = "finished";
        lobby.messages.push(systemMessage(`${lp.displayName} wins!`));
    } else if (lobby.game.board.every(Boolean)) {
        lobby.game.status = "finished"; lobby.game.winner = "draw"; lobby.status = "finished";
        lobby.messages.push(systemMessage("Draw game."));
    } else {
        lobby.game.currentTurn = lp.symbol === "X" ? "O" : "X";
    }

    lobby.messages = lobby.messages.slice(-MAX_MESSAGES);
    await writeLobby(kv, lobby);
    return json(200, { lobby: sanitizeLobby(lobby) });
}

async function sendMessage(kv, body) {
    const lobbyId = String(body?.lobbyId || "");
    const rawText = String(body?.text || "").trim().slice(0, 200);
    const player = await loadAuthenticatedPlayer(kv, body);

    if (!rawText) throw httpError(400, "Message cannot be empty.");

    const lobby = await readLobby(kv, lobbyId);
    if (!lobby) throw httpError(404, "Lobby not found.");
    if (!lobby.players.some(p => p.playerId === player.playerId)) throw httpError(403, "You can only chat in lobbies you joined.");

    lobby.messages.push({
        id: crypto.randomUUID(), senderId: player.playerId, username: player.username,
                        displayName: player.displayName, avatarThumb: player.avatarThumb,
                        text: filterChat(rawText), createdAt: Date.now()
    });
    lobby.messages = lobby.messages.slice(-MAX_MESSAGES);

    await writeLobby(kv, lobby);
    return json(200, { lobby: sanitizeLobby(lobby) });
}

async function leaveLobby(kv, body) {
    const lobbyId = String(body?.lobbyId || "");
    const player = await loadAuthenticatedPlayer(kv, body);

    const lobby = await readLobby(kv, lobbyId);
    if (!lobby) return json(200, { deleted: true });

    const lp = lobby.players.find(p => p.playerId === player.playerId);
    if (!lp) return json(200, { deleted: true });

    if (lobby.players.length <= 1) {
        await deleteLobby(kv, lobby.id);
        return json(200, { deleted: true });
    }

    const other = lobby.players.find(p => p.playerId !== player.playerId);
    lobby.status = "finished"; lobby.game.status = "finished";
    lobby.game.winner = other?.symbol || "draw";
    lobby.messages.push(systemMessage(`${lp.displayName} left. ${other?.displayName || "The other player"} wins.`));
    lobby.messages = lobby.messages.slice(-MAX_MESSAGES);

    await writeLobby(kv, lobby);
    await removeFromLobbyIndex(kv, lobbyId);
    return json(200, { lobby: sanitizeLobby(lobby) });
}

async function rematch(kv, body) {
    const lobbyId = String(body?.lobbyId || "");
    const player = await loadAuthenticatedPlayer(kv, body);

    const lobby = await readLobby(kv, lobbyId);
    if (!lobby) throw httpError(404, "Lobby not found.");
    if (lobby.status !== "finished" || lobby.game.status !== "finished") throw httpError(400, "The game is not finished yet.");
    if (!lobby.players.some(p => p.playerId === player.playerId)) throw httpError(403, "You are not in this lobby.");

    if (!Array.isArray(lobby.rematch)) lobby.rematch = [];
    if (!lobby.rematch.includes(player.playerId)) {
        lobby.rematch.push(player.playerId);
        lobby.messages.push(systemMessage(`${player.displayName} wants a rematch.`));
    }

    if (lobby.players.every(p => lobby.rematch.includes(p.playerId))) {
        for (const p of lobby.players) p.symbol = p.symbol === "X" ? "O" : "X";
        lobby.game = emptyGame(); lobby.game.status = "active";
        lobby.status = "active"; lobby.rematch = [];
        lobby.messages.push(systemMessage("Rematch started! Symbols swapped."));
    }

    lobby.messages = lobby.messages.slice(-MAX_MESSAGES);
    await writeLobby(kv, lobby);
    return json(200, { lobby: sanitizeLobby(lobby) });
}

async function listPublicLobbies(kv) {
    let index = await readLobbyIndex(kv);
    const now = Date.now();

    const before = index.length;
    index = index.filter(e => now - (e.updatedAt || e.createdAt || 0) < WAITING_TTL_MS);
    if (index.length !== before) await writeLobbyIndex(kv, index);

    index.sort((a, b) => b.createdAt - a.createdAt);
    return index;
}

/* ---------- shared helpers ---------- */

function sanitizeLobby(lobby) {
    return { ...lobby, players: lobby.players.map(p => ({ ...p })), messages: lobby.messages.map(m => ({ ...m })) };
}

function emptyGame() {
    return { board: Array(9).fill(null), currentTurn: "X", status: "waiting", winner: null };
}

function getWinner(board) {
    for (const [a, b, c] of WIN_LINES) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return null;
}

function systemMessage(text) {
    return { id: crypto.randomUUID(), senderId: "system", username: "system", displayName: "System", avatarThumb: "", text, createdAt: Date.now() };
}

async function safeParseBody(request) {
    try { return await request.json(); } catch { throw httpError(400, "Invalid JSON body."); }
}

function httpError(statusCode, message) {
    const e = new Error(message); e.statusCode = statusCode; return e;
}

function json(statusCode, body) {
    return new Response(JSON.stringify(body), {
        status: statusCode,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
}

function corsHeaders() {
    return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
}

/* ---------- chat filter ---------- */

function filterChat(rawText) {
    const dict = getFilterDictionary();
    let clean = String(rawText || "").trim().slice(0, 200);
    const normalized = normalizeFilterText(clean);

    for (const severe of dict.severe) {
        const find = typeof severe === "string" ? severe : severe?.find;
        if (!find) continue;
        if (normalizeFilterText(find) && normalized.includes(normalizeFilterText(find))) return dict.severeFallback;
        if (buildFilterRegex(find).test(clean)) return dict.severeFallback;
    }

    for (const item of dict.replacements) {
        if (!item?.find || typeof item.replace !== "string") continue;
        clean = clean.replace(buildFilterRegex(item.find), item.replace);
    }
    return clean;
}

function getFilterDictionary() {
    const fallback = {
        replacements: [
            { find: "fuck", replace: "fabric" }, { find: "shit", replace: "sugar" },
            { find: "bitch", replace: "biscuit" }, { find: "asshole", replace: "apple" },
            { find: "damn", replace: "dang" }
        ],
        severe: [], severeFallback: "✨ message turned into bubbles ✨"
    };
    return fallback;
}

function normalizeFilterText(input) {
    return String(input || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[@4]/g, "a").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/0/g, "o")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function buildFilterRegex(find) {
    const chars = String(find).toLowerCase().split("");
    const pattern = chars.map((ch, i) => {
        const v = { a: "a@4", e: "e3", i: "i1!|", o: "o0", s: "s5$", t: "t7", b: "b8", g: "g9", z: "z2" }[ch] || ch;
        const cls = "[" + v.split("").map(c => "]-^\\".includes(c) ? "\\" + c : c).join("") + "]";
        return cls + (i < chars.length - 1 ? "[\\W_]*" : "");
    }).join("");
    return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "gi");
}
