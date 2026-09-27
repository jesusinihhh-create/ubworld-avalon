const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
//Read settings
const config = JSON.parse(fs.readFileSync("./config/server-settings.json"));

// Privileged words are supplied by the operator at runtime. The archive
// contained real-looking values, so the fork intentionally ships with no
// usable admin credentials in source control.
function hashedEnv(name) {
        const value = process.env[name];
        return value
                ? crypto.createHash("sha256").update(value).digest("hex")
                : "";
}

function hashedEnvList(name) {
        return (process.env[name] || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
                .map((value) =>
                        crypto.createHash("sha256").update(value).digest("hex"),
                );
}

config.godword = hashedEnv("BONZI_GODWORD");
config.adminword = hashedEnv("BONZI_ADMINWORD");
config.jimmode = hashedEnv("BONZI_JIMMODE");
config.maxmode = hashedEnv("BONZI_MAXMODE");
config.kingwords = hashedEnvList("BONZI_KINGWORDS");
config.lowkingwords = hashedEnvList("BONZI_LOW_KINGWORDS");
const jokes = JSON.parse(fs.readFileSync("./config/jokes.json"));
const facts = JSON.parse(fs.readFileSync("./config/facts.json"));
const copypastas = JSON.parse(fs.readFileSync("./config/copypastas.json"));

function activateGodmode(user, param) {
        param = crypto.createHash("sha256").update(param).digest("hex");
        if (param == config.godword) {
                setRoleLevel(user, 5, true);
                recordRoyalLog(user, "became", null, "Pope");
                user.socket.emit("update_self", {
                        level: 5,
                        roomowner: user.room.ownerID == user.public.guid,
                });
        }
}

function setRoleLevel(user, level, persist = false) {
        user.level = level;
        user.public.role =
                level >= 4 ? "pope" : level === 3 ? "high-king" : level === 2 ? "low-king" : "";
        if (persist && user.setPermanentRole) user.setPermanentRole(level);
        if (user.room) user.room.emit("update", user.public);
}

function roleLabel(level) {
	return level >= 4
		? "Pope"
		: level === 3
			? "High King"
			: level === 2
				? "Low King"
				: "User";
}

function recordRoyalLog(actor, action, target, targetRole, targetName) {
	if (!actor.room || !Array.isArray(actor.room.royalLog)) return;
	const entry = {
		timestamp: Date.now(),
		actor: actor.public.name,
		actorRole: roleLabel(actor.level),
		action,
		target: targetName || (target ? target.public.name : ""),
		targetRole: targetRole || "",
	};
	actor.room.royalLog.push(entry);
	if (actor.room.royalLog.length > 50) actor.room.royalLog.shift();
	actor.room.emit("royal_log", entry);
}

const serverStartedAt = Date.now();
const auditTrail = [];
const snapshotDirectory = path.join(process.cwd(), "data", "snapshots");

function escapeHtml(value) {
        return String(value == null ? "" : value)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
}

function addAuditEntry(actor, action, details = "") {
        const entry = {
                timestamp: new Date().toISOString(),
                actor: actor && actor.public ? actor.public.name : "SYSTEM",
                actorRole: actor ? roleLabel(actor.level) : "SYSTEM",
                action,
                details: String(details || ""),
        };
        auditTrail.push(entry);
        if (auditTrail.length > 100) auditTrail.shift();
        return entry;
}

function onlineUserCount() {
        return Object.values(module.exports.rooms || {}).reduce(
                (count, currentRoom) =>
                        count + Object.keys(currentRoom.users).length,
                0,
        );
}

function serverStatus() {
        const roomList = Object.values(module.exports.rooms || {});
        return {
                uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
                pid: process.pid,
                rooms: roomList.length,
                users: onlineUserCount(),
                messages: roomList.reduce(
                        (total, currentRoom) => total + currentRoom.msgsSent,
                        0,
                ),
                commands: roomList.reduce(
                        (total, currentRoom) => total + currentRoom.cmdsSent,
                        0,
                ),
                sanitizing: module.exports.sanitizeEnabled !== false,
                snapshots: fs.existsSync(snapshotDirectory)
                        ? fs
                                  .readdirSync(snapshotDirectory)
                                  .filter((file) => file.endsWith(".json"))
                                  .length
                        : 0,
        };
}

function showOperationWindow(user, title, html) {
        user.socket.emit("window", {
                title,
                html: `<div class="overpowered-window">${html}</div>`,
        });
}

function databaseSnapshot(user) {
        fs.mkdirSync(snapshotDirectory, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `bonziworld-${timestamp}.json`;
        const snapshot = {
                createdAt: new Date().toISOString(),
                createdBy: user.public.name,
                status: serverStatus(),
                rooms: Object.values(module.exports.rooms || {}).map(
                        (currentRoom) => ({
                                name: currentRoom.name,
                                private: currentRoom.private,
                                ownerID: currentRoom.ownerID,
                                reg: currentRoom.reg,
                                msgsSent: currentRoom.msgsSent,
                                cmdsSent: currentRoom.cmdsSent,
                                loginCount: currentRoom.loginCount,
                                byoutube: currentRoom.byoutube,
                                royalLog: currentRoom.royalLog,
                                users: Object.values(currentRoom.users).map(
                                        (currentUser) => ({
                                                ...currentUser.public,
                                                level: currentUser.level,
                                                sanitizing:
                                                        currentUser.sanitize !==
                                                        false,
                                        }),
                                ),
                        }),
                ),
                auditTrail: auditTrail.slice(-100),
        };
        fs.writeFileSync(
                path.join(snapshotDirectory, filename),
                JSON.stringify(snapshot, null, 2) + "\n",
                "utf8",
        );
        addAuditEntry(user, "created database snapshot", filename);
        showOperationWindow(
                user,
                "DATABASE SNAPSHOT",
                `<p>Snapshot created successfully.</p><p><strong>${escapeHtml(filename)}</strong></p><p>Stored in the server's data/snapshots directory.</p>`,
        );
}

function resetDatabase(user) {
        const rooms = module.exports.rooms || {};
        Object.values(rooms).forEach((currentRoom) => {
                currentRoom.reg = 0;
                currentRoom.msgsSent = 0;
                currentRoom.cmdsSent = 0;
                currentRoom.loginCount = 0;
                currentRoom.royalLog = [];
                currentRoom.byoutube = { videoId: "", locked: false };
                currentRoom.emit("royal_log_reset");
        });
        Object.keys(rooms).forEach((roomName) => {
                if (
                        rooms[roomName].private &&
                        Object.keys(rooms[roomName].users).length === 0
                ) {
                        delete rooms[roomName];
                }
        });
        auditTrail.length = 0;
        addAuditEntry(
                user,
                "reset database",
                "cleared transient room state and audit history",
        );
        showOperationWindow(
                user,
                "DATABASE RESET",
                "<p>The in-memory room database was reset.</p><p>Room counters, room activity logs, video state, and the audit history were cleared. Connected users were kept online.</p>",
        );
}

function restartServer(user) {
        addAuditEntry(user, "requested server restart");
        Object.values(module.exports.rooms || {}).forEach((currentRoom) => {
                Object.values(currentRoom.users).forEach((currentUser) => {
                        currentUser.socket.emit("restart");
                });
        });
        setImmediate(() => process.exit(0));
}

function changeKingRank(actor, param, nextLevel) {
        const target = find(param);
        if (
                !target ||
                target.level >= actor.level ||
                nextLevel > actor.level
        ) {
                return;
        }
        setRoleLevel(target, nextLevel, true);
        target.socket.emit("update_self", {
                level: target.level,
                roomowner: target.room.ownerID == target.public.guid,
        });
	recordRoyalLog(actor, "promoted", target, roleLabel(nextLevel));
}

function demoteUser(actor, param) {
        const target = find(param);
        if (
                !target ||
                target === actor ||
                (target.level >= actor.level && actor.level < 5)
        )
                return;
        // Room owners keep their owner permission even after demotion.
        setRoleLevel(
                target,
                target.room.ownerID == target.public.guid ? 1 : 0,
                true,
        );
        target.socket.emit("update_self", {
                level: target.level,
                roomowner: target.room.ownerID == target.public.guid,
        });
	recordRoyalLog(actor, "demoted", target, roleLabel(target.level));
}

function forceMessage(actor, param) {
	if (!param.includes(" ")) return;
	const target = param.substring(0, param.indexOf(" "));
	const message = param.substring(param.indexOf(" ") + 1).trim();
	const targetUser = find(target);
	if (
		!targetUser ||
		targetUser.room !== actor.room ||
		message.length === 0 ||
		message.length > config.maxmessage
	)
		return;

	const text = markup(message);
	actor.room.emit("talk", {
		guid: targetUser.public.guid,
		text: text.mtext,
		say: text.rtext,
	});
	actor.room.msgsSent++;
	recordRoyalLog(actor, "used force-message on", targetUser);
}

function byoutube(user, param) {
	const requestedValue = param.trim().split(/\s+/)[0];
	const action = requestedValue.toLowerCase();
	const roomState = user.room.byoutube;
	if (!roomState) return;

	if (action === "lock") {
		roomState.locked = true;
		user.room.emit("byoutube", roomState);
		return;
	}

	if (action === "unlock") {
		if (user.level < 3) return;
		roomState.locked = false;
		user.room.emit("byoutube", roomState);
		return;
	}

	if (roomState.locked && user.level < 3) return;

	if (action === "stop") {
		roomState.videoId = "";
		user.room.emit("byoutube", roomState);
		return;
	}

	if (!/^[A-Za-z0-9_-]{11}$/.test(requestedValue)) return;
	roomState.videoId = requestedValue;
	user.room.emit("byoutube", roomState);
}

module.exports.ccblacklist = [];

function ipToInt(ip) {
        let ipInt = BigInt(0);
        if (ip.startsWith(":")) ip = 0 + ip;
        else if (ip.endsWith(":")) ip = ip + 0;
        ip = ip.split(":");
        let index = ip.indexOf("");
        ip.splice(ip.indexOf(""), 1);
        while (ip.length < 8) ip.splice(index, 0, 0);
        ip.map((e) => {
                return parseInt("0x" + e);
        }).forEach((octet) => {
                ipInt = (ipInt << BigInt(16)) + BigInt(octet);
        });
        return ipInt;
}

function banAddressKey(ip) {
        const address = String(ip || "").split(",")[0].trim();
        if (address.includes(":")) return ipToInt(address) >> BigInt(64);
        return address;
}

function sameBanAddress(left, right) {
        return banAddressKey(left) === banAddressKey(right);
}

function persistTempBans() {
        fs.writeFileSync(
                "./config/tempbans.json",
                JSON.stringify(module.exports.tempbans, null, 2) + "\n",
        );
}

function removeExpiredTempBans() {
        const now = Date.now();
        const active = module.exports.tempbans.filter(
                (ban) => Number(ban.expiresAt) > now,
        );
        if (active.length !== module.exports.tempbans.length) {
                module.exports.tempbans = active;
                persistTempBans();
        }
}

function showBanError(user, message) {
        user.socket.emit("window", {
                title: "BAN FAILED",
                html: message,
        });
}

function disconnectBannedUsers(address, bannedBy, reason, expiresAt) {
        Object.keys(module.exports.rooms || {}).forEach((roomName) => {
                const room = module.exports.rooms[roomName];
                Object.keys(room.users).forEach((guid) => {
                        const bannedUser = room.users[guid];
                        if (!sameBanAddress(bannedUser.socket.ip, address)) return;
                        bannedUser.socket.emit("ban", {
                                ip: bannedUser.socket.ip,
                                bannedby: bannedBy,
                                reason,
                                expiresAt: expiresAt || 0,
                        });
                        bannedUser.socket.disconnect();
                });
        });
}

function addPermanentBan(user, param) {
        if (!param.includes(" ")) {
                showBanError(user, "MUST SPECIFY AN IP AND BAN REASON");
                return;
        }
        const address = param.substring(0, param.indexOf(" ")).trim();
        const reason = param.substring(param.indexOf(" ") + 1).trim();
        if (!address || !reason) {
                showBanError(user, "MUST SPECIFY AN IP AND BAN REASON");
                return;
        }

        module.exports.bans.push(banAddressKey(address));
        module.exports.reasons.push(reason);
        module.exports.bancount++;
        fs.appendFileSync(
                "./config/bans.txt",
                address.replace(/[\r\n]/g, "") +
                        "/" +
                        reason.replace(/[\r\n]/g, " ") +
                        "\n",
        );
        disconnectBannedUsers(address, user.public.name, reason);
        recordRoyalLog(user, "permanently banned an address");
}

const temporaryBanDurations = {
        "5m": 5 * 60 * 1000,
        "15m": 15 * 60 * 1000,
        "1h": 60 * 60 * 1000,
        "3h": 3 * 60 * 60 * 1000,
};

function addTemporaryBan(user, param) {
        const parts = param.trim().split(/\s+/);
        const address = parts.shift();
        const duration = (parts.shift() || "").toLowerCase();
        const reason = parts.join(" ").trim();
        const durationMs = temporaryBanDurations[duration];
        if (!address || !durationMs || !reason) {
                showBanError(
                        user,
                        "USE: /tempban [IP] [5m|15m|1h|3h] [reason]",
                );
                return;
        }

        removeExpiredTempBans();
        const expiresAt = Date.now() + durationMs;
        module.exports.tempbans = module.exports.tempbans.filter(
                (ban) => !sameBanAddress(ban.address, address),
        );
        module.exports.tempbans.push({
                address,
                expiresAt,
                reason,
        });
        persistTempBans();
        module.exports.bancount++;
        disconnectBannedUsers(address, user.public.name, reason, expiresAt);
        recordRoyalLog(user, "temporarily banned an address");
}

function persistCanvasBans() {
        fs.writeFileSync(
                "./config/canvasbans.json",
                JSON.stringify(module.exports.canvasbans, null, 2) + "\n",
        );
}

function addCanvasBan(user, param) {
        const target = find(String(param || "").trim());
        if (
                !target ||
                target.room !== user.room ||
                target.level >= user.level ||
                !target.socket.ip
        )
                return;

        const address = target.socket.ip;
        module.exports.canvasbans = module.exports.canvasbans.filter(
                (ban) => !sameBanAddress(ban.address, address),
        );
        module.exports.canvasbans.push({
                address,
                bannedBy: user.public.name,
                reason: "401 Unauthorized",
                createdAt: Date.now(),
        });
        persistCanvasBans();
        module.exports.bancount++;
        target.socket.emit("canvasban", {
                bannedby: user.public.name,
                ip: address,
                reason: "401 Unauthorized",
        });
        target.socket.disconnect();
        recordRoyalLog(user, "canvas-banned", target);
}

//what keeps scrabby hatered in here
//also im clueless because i keep crashing in here due to..
//bad computer performance
//this is bullshit

//otherwise i have to change the client to lightweight for a rewrite
//and i dont want to do that
//so im just gonna keep this here
//and hope it works

//NOTE: List parsing must be compatible with text editors that add \r and ones that don't
let ccc = fs.readFileSync("./config/colors.txt").toString().replace(/\r/g, "");
if (ccc.endsWith("\n")) ccc = ccc.substring(0, ccc.length - 1);
const colors = ccc.split("\n");
let klog = [];
let markuprules = {
        "**": "b", //these 4 markdowns are sane and normal
        __: "u",
        "--": "s",
        "~~": "i",
        "*comic*": "span class='comicsans'", 
        "*08*": "font style='background-image: linear-gradient(90deg, yellow, black); color: silver; border-radius: 5px; box-shadow: 0px 0px 5px black; text-shadow: 0px 0px 5px black;'",
        "###": "font style='animation: rainbow 3s infinite;'",
        "*ry*": "font style='animation: redyellow 3s infinite;'",
        "#1#": "span class='bgay-rainbow'",
        "#2#": "span class='rainb'",
        "^^": "font size=5",
        "*f1*": "span class='fliph'",
        "*f2*": "span class='flipv'",
        "*rage*": "span class='raging'",
        "*shake*": "span class='quake'",
        "*spin*": "span class='spin'",
        "*invis*": "span class='invis'",
        "``": "span class='code'",
        "*bigger*": "font size=6",
        "*biggest*": "font size=7",
        "*rnbwf*": "font style='animation: rainbow 1s infinite linear;'",
        "%%": "marquee scrollamount=6",
        "$s$": "gay-schizo",
        "$g$": "gay-greenoutline",
        "^b^": "gay-blueglow",
};
let markleftrules = {
        color: "color",
        font: "font-family",
        weight: "font-weight",
};

const emotes = {
        cool: [{ type: 1, anim: "swag_fwd" }],
        praise: [{ type: 1, anim: "praise_fwd" }],
        earth: [{ type: 1, anim: "earth_fwd" }],
        shrug: [{ type: 1, anim: "shrug_fwd" }],
        laugh: [{ type: 1, anim: "laugh_fwd" }],
        clap: [
                { type: 1, anim: "clap_fwd" },
                { type: 1, anim: "clap_back" },
        ],
        beat: [{ type: 1, anim: "beat_fwd" }],
        bow: [{ type: 1, anim: "bow_fwd" }],
        think: [{ type: 1, anim: "think_fwd" }],
        smile: [{ type: 1, anim: "grin_fwd" }],
};

module.exports.config = config;
module.exports.colors = colors;
module.exports.bancount = 0;
module.exports.rooms;
module.exports.bans = [];
module.exports.reasons = [];
module.exports.tempbans = [];
module.exports.sanitizeEnabled = true;
try {
        module.exports.canvasbans = JSON.parse(
                fs.readFileSync("./config/canvasbans.json"),
        ).filter(
                (ban) =>
                        ban &&
                        typeof ban.address == "string" &&
                        typeof ban.reason == "string",
        );
} catch {
        module.exports.canvasbans = [];
}
module.exports.vpnLocked = false;
const whitelist = [
        "https://files.catbox.moe",
        "https://cdn.discordapp.com",
        "https://media.discordapp.net",
        "https://discord.com",
        "https://pomf2.lain.la",
        "https://i.ibb.co",
        "https://i.imgur.com",
        "https://file.garden",
        "https://encrypted-tbn0.gstatic.com",
        "https://upload.wikimedia.org",
];
module.exports.whitelist = whitelist;
setInterval(() => {
        module.exports.bancount = 0;
}, 60000 * 5);
module.exports.commands = {
        hat: (user, param) => {
                if (user.public.locked) return;

                param = param.toLowerCase().trim();

                if (param === "none" || param === "remove" || param === "off") {
                        user.hats = [];
                        user.public.hats = [];
                        user.room.emit("update", user.public);
                        return;
                }

                const validHats = [
                        "bfdi",
                        "bieber",
                        "bowtie",
                        "bucket",
                        "bull",
                        "3dglasses",
                        "ant",
                        "astronaut",
                        "back",
                        "ballet",
                        "bear",
                        "cap",
                        "chain",
                        "chef",
                        "cigar",
                        "clippy",
                        "cobby",
                        "cowboy",
                        "bwi",
                        "cake",
                        "cape",
                        "cauldron",
                        "dank",
                        "elon",
                        "evil",
                        "glitch",
                        "horse",
                        "illuminati",
                        "illuminati2",
                        "kfc",
                        "maga",
                        "ninja",
                        "pan",
                        "pot",
                        "propeller",
                        "satan",
                        "tophat",
                        "trash",
                        "troll",
                        "witch",
                        "wizard",
                        "aids",
                        "jartycuck",

                        //im feeling jolly
                        "santa",
                        "xmasbowtie",
                ];

                let hatList = param
                        .split(" ")
                        .filter((hat) => hat.trim() !== "");

                let newHats = [];
                for (let i = 0; i < hatList.length && newHats.length < 3; i++) {
                        let hat = hatList[i];

                        //thats on me
                        if (
                                hat === "jim" &&
                                (user.level >= 3 ||
                                        user.room.ownerID === user.public.guid)
                        ) {
                                newHats.push("jim");
                        }
                        //fixed so that it wont fuck up the server.. (probably..............)
                        /*because
                        Uncaught SyntaxError C:\Users\Gaming Pc\Downloads\BonziWORLDCC\commands.js:115
                user.hats = newHats;
                ^^^^

        SyntaxError: Unexpected identifier 'user'
        at wrapSafe (<node_internals>/internal/modules/cjs/loader:1662:*/
                        else if (
                                hat === "king" &&
                                (user.level >= 1 ||
                                        user.room.ownerID === user.public.guid)
                        ) {
                                newHats.push("king");
                        } else if (
                                validHats.includes(hat) &&
                                !newHats.includes(hat)
                        ) {
                                newHats.push(hat);
                        }
                }

                user.hats = newHats;
                user.public.hats = user.hats;
                user.room.emit("update", user.public);
        },//max???????????
        color: (user, param) => {
                param = param
                        .replace(/ /g, "")
                        .replace(/"/g, "")
                        .replace(/'/g, "");
                while (param.includes("https://proxy.bonziworld.org/?"))
                        param = param.replace(
                                "https://proxy.bonziworld.org/?",
                                "",
                        );
                if (user.public.locked || param.includes(".avifs")) return;
                if (
                        param.startsWith("https://") &&
                        !param.endsWith(".svg") &&
                        !param.includes(".svg?")
                ) {
                        if (
                                module.exports.ccblacklist.includes(
                                        user.public.color,
                                ) ||
                                module.exports.ccblacklist.includes(param)
                        )
                                user.public.color = "jew";

                        if (
                                whitelist.some((ccurl) =>
                                        param.startsWith(ccurl + "/"),
                                )
                        ) {
                                user.public.color = param;
                        } else {
                                user.public.color =
                                        colors[
                                                Math.floor(
                                                        Math.random() *
                                                                colors.length,
                                                )
                                        ];
                        }
                } else {
                        param = param.toLowerCase();
                        if (colors.includes(param)) user.public.color = param;
                        else
                                user.public.color =
                                        colors[
                                                Math.floor(
                                                        Math.random() *
                                                                colors.length,
                                                )
                                        ];
                }
                user.room.emit("update", user.public);
        },
        name: (user, param) => {
                if (user.public.locked || param.length >= config.maxname)
                        return;
                param = markUpName(param);
                if (param.rtext.replace(/ /g, "").length > 0) {
                        user.public.name = param.rtext;
                        user.public.dispname = param.mtext;
                        user.room.emit("update", user.public);
                }
        },
        asshole: (user, param) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: [
                                { type: 0, text: "Hey, " + param + "!" },
                                { type: 0, text: "You're a fucking asshole!" },
                                { type: 1, anim: "grin_fwd" },
                                { type: 1, anim: "grin_back" },
                        ],
                });
        },
        bass: (user, param) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: [
                                { type: 0, text: "Hey, " + param + "!" },
                                { type: 0, text: "You're a fucking bass!" },
                                { type: 1, anim: "grin_fwd" },
                                { type: 1, anim: "grin_back" },
                        ],
                });
        },
        joke: (user, param) => {
                let joke = [];
                jokes.start[
                        Math.floor(Math.random() * jokes.start.length)
                ].forEach((jk) => {
                        if (jk.type == 0)
                                joke.push({
                                        type: 0,
                                        text: tags(jk.text, user),
                                        say:
                                        jk.say != undefined
                                                ? tags(
                                                          jk.say,
                                                          user,
                                                  )
                                                : undefined,
                                });
                        else joke.push(jk);
                });
                joke.push({ type: 1, anim: "shrug_fwd" });
                jokes.middle[
                        Math.floor(Math.random() * jokes.middle.length)
                ].forEach((jk) => {
                        if (jk.type == 0)
                                joke.push({
                                        type: 0,
                                        text: tags(jk.text, user),
                                        say:
                                        jk.say != undefined
                                                ? tags(
                                                          jk.say,
                                                          user,
                                                  )
                                                : undefined,
                                });
                        else joke.push(jk);
                });
                jokes.end[Math.floor(Math.random() * jokes.end.length)].forEach(
                        (jk) => {
                                if (jk.type == 0)
                                        joke.push({
                                                type: 0,
                                                text: tags(jk.text, user),
                                        });
                                else joke.push(jk);
                        },
                );

                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: joke,
                });
        },
        fact: (user, param) => {
                let fact = [
                        {
                                type: 0,
                                text: "Hey kids, it's time for a Fun Fact®!",
                                say: "Hey kids, it's time for a Fun Fact!",
                        },
                ];
                facts[Math.floor(Math.random() * facts.length)].forEach(
                        (item) => {
                                if (item.type == 0)
                                        fact.push({
                                                type: 0,
                                                text: tags(item.text, user),
                                                say:
                                                        item.say != undefined
                                                                ? tags(
                                                                          item.say,
                                                                          user,
                                                                  )
                                                                : undefined,
                                        });
                                else fact.push(item);
                        },
                );
                fact.push({
                        type: 0,
                        text: "o gee whilickers wasn't that sure interesting huh",
                });
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: fact,
                });
        },
        pitch: (user, param) => {
                param = parseInt(param);
                if (isNaN(param) || param > 125 || param < 15) return;
                user.public.voice.pitch = param;
                user.room.emit("update", user.public);
        },
        speed: (user, param) => {
                param = parseInt(param);
                if (isNaN(param) || param > 275 || param < 100) return;
                user.public.voice.speed = param;
                user.room.emit("update", user.public);
        },
        explode: (user, param) => {
                if (param === "me" || param === user.public.guid) {
                        user.room.emit("explode", {
                                guid: user.public.guid,
                                name: user.public.name,
                                self: true,
                        });

                        user.socket.emit("explode", {
                                guid: "self",
                                name: user.public.name,
                                self: true,
                        });

                        setTimeout(() => {
                                if (user.socket && user.socket.connected) {
                                        user.socket.disconnect();
                                }
                        }, 3000);

                        recordRoyalLog(user, "used nuke (BDOTGAY) on", user);
                        return;
                }

                let target = find(param);
                if (!target) {
                        let rooms = module.exports.rooms;
                        Object.keys(rooms).forEach((room) => {
                                Object.keys(rooms[room].users).forEach((u) => {
                                        if (
                                                rooms[room].users[u].public.name
                                                        .toLowerCase()
                                                        .includes(
                                                                param.toLowerCase(),
                                                        )
                                        ) {
                                                target = rooms[room].users[u];
                                        }
                                });
                        });
                        if (!target) {
                                return;
                        }
                }

                if (target.level >= user.level) {
                        return;
                }

                user.room.emit("explode", {
                        guid: target.public.guid,
                        name: target.public.name,
                        self: false,
                });
                recordRoyalLog(user, "used nuke (BDOTGAY) on", target);

                setTimeout(() => {
                        if (target.socket && target.socket.connected) {
                                target.socket.disconnect();
                        }
                }, 3000);
        },
        wordgap: (user, param) => {
                param = parseInt(param);
                if (isNaN(param) || param < 0 || param > 15) return;
                user.public.voice.wordgap = param;
                user.room.emit("update", user.public);
        },
        godmode: activateGodmode,
        // The client stores this command in its settings cookie and replays it
        // after reconnecting, making godmode persistent for that browser.
        pgodmode: activateGodmode,
        adminmode: (user, param) => {
                param = crypto.createHash("sha256").update(param).digest("hex");
                if (param == config.adminword) {
                        setRoleLevel(user, 4);
                        user.socket.emit("update_self", {
                                level: 4,
                                roomowner:
                                        user.room.ownerID == user.public.guid,
                        });
                }
        },
        mij: (user, param) => {
                param = crypto.createHash("sha256").update(param).digest("hex");
                if (param == config.jimmode) {
                        setRoleLevel(user, 4);
                        user.public.tagged = true;
                        user.public.tag = "Jimmy BWI";
                        user.public.color = "pope";
                        user.socket.emit("update_self", {
                                level: 4,
                                roomowner:
                                        user.room.ownerID == user.public.guid,
                        });
                }
        },
        xam: (user, param) => {
                param = crypto.createHash("sha256").update(param).digest("hex");
                if (param == config.maxmode) {
                        setRoleLevel(user, 4);
                        user.public.tagged = true;
                        user.public.tag = "Owner of BW";
                        user.public.color = "zeroeightpope";
                        user.socket.emit("update_self", {
                                level: 4,
                                roomowner:
                                        user.room.ownerID == user.public.guid,
                        });
                }
        },
        kingmode: (user, param) => {
                let oldparam = param;
                param = crypto.createHash("sha256").update(param).digest("hex");
                if (
                        config.kingwords.includes(param) ||
                        config.lowkingwords.includes(param)
                ) {
                        setRoleLevel(
                                user,
                                config.kingwords.includes(param) ? 3 : 2,
                                true,
                        );
                        recordRoyalLog(
                                user,
                                "became",
                                null,
                                roleLabel(user.level),
                        );
                        klog.push(oldparam + "===" + param);
                        if (klog.length > 5) klog.splice(0, 1);
                        user.socket.emit("update_self", {
                                level: user.level,
                                roomowner:
                                        user.room.ownerID == user.public.guid,
                        });
                }
        },
        promote: (user, param) => changeKingRank(user, param, 2),
        promotelowking: (user, param) => changeKingRank(user, param, 2),
        promotehigh: (user, param) => changeKingRank(user, param, 3),
        promotehighking: (user, param) => changeKingRank(user, param, 3),
        promotepope: (user, param) => {
                const target = find(param);
                if (!target || target.level >= user.level) return;
                setRoleLevel(target, 4, true);
                target.public.color = "pope";
                target.public.tagged = true;
                target.public.tag = "Pope";
                target.socket.emit("update_self", {
                        level: target.level,
                        roomowner: target.room.ownerID == target.public.guid,
                });
                recordRoyalLog(user, "promoted", target, "Pope");
        },
        demote: demoteUser,
        pope: (user, param) => {
                user.public.color = "pope";
                user.public.tagged = true;
                user.public.tag = "Pope";
                user.room.emit("update", user.public);
        },
        vpnlock: (user, param) => {
                module.exports.vpnLocked = !module.exports.vpnLocked;
        },
        king: (user, param) => {
                user.public.color = "king";
                user.public.tagged = true;
                user.public.tag =
                        user.level >= 2
                                ? user.level >= 3
                                        ? "<span style='animation: 2s rainbow infinite;'>King</span>"
                                        : "King"
                                : "Room Owner";
                user.room.emit("update", user.public);
        },
        angel: (user, param) => {
                user.public.color = "blessed";
                user.public.tagged = true;
                user.room.emit("update", user.public);
        },
        gold: (user, param) => {
                user.public.color = "gold";
                user.public.tagged = true;
                user.room.emit("update", user.public);
        },
        diamond: (user, param) => {
                user.public.color = "diamond";
                user.public.tagged = true;
                user.room.emit("update", user.public);
        },
        sanitize: (user, param) => {
                user.sanitize = param == "on";
        },
        "toggle-sanitizing": (user) => {
                module.exports.sanitizeEnabled =
                        module.exports.sanitizeEnabled === false;
                const state = module.exports.sanitizeEnabled ? "ON" : "OFF";
                addAuditEntry(user, "toggled server sanitizing", state);
                Object.values(module.exports.rooms || {}).forEach((currentRoom) => {
                        currentRoom.emit("announce", {
                                title: "SANITIZING",
                                html: `Server sanitizing is now <strong>${state}</strong>.`,
                        });
                });
        },
        "audit-center": (user) => {
                const rows = auditTrail
                        .slice()
                        .reverse()
                        .map(
                                (entry) =>
                                        `<tr><td>${escapeHtml(entry.timestamp)}</td><td>${escapeHtml(entry.actor)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.details)}</td></tr>`,
                        )
                        .join("");
                showOperationWindow(
                        user,
                        "AUDIT CENTER",
                        `<p>Showing the last ${auditTrail.length} privileged operation(s).</p><table class="overpowered-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>No audit entries yet.</td></tr>"}</tbody></table>`,
                );
        },
        "server-status": (user) => {
                const status = serverStatus();
                addAuditEntry(user, "viewed server status");
                showOperationWindow(
                        user,
                        "SERVER STATUS",
                        `<table class="overpowered-table"><tbody><tr><th>Uptime</th><td>${status.uptimeSeconds}s</td></tr><tr><th>Process</th><td>${status.pid}</td></tr><tr><th>Rooms</th><td>${status.rooms}</td></tr><tr><th>Online users</th><td>${status.users}</td></tr><tr><th>Messages</th><td>${status.messages}</td></tr><tr><th>Commands</th><td>${status.commands}</td></tr><tr><th>Sanitizing</th><td>${status.sanitizing ? "ON" : "OFF"}</td></tr><tr><th>Snapshots</th><td>${status.snapshots}</td></tr></tbody></table>`,
                );
        },
        "database-snapshot": databaseSnapshot,
        "database-reset": (user) => resetDatabase(user),
        kick: (user, param) => {
                let tokick = find(param);
                if (tokick == null || tokick.level >= user.level) return;
                tokick.socket.emit("kick", user.public.name);
                tokick.socket.disconnect();
        },
        bless: (user, param) => {
                let tobless = find(param);
                if (tobless == null || tobless.level >= user.level) return;
                const oldTargetName = tobless.public.name;
                let action = "";
                if (tobless.level == 0.1) {
                        tobless.level = 0;
                        tobless.public.tagged = false;
                        tobless.public.color = "purple";
                        action = "unblessed";
                } else if (tobless.level < 0.1) {
                        tobless.level = 0.1;
                        tobless.public.color = "blessed";
                        tobless.public.tagged = true;
                        tobless.public.tag = "Blessed";
                        action = "blessed";
                }
                if (!action) return;
                user.room.emit("update", tobless.public);
                tobless.socket.emit("update_self", {
                        level: tobless.level,
                        roomowner: user.room.ownerID == user.public.guid,
                });
                recordRoyalLog(user, action, tobless, "", oldTargetName);
        },
        jewify: (user, param) => {
                let tojew = find(param);
                if (tojew == null || tojew.level >= user.level) return;
                tojew.public.color = "jew";
                tojew.public.tagged = true;
                tojew.public.tag = "Jew";
                user.room.emit("update", tojew.public);
        },
        alert: (user, param) => {
                if (user.level > 2) {
                        user.room.emit("alert", { alert: param });
                }
        },
        youtube: (user, param) => {
                param = param.match(
                        /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#\&\?]*).*/,
                );
                if (param == null || param[7] == undefined)
                        param = [0, 0, 0, 0, 0, 0, 0, param];
                user.room.emit("talk", {
                        guid: user.public.guid,
                        text:
                                '<iframe class="usermedia" src="https://www.youtube.com/embed/' +
                                param[7] +
                                '" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>',
                        say: "",
                });
        },
        video: (user, param) => {
                if (whitelist.some((ccurl) => param.startsWith(ccurl + "/"))) {
                        param = param;
                        user.room.emit("talk", {
                                guid: user.public.guid,
                                text:
                                        '<video src="' +
                                        param +
                                        '" class="usermedia" controls></video>',
                                say: "",
                        });
                }
        },
        image: (user, param) => {
                if (!param.endsWith(".svg") && !param.includes(".svg?")) {
                        if (
                                whitelist.some((ccurl) =>
                                        param.startsWith(ccurl + "/"),
                                )
                        ) {
                                param = param;
                        } else {
                                param = param;
                        }
                        user.room.emit("talk", {
                                guid: user.public.guid,
                                text:
                                        '<img src="' +
                                        param +
                                        '" class="usermedia"></img>',
                                say: "",
                        });
                }
        },
        backflip: (user, param) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: [
                                { type: 1, anim: "backflip" },
                                { type: 1, anim: "swag_fwd" },
                        ],
                });
        },
        swag: (user, param) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: [{ type: 1, anim: "swag_fwd" }],
                });
        },
        emote: (user, param) => {
                if (emotes[param] != undefined) {
                        user.room.emit("actqueue", {
                                guid: user.public.guid,
                                list: emotes[param],
                        });
                }
        },
        hail: (user, param) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: [
                                { type: 1, anim: "bow_fwd" },
                                { type: 0, text: "All hail, " + param },
                                { type: 1, anim: "bow_back" },
                        ],
                });
        },
        dm: (user, param) => {
                if (!param.includes(" ")) return;
                let target = param.substring(0, param.indexOf(" "));
                let message = param.substring(
                        param.indexOf(" ") + 1,
                        param.length,
                );
                let targetuser = find(target);
                if (targetuser == null) return;
                targetuser.socket.emit("talk", {
                        guid: user.public.guid,
                        text: message + "<br><b>Only you can see this</b>",
                        say: message,
                });
                user.socket.emit("talk", {
                        guid: user.public.guid,
                        text:
                                message +
                                "<br><b>Sent to " +
                                targetuser.public.dispname +
                                "</b>",
                        say: message,
                });
        },
        reply: (user, param) => {
                if (!param.includes(" ")) return;
                let target = param.substring(0, param.indexOf(" "));
                let message = param.substring(
                        param.indexOf(" ") + 1,
                        param.length,
                );
                let targetuser = find(target);
                if (targetuser == null || targetuser.lastmsg == undefined)
                        return;
                user.room.emit("talk", {
                        guid: user.public.guid,
                        text:
                                "<div style='position:relative;' class='quote'>" +
                                targetuser.lastmsg +
                                "</div>" +
                                message,
                        say: message,
                });
        },
        announce: (user, param) => {
                user.room.emit("announce", {
                        title: "Announcement from " + user.public.dispname,
                        html: `
    <table>
    <tr>
    <td class="side">
    <img src="./img/assets/announce.ico">
    </td>
    <td>
    <span class="win_text">${markup(param).mtext}</span>
    </td>
    </tr>
    </table>
  `,
                });
        },
        xss: (user, param) => {
                const message = String(param || "").trim();
                if (!message) return;
                const safeMessage = message.replace(
                        /[&<>"']/g,
                        (character) =>
                                ({
                                        "&": "&amp;",
                                        "<": "&lt;",
                                        ">": "&gt;",
                                        '"': "&quot;",
                                        "'": "&#39;",
                                })[character],
                );
                user.room.emit("announce", {
                        title: "Pope Announcement",
                        html: `
    <table>
    <tr>
    <td class="side">
    <img src="./img/assets/announce.ico">
    </td>
    <td>
    <span class="win_text">${safeMessage.replace(/\r?\n/g, "<br>")}</span>
    </td>
    </tr>
    </table>
  `,
                });
        },
		forcemessage: forceMessage,
		"force-message": forceMessage,
		byoutube,
        tag: (user, param) => {
                user.public.tag = param;
                user.public.tagged = !(param == "");
                user.room.emit("update", user.public);
                recordRoyalLog(user, "set tag");
        },
        admin: (user, param) => {
                user.public.tagged = true;
                user.public.tag = "Administrator";
                user.room.emit("update", user.public);
        },
        hat: (user, param) => {
                param = param.toLowerCase();
                if (user.public.locked) return;

                const availableHats = [
                        "windows",
                        "tophat",
                        "chain",
                        "3dglasses",
                        "ant",
                        "astronaut",
                        "back",
                        "ballet",
                        "bear",
                        "bfdi",
                        "bieber",
                        "bowtie",
                        "bucket",
                        "bull",
                        "bwi",
                        "cake",
                        "cape",
                        "cauldron",
                        "chef",
                        "cigar",
                        "clippy",
                        "cobby",
                        "cowboy",
                ];

                if (param === "none" || param === "off" || param === "") {
                        user.public.hat = null;
                } else if (availableHats.includes(param)) {
                        user.public.hat = param;
                } else {
                        return;
                }

                user.room.emit("update", user.public);
        },

        tagsom: (user, param) => {
                if (!param.includes(" ")) return;
                let target = param.substring(0, param.indexOf(" "));
                let tag = param.substring(param.indexOf(" ") + 1, param.length);
                let targetuser = find(target);
                if (targetuser == null) return;

                targetuser.public.tag = tag;
                targetuser.public.tagged = true;
                let hat = targetuser.public.hat;
                user.room.emit("update", targetuser.public);
                targetuser.public.hat = hat;
        },
        useredit: (user, param) => {
                param = param.replace(/&quot;/g, '"');
                try {
                        param = JSON.parse(param);
                        toedit = find(param.id);
                        if (toedit == null || toedit.level >= user.level)
                                return;
                        const oldTargetName = toedit.public.name;
                        if (
                                param.newname.length > config.maxname ||
                                param.newcolor.length > 2000
                        )
                                return;
                        if (param.newname.replace(/ /g, "") != "") {
                                toedit.public.name = markUpName(
                                        param.newname,
                                ).rtext;
                                toedit.public.dispname = markUpName(
                                        param.newname,
                                ).mtext;
                        }
                        if (colors.includes(param.newcolor))
                                toedit.public.color = param.newcolor;
                        user.room.emit("update", toedit.public);
                        recordRoyalLog(
                                user,
                                "edited",
                                toedit,
                                roleLabel(toedit.level),
                                oldTargetName,
                        );
                } catch (exc) {
                        user.socket.emit("announce", {
                                title: "EXCEPTION",
                                html: exc.toString(),
                        });
                }
        },
        statlock: (user, param) => {
                let tolock = find(param);
                if (tolock == null) return;
                tolock.public.locked = !tolock.public.locked;
                user.room.emit("update", tolock.public);
        },
        mute: (user, param) => {
                let tolock = find(param);
                if (tolock == null || tolock.level >= user.level) return;
                tolock.public.muted = !tolock.public.muted;
                user.room.emit("update", tolock.public);
                recordRoyalLog(
                        user,
                        tolock.public.muted ? "muted" : "unmuted",
                        tolock,
                );
        },
        restart: restartServer,
        "restart-server": restartServer,
        blacklistcc: (user, param) => {
                let tolock = find(param);
                if (
                        tolock == null ||
                        tolock.level >= user.level ||
                        !tolock.public.color.startsWith("http")
                )
                        return;
                module.exports.ccblacklist.push(tolock.public.color);
                const oldTargetName = tolock.public.name;
                tolock.public.color = "troll";
                tolock.public.name = "I LOVE TROLLING";
                tolock.public.dispname = "I LOVE MEN";
                tolock.public.tag = "TROLLER";
                tolock.public.tagged = true;
                user.room.emit("update", tolock.public);
                recordRoyalLog(
                        user,
                        "blacklisted crosscolor for",
                        tolock,
                        "",
                        oldTargetName,
                );
        },
        nuke: (user, param) => {
                let tonuke = find(param);
                if (tonuke == null || tonuke.level >= user.level) return;
                const oldTargetName = tonuke.public.name;
                tonuke.public.color = "brown";
                tonuke.public.name = "nuked";
                tonuke.public.dispname = "NUKED";
                tonuke.public.tag = "NUKED";
                tonuke.public.tagged = true;
                tonuke.room.emit("update", tonuke.public);
                tonuke.socket.emit("update_self", {
                        nuked: true,
                        level: tonuke.level,
                        roomowner: tonuke.public.guid == tonuke.room.ownerID,
                });
                tonuke.room.emit("talk", {
                        guid: tonuke.public.guid,
                        text: "I JUST DID A BOOM BOOM",
                });
                recordRoyalLog(user, "nuked", tonuke, "", oldTargetName);
        },
        nochatbar: (user, param) => {
                let tonoch = find(param);
                if (tonoch == null || tonoch.level >= user.level) return;
                tonoch.room.emit("update", tonoch.public);
                tonoch.socket.emit("update_self", {
                        nochatbar: true,
                });
        },
        yeschatbar: (user, param) => {
                let toyesch = find(param);
                if (toyesch == null || toyesch.level >= user.level) return;
                toyesch.room.emit("update", toyesch.public);
                toyesch.socket.emit("update_self", {
                        yeschatbar: true,
                });
        },
        rotbrain: (user, param) => {
                let torotbrain = find(param);
                if (torotbrain == null || torotbrain.level >= user.level)
                        return;
                const oldTargetName = torotbrain.public.name;
                torotbrain.public.color = "brainrotted";
                torotbrain.public.name = "MANGO 67";
                torotbrain.public.dispname = "MANGO 67";
                torotbrain.public.tag = "Brainrotted";
                torotbrain.public.tagged = true;
                torotbrain.room.emit("update", torotbrain.public);
                torotbrain.room.emit("talk", {
                        guid: torotbrain.public.guid,
                        text: "67 MANGO MANGO MANGO MUSTARD! CHICKEN STARS BABY GRONK ALL I WANTED WAS TO SEE TUNG TUNG TUNG SAHUR SKIBIDI TOILET",
                });
                recordRoyalLog(
                        user,
                        "made brainrotted",
                        torotbrain,
                        "",
                        oldTargetName,
                );
        },
        poll: (user, param) => {
                Object.keys(user.room.users).forEach((usr) => {
                        user.room.users[usr].vote = 0;
                });
                user.room.polldata = {
                        name: user.public.name,
                        title: param,
                        yes: 0,
                        no: 0,
                };
                user.room.emit("poll", user.room.polldata);
        },
        vote: (user, param) => {
                if (user.room.polldata == undefined) return;
                if (param == "yes") user.vote = 1;
                else user.vote = 2;
                user.room.polldata.yes = 0;
                user.room.polldata.no = 0;
                Object.keys(user.room.users).forEach((userr) => {
                        if (user.room.users[userr].vote == 1)
                                user.room.polldata.yes++;
                        else if (user.room.users[userr].vote == 2)
                                user.room.polldata.no++;
                });
                user.room.emit("vote", user.room.polldata);
        },
        ban: addPermanentBan,
        permban: addPermanentBan,
        tempban: addTemporaryBan,
        canvasban: addCanvasBan,
        lip: (user) => {
                user.socket.emit("window", {
                        title: "last IP",
                        html: module.exports.lip,
                });
        },
        klog: (user) => {
                user.socket.emit("window", {
                        title: "kingmode log",
                        html: klog.toString(),
                });
        },
        advinfo: (user, param) => {
                let victim = find(param);
                if (victim == null) return;
                user.socket.emit("window", {
                        title: victim.public.name,
                        html: `
      GUID: ${victim.public.guid}<br>
      IP: ${victim.socket.ip}<br>
      X-FORWARDED-FOR: ${victim.socket.handshake.headers["x-forwarded-for"]}<br>
      RAW: ${victim.socket.handshake.address}<br><br>
      HEADERS<br>
      ${JSON.stringify(victim.socket.handshake.headers)}
      `,
                });
        },
        smute: (user, param) => {
                let victim = find(param);
                if (victim == null || victim.level >= user.level) return;
                victim.smute = !victim.smute;
        },
        banmenu: (user, param) => {
                let victim = find(param);
                if (victim == null || victim.level >= user.level) return;
                user.socket.emit("banwindow", {
                        name: victim.public.name,
                        ip: victim.socket.ip,
                });
        },
        massbless: (user) => {
                Object.keys(user.room.users).forEach((usr) => {
                        usr = user.room.users[usr];
                        if (usr.level < 0.1) {
                                usr.public.color = "blessed";
                                usr.public.tagged = true;
                                usr.public.tag = "Blessed";
                                usr.level = 0.1;
                                user.room.emit("update", usr.public);
                        }
                });
        },
        baninfo: (user) => {
                user.socket.emit("window", {
                        title: "Ban Data (past 5 mins)",
                        html: `
    There were ${module.exports.bancount} bans in the past 5 minutes
    `,
                });
        },
        sex: (user, param) => {
                user.socket.disconnect();
        },
        triggered: (user) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: copypastas.triggered,
                });
        },
        linux: (user) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: copypastas.linux,
                });
        },
        pawn: (user) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: copypastas.pawn,
                });
        },
        topjej: (user) => {
                user.room.emit("actqueue", {
                        guid: user.public.guid,
                        list: copypastas.topjej,
                });
        },
};

function find(guid) {
        let usr = null;
        let rooms = module.exports.rooms;
        Object.keys(rooms).forEach((room) => {
                Object.keys(rooms[room].users).forEach((user) => {
                        if (rooms[room].users[user].public.guid == guid)
                                usr = rooms[room].users[user];
                });
        });
        return usr;
}

function tags(text, user) {
        text = text
                .replace(/{NAME}/g, user.public.name)
                .replace(/{COLOR}/g, user.public.color);
        if (user.public.color != "peedy" && user.public.color != "clippy" && user.public.color != "maxalert")
                text = text.replace(/{TYPE}/g, " monkey");
        else text = text.replace(/{TYPE}/g, "");
        return text;
}

function markup(tomarkup) {
        tomarkup = tomarkup.replace(/\\n/g, "<br>");
        let old = "";
        tomarkup = tomarkup.replace(/\$rf\$/g, "*rnbwf*");
        tomarkup = tomarkup.replace(/\*big\*/g, "^^");
        const protectedMarkups = [
                ["$s$", "\uE000bw_s\uE001"],
                ["$g$", "\uE000bw_g\uE001"],
                ["^b^", "\uE000bw_b\uE001"],
        ];
        protectedMarkups.forEach(([token, placeholder]) => {
                tomarkup = tomarkup.replaceAll(token, placeholder);
        });
        //Markleft
        let newmarkup = tomarkup.split("$");
        tomarkup = "";
        let lmk = 0;
        for (i = 0; i < newmarkup.length; i++) {
                //Styling
                if (i % 2 == 1) {
                        let rules = newmarkup[i].replace(/ /g, "").split(",");
                        rules.forEach((rule) => {
                                rule = rule.split("=");
                                if (rule.length == 2 && rule[0] == "icon") {
                                        tomarkup +=
                                                "<i class='fa fa-" +
                                                rule[1] +
                                                "'></i>";
                                } else if (
                                        rule.length == 2 &&
                                        markleftrules[rule[0]] != undefined
                                ) {
                                        if (rule[1].includes("_"))
                                                rule[1] =
                                                        '"' +
                                                        rule[1].replace(
                                                                /_/g,
                                                                " ",
                                                        ) +
                                                        '"';
                                        tomarkup +=
                                                "<span style='" +
                                                markleftrules[rule[0]] +
                                                ":" +
                                                rule[1].replace(/[;:]/g, "") +
                                                ";'>";
                                        lmk++;
                                }
                        });
                }
                //Text
                else {
                        old += newmarkup[i];
                        tomarkup += newmarkup[i];
                        for (i2 = 0; i2 < lmk; i2++) tomarkup += "</span>";
                        lmk = 0;
                }
        }
        protectedMarkups.forEach(([token, placeholder]) => {
                tomarkup = tomarkup.replaceAll(placeholder, token);
                old = old.replaceAll(placeholder, token);
        });
        //Shortcuts
        Object.keys(markuprules).forEach((markuprule) => {
                while (old.includes(markuprule))
                        old = old.replace(markuprule, "");
                var toggler = true;
                tomarkup = tomarkup.split(markuprule);
                endrule = markuprules[markuprule];
                if (endrule.includes(" "))
                        endrule = endrule.substring(0, endrule.indexOf(" "));
                for (ii = 0; ii < tomarkup.length; ii++) {
                        toggler = !toggler;
                        if (toggler)
                                tomarkup[ii] =
                                        "<" +
                                        markuprules[markuprule] +
                                        ">" +
                                        tomarkup[ii] +
                                        "</" +
                                        endrule +
                                        ">";
                }
                tomarkup = tomarkup.join("");
        });
        if (tomarkup.startsWith("&gt;"))
                tomarkup = "<font color='#789922'>" + tomarkup + "</font>";
        return { mtext: tomarkup, rtext: old };
}

function markUpName(name) {
        return markup(name.replace(/[\^%]/g, "").replace(/\\n/gi, ""));
}

module.exports.markup = markup;
module.exports.markUpName = markUpName;
