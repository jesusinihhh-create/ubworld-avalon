// BonziWorld Fork server
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const socketio = require("socket.io");
const crypto = require("crypto");
const { spawn } = require("child_process");
const commands = require("./commands.cjs");

// The original archive assumed it was always launched from its own directory.
// Keep that behavior stable even when the workspace launches the package.
process.chdir(__dirname);

// Optional outbound notifications. Disabled by default so a fresh fork never
// sends chat content to a third party. Add comma-separated URLs only if you
// explicitly want this integration.
const webhooks = (process.env.DISCORD_WEBHOOK_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
let uptime = 0;
const whitelist = commands.whitelist;
setInterval(() => {
	uptime++;
	Object.keys(rooms).forEach((room) => {
		rooms[room].reg++;
		Object.keys(rooms[room].users).forEach((user) => {
			rooms[room].users[user].public.joined++;
			//rooms[room].emit("update", room[room].users[user].public)
		});
	});
}, 60000);

let blacklist = [
	"a84e8gj49an49fja9wutjwe949",
];
function checkBlacklist(param) {
let bad = false;
	blacklist.forEach((badword) => {
		if (param.toLowerCase().includes(badword.toLowerCase())) bad = true;
	});
	return bad;
}

//Read settings (READER IN COMMANDS LIBRARY)
const config = commands.config;
const colors = commands.colors;
const markup = commands.markup;
const markUpName = commands.markUpName;

commands.vpncache = fs
	.readFileSync("./config/vpncache.txt")
	.toString()
	.split("\n")
	.map((e) => {
		return e.split("/");
	});
function isVPN(ip) {
	let x = 0;
	commands.vpncache.forEach((e) => {
		if (e[0] == ip && e[1] == "true") x = 2;
		else if (e[0] == ip) x = 1;
	});
	return x;
}

//IP info
const ipinfo = {};
const roleCredentialSecret = process.env.SESSION_SECRET || "";

function roleTokenHash(token) {
	return crypto.createHash("sha256").update(token).digest("hex");
}

function issueRoleCredential(level, tokenHash) {
	if (!roleCredentialSecret || !tokenHash) return "";
	const payload =
		level + "." + tokenHash + "." + crypto.randomBytes(16).toString("hex");
	const signature = crypto
		.createHmac("sha256", roleCredentialSecret)
		.update(payload)
		.digest("hex");
	return Buffer.from(payload + "." + signature).toString("base64url");
}

function verifyRoleCredential(credential, tokenHash) {
	try {
		if (!roleCredentialSecret || !tokenHash || typeof credential != "string")
			return 0;
		const decoded = Buffer.from(credential, "base64url").toString("utf8");
		const parts = decoded.split(".");
		if (parts.length != 4) return 0;
		const level = Number(parts[0]);
		if (
    (level != 2 && level != 3 && level != 5) ||
			parts[1] != tokenHash ||
			!/^[a-f0-9]{32}$/.test(parts[2]) ||
			!/^[a-f0-9]{64}$/.test(parts[3])
		)
			return 0;
		const expected = crypto
			.createHmac("sha256", roleCredentialSecret)
			.update(parts.slice(0, 3).join("."))
			.digest("hex");
		return crypto.timingSafeEqual(
			Buffer.from(parts[3], "hex"),
			Buffer.from(expected, "hex"),
		)
			? level
			: 0;
	} catch {
		return 0;
	}
}

function arrCount(a, b) {
	let c = 0;
	a.forEach((d) => {
		if (d == b) c++;
	});
	return c;
}

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

function bancheck(ip) {
	const address = String(ip || "").split(",")[0].trim();
	const key = address.includes(":")
		? ipToInt(address) >> BigInt(64)
		: address;
	for (let i = 0; i < commands.bans.length; i++) {
		if (commands.bans[i] === key) {
			return {
				reason: commands.reasons[i] || "Permanent ban",
				expiresAt: 0,
			};
		}
	}

	const now = Date.now();
	const activeTempBans = commands.tempbans.filter(
		(ban) => Number(ban.expiresAt) > now,
	);
	if (activeTempBans.length !== commands.tempbans.length) {
		commands.tempbans = activeTempBans;
		fs.writeFileSync(
			path.join(__dirname, "config", "tempbans.json"),
			JSON.stringify(activeTempBans, null, 2) + "\n",
		);
	}
	const temporaryBan = activeTempBans.find((ban) => {
		const banAddress = String(ban.address || "").split(",")[0].trim();
		const banKey = banAddress.includes(":")
			? ipToInt(banAddress) >> BigInt(64)
			: banAddress;
		return banKey === key;
	});
	return temporaryBan
		? { reason: temporaryBan.reason, expiresAt: temporaryBan.expiresAt }
		: null;
}

function canvasBancheck(ip) {
	const address = String(ip || "").split(",")[0].trim();
	const key = address.includes(":")
		? ipToInt(address) >> BigInt(64)
		: address;
	const canvasBan = (commands.canvasbans || []).find((ban) => {
		const bannedAddress = String(ban.address || "").split(",")[0].trim();
		const bannedKey = bannedAddress.includes(":")
			? ipToInt(bannedAddress) >> BigInt(64)
			: bannedAddress;
		return bannedKey === key;
	});
	return canvasBan || null;
}

commands.bans = fs
	.readFileSync("./config/bans.txt")
	.toString()
	.split("\n")
	.map((e) => {
		return e.split("/")[0];
	})
	.map((e) => {
		if (e.includes(":")) return ipToInt(e) >> BigInt(64);
		else return e;
	});
commands.reasons = fs
	.readFileSync("./config/bans.txt")
	.toString()
	.split("\n")
	.map((e) => {
		return e.split("/")[1];
	});
try {
	commands.tempbans = JSON.parse(
		fs.readFileSync(path.join(__dirname, "config", "tempbans.json")),
	).filter(
		(ban) =>
			ban &&
			typeof ban.address == "string" &&
			Number(ban.expiresAt) > Date.now() &&
			typeof ban.reason == "string",
	);
} catch {
	commands.tempbans = [];
}

//HTTP Server
const app = express();
app.use((req, res, next) => {
	const address = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
	if (req.path === "/401.html" || !canvasBancheck(address)) return next();
	res.status(401).sendFile(path.join(__dirname, "client", "401.html"));
});

const errorPages = {
	"/400.html": { status: 400, file: "400.html" },
	"/404.html": { status: 404, file: "404.html" },
	"/500.html": { status: 500, file: "500.html" },
	"/502.html": { status: 502, file: "502.html" },
	"/503.html": { status: 503, file: "503.html" },
};
app.get(Object.keys(errorPages), (req, res) => {
	const page = errorPages[req.path];
	res.status(page.status).sendFile(path.join(__dirname, "client", page.file));
});

app.get("/download-source.tar.gz", (req, res) => {
res.setHeader("content-type", "application/gzip");
res.setHeader(
"content-disposition",
'attachment; filename="bonziworld-fork-source.tar.gz"',
);
const archive = spawn(
"tar",
[
"-czf",
"-",
"--exclude=./node_modules",
"--exclude=./dist",
"--exclude=./data",
"--exclude=./.env",
"--exclude=./.env.*",
".",
],
{ cwd: __dirname },
);
archive.stdout.pipe(res);
archive.on("error", (error) => {
if (!res.headersSent) res.status(500).send("Unable to create source archive.");
else res.destroy(error);
});
archive.on("close", (code) => {
if (code !== 0 && !res.writableEnded) res.destroy();
});
req.on("close", () => {
if (!res.writableEnded) archive.kill();
});
});

//Statistics
app.use("/stats", (req, res, next) => {
	res.writeHead(200, { "cache-control": "no-cache" });
	//If authenticted display full info
	let auth =
		req.query.auth == undefined
			? ""
			: crypto.createHash("sha256").update(req.query.auth).digest("hex");
	if (
		req.query.room == undefined &&
		(config.godword == auth ||
			config.kingwords.includes(auth) ||
			config.lowkingwords.includes(auth))
	) {
		let roomobj = {};
		Object.keys(rooms).forEach((room) => {
			roomobj[room] = {
				members: Object.keys(rooms[room].users).length,
				owner:
					rooms[room].users[rooms[room].ownerID] == undefined
						? { id: 0 }
						: rooms[room].users[rooms[room].ownerID].public,
				uptime: rooms[room].reg,
				logins: rooms[room].loginCount,
				messages: rooms[room].msgsSent,
			};
		});
		res.write(JSON.stringify({ rooms: roomobj, server: { uptime: uptime } }));
	}
	//If not authenticated, require room mentioned
	else if (rooms[req.query.room] == undefined)
		res.write(JSON.stringify({ error: true }));
	else
		res.write(
			JSON.stringify({
				members: Object.keys(rooms[req.query.room].users).length,
				owner:
					rooms[req.query.room].users[rooms[req.query.room].ownerID] ==
					undefined
						? { id: 0 }
						: rooms[req.query.room].users[rooms[req.query.room].ownerID].public,
				uptime: rooms[req.query.room].reg,
			}),
		);
	res.end();
	return;
});
const fontAwesomeRoot = path.dirname(
	path.dirname(require.resolve("@fortawesome/fontawesome-free/css/all.min.css")),
);
app.use("/fontawesome", express.static(fontAwesomeRoot));
app.use(express.static(path.join(__dirname, "client")));
app.use("/img/hats", express.static(path.join(__dirname, "client", "img", "hats")));
app.use((req, res) => {
	res.status(404).sendFile(path.join(__dirname, "client", "404.html"));
});
const server = http.Server(app);
const port = Number(process.env.PORT || config.port || 3000);
server.listen(port);

//Socket.io Server
const io = socketio(server, {
cors: { origin: true },
	pingInterval: 3000,
	pingTimeout: 7000,
});
var currentalert = "";
var alertusers = false;
io.on("connection", (socket) => {
	socket.spams = 0;

	socket.ip = "127.0.0.1";
	//var wait = ratelimit;
	if (socket.handshake.headers["x-forwarded-for"] !== undefined) {
		socket.ip = socket.handshake.headers["x-forwarded-for"]
			.split(",")[0]
			.trim();
	}

	console.log(socket.ip);
	const canvasBan = canvasBancheck(socket.ip);
	if (canvasBan) {
		socket.emit("canvasban", {
			bannedby: canvasBan.bannedBy || "Pope",
			ip: socket.ip,
			reason: canvasBan.reason || "401 Unauthorized",
		});
		socket.disconnect();
		return;
	}
	//socket.ip = socket.handshake.address;
	const activeBan = bancheck(socket.ip);
	if (activeBan) {
		commands.bancount++;
		socket.emit("ban", {
			ip: socket.ip,
			bannedby: "UNKNOWN",
			reason: activeBan.reason,
			expiresAt: activeBan.expiresAt,
		});
		socket.disconnect();
		return;
	}
	//ANTIFLOOD
	/*
	if(socket.handshake.headers["referer"] == undefined ||socket.handshake.headers["user-agent"] == undefined){
		//fs.appendFileSync("./config/bans.txt", socket.ip+"/BOT DETECTED\n");
		//bans.push(socket.ip);
		socket.disconnect();
		return;
	}*/
	if (ipinfo[socket.ip] == undefined) ipinfo[socket.ip] = { count: 0 };
	if (ipinfo[socket.ip].count >= config.clientlimit) {
		socket.disconnect();
		return;
	}
	ipinfo[socket.ip].count++;

	//IP info on disconnect
	socket.on("disconnect", () => {
		ipinfo[socket.ip].count--;
	});

	socket.onAny((a, b) => {
		//console.log(a+" "+ b);
		socket.spams++;
		if (socket.spams >= 200) {
			socket.disconnect();
		}
	});
	setInterval(() => {
		socket.spams = 0;
	}, 10000);
	//Join
	new user(socket);
});

console.log("BonziWorld Fork server listening on port " + port);

//GUID Generator
function guidgen() {
	let guid = Math.round(Math.random() * 999999998 + 1).toString();
	while (guid.length < 9) guid = "0" + guid;
	// Validate against the GUID strings already present in every room.
	const usedGuids = new Set();
	Object.values(rooms).forEach((room) => {
		Object.values(room.users).forEach((user) => {
			if (user && user.public && user.public.guid) {
				usedGuids.add(user.public.guid);
			}
		});
	});
	while (usedGuids.has(guid)) {
		guid = Math.round(Math.random() * 999999999).toString();
		while (guid.length < 9) guid = "0" + guid;
	}
	return guid;
}

function roleForLevel(level) {
return level >= 4
		? "pope"
		: level === 3
			? "high-king"
			: level === 2
				? "low-king"
				: "";
}

//Rooms
class room {
	constructor(name, owner, priv) {
		this.name = name;
		this.users = {};
		this.usersPublic = {};
		this.ownerID = owner;
		this.private = priv;
		this.reg = 0;
		this.msgsSent = 0;
		this.cmdsSent = 0;
		this.loginCount = 0;
		this.byoutube = {
			videoId: "",
			locked: false,
		};
		this.royalLog = [];
	}
	emit(event, content) {
		Object.keys(this.users).forEach((user) => {
			this.users[user].socket.emit(event, content);
		});
	}
}

//Make a room, make rooms available to commands
const rooms = {
	default: new room("default", 0, false),
	desanitize: new room("desanitize", 0, false),
};
commands.rooms = rooms;

//Client
class user {
	constructor(socket) {
		this.socket = socket;
		this.loggedin = false;
		this.level = 0;
		this.roleTokenHash = "";
		this.roleCredential = "";
		this.sanitize = "true";
		this.slowed = false;
		this.spamlimit = 0;
		this.lastmsg = "";
		//0 = none, 1 = yes, 2 = no
		this.vote = 0;
		this.hats = [];

		//Login handler
		if (alertusers == true) this.socket.emit("alert", { alert: currentalert });
		this.socket.on("login", (logindata) => {
			if (!commands.vpnLocked || isVPN(socket.ip) == 1) this.login(logindata);
			else {
				if (isVPN(socket.ip) == 2)
					this.socket.emit(
						"error",
						"PLEASE TURN OFF YOUR VPN (Temporary VPN Block)",
					);
				else {
					if (socket.connected) this.login(logindata);
				}
			}
		});
	}

	login(logindata) {
		if (this.loggedin) return;
		//Data validation and sanitization
		if (ipinfo[this.socket.ip].clientslowmode) {
			this.socket.emit("error", "Please wait 10 seconds before joining again.");
			return;
		} else if (logindata.color == undefined) logindata.color = "";
		if (
			typeof logindata != "object" ||
			typeof logindata.name != "string" ||
			typeof logindata.color != "string" ||
			typeof logindata.room != "string" ||
			(logindata.roleToken != undefined &&
				typeof logindata.roleToken != "string") ||
			(logindata.roleCredential != undefined &&
				typeof logindata.roleCredential != "string")
		) {
			this.socket.emit("error", "TYPE ERROR: INVALID DATA TYPE SENT.");
			return;
		}

		ipinfo[this.socket.ip].clientslowmode = true;
		setTimeout(() => {
			ipinfo[this.socket.ip].clientslowmode = false;
		}, config.clientslowmode);

		if (logindata.room == "desanitize") this.sanitize = false;
		logindata.name = sanitize(logindata.name);
		if (logindata.name.length > config.maxname) {
			this.socket.emit("error", "Name too long. Change your name.");
			return;
		}
		logindata.name = markUpName(logindata.name);

		//Setup
		this.loggedin = true;
		if (
			typeof logindata.roleToken == "string" &&
			logindata.roleToken.length >= 16 &&
			logindata.roleToken.length <= 128
		) {
			this.roleTokenHash = roleTokenHash(logindata.roleToken);
			this.roleCredential =
				typeof logindata.roleCredential == "string"
					? logindata.roleCredential
					: "";
			this.level = verifyRoleCredential(
				this.roleCredential,
				this.roleTokenHash,
			);
		}
		if (logindata.room.replace(/ /g, "") == "") logindata.room = "default";
		if (logindata.name.rtext.replace(/ /g, "") == "")
			logindata.name = markUpName(config.defname);
		if (commands.ccblacklist.includes(+logindata.color))
			logindata.color = ""; // <---- proxylink + logindata.color usually goes here, add it back LATER!!!!
		else if (logindata.color.startsWith("http"))
			logindata.color = sanitize(logindata.color).replace(/&amp;/g, "&"); // <---- proxylink + logindata.color usually goes here, add it back LATER!!!!
		else logindata.color = logindata.color.toLowerCase();
		if (logindata.color.startsWith("https://")) {
			if (!whitelist.some((ccurl) => logindata.color.startsWith(ccurl + "/"))) {
				logindata.color = colors[Math.floor(Math.random() * colors.length)];
			}
		}
		this.public = {
			guid: guidgen(),
			name: logindata.name.rtext,
			dispname: logindata.name.mtext,
			role: "",
			color:
				colors.includes(logindata.color) || logindata.color.startsWith("http")
					? logindata.color
					: colors[Math.floor(Math.random() * colors.length)],
			tagged: false,
			locked: false,
			muted: false,
			tag: "",
			voice: {
				pitch: 15 + Math.round(Math.random() * 110),
				speed: 125 + Math.round(Math.random() * 150),
				wordgap: 0,
			},
			typing: "",
			joined: 0,
			hats: this.hats
		};
		//Join room
		if (rooms[logindata.room] == undefined) {
			rooms[logindata.room] = new room(logindata.room, this.public.guid, true);
			if (this.level < 2) this.level = 1;
		}
		this.public.role = roleForLevel(this.level);
		rooms[logindata.room].emit("join", this.public);
		this.room = rooms[logindata.room];
		this.room.usersPublic[this.public.guid] = this.public;
		this.room.users[this.public.guid] = this;
		this.setPermanentRole = (level) => {
			if (!this.roleTokenHash) return;
 if (level === 2 || level === 3 || level === 5) {
				const credential = issueRoleCredential(level, this.roleTokenHash);
				if (!credential) return;
				this.roleCredential = credential;
				this.socket.emit("role_credential", { credential });
			} else {
				this.roleCredential = "";
				this.socket.emit("role_credential", { credential: "" });
			}
		};

		//Tell client to start
		this.socket.emit("login", {
guid: this.public.guid,
			roomname: logindata.room,
			roompriv: this.room.private,
			owner: this.public.guid == this.room.ownerID,
			users: this.room.usersPublic,
			level: this.level,
			byoutube: this.room.byoutube,
			royalLog: this.room.royalLog,
		});

		if (logindata.room == "default")
			webhooksay(
				"SERVER",
				"https://bonziworld-avalon.onrender.com/profiles/avalon.png",
				this.public.name + " HAS JOINED BONZIWORLD!",
			);
		commands.lip = this.socket.ip;
		this.room.loginCount++;
		//Talk handler
		this.socket.on("alert", (alrt) => {
			if (this.level > 2) {
				if (alrt == "off") {
					alertusers = false;
				} else {
					alertusers = true;
					currentalert = alrt;
				}

				if (alertusers == true) {
					this.room.emit("alert", { alert: currentalert });
				}
			}
		});
		this.socket.on("talk", (text) => {
			try {
const sanitizingEnabled = commands.sanitizeEnabled !== false;
				if (
					typeof text != "string" ||
(markup(text).rtext.replace(/ /g, "") == "" &&
sanitizingEnabled &&
this.sanitize) ||
					this.slowed ||
					this.public.muted
				)
					return;
text = sanitizingEnabled && this.sanitize
					? sanitize(
							text
								.replace(/{NAME}/g, this.public.name)
								.replace(/{COLOR}/g, this.public.color),
						)
					: text;
if (
text.length > config.maxmessage &&
sanitizingEnabled &&
this.sanitize
)
return;
				text = text.trim();
				if (
					text.substring(0, 10) == this.lastmsg.substring(0, 10) ||
					text.substring(text.length - 10, text.length) ==
						this.lastmsg.substring(
							this.lastmsg.length - 10,
							this.lastmsg.length,
						)
				)
					this.spamlimit++;
				else this.spamlimit = 0;
				if (this.spamlimit >= config.spamlimit) return;
				this.lastmsg = text;
				this.slowed = true;
				setTimeout(() => {
					this.slowed = false;
				}, config.slowmode);
				if (text.includes("https://windows93.net/trollbox") && this.level < 2) {
					var b = "Trollbox Retard";
					this.public.name = b;
					this.public.dispname = b;
					this.public.tag = b;
					this.public.color = "windows93";
					this.room.emit("update", this.public);
				}
				text = markup(text);
				if (this.smute) {
					this.socket.emit("talk", {
						text: text.mtext,
						say: text.rtext,
						guid: this.public.guid,
					});
					return;
				}

				//Webhook say
				if (this.room.name == "default") {
					let mmm = text.rtext.replace(/@/g, "#").split(" ");
					let mmm2 = [];
					mmm.forEach((m) => {
						if (
							m.replace(/[^abcdefghijklmnopqrstuvwxyz.]/gi, "").includes("...")
						)
							mmm2.push("127.0.0.1");
						else mmm2.push(m);
					});
					let mmm3 = mmm2.join(" ");
					let avatar = this.public.color.startsWith("http")
						? "https://bonziworld-avalon.onrender.com/profiles/crosscolor.png"
						: "https://bonziworld-avalon.onrender.com/profiles/" + this.public.color + ".png";
					webhooksay(this.public.name, avatar, mmm3);
				}
				//Room say
				this.room.emit("talk", {
					text: text.mtext,
					say: text.rtext,
					guid: this.public.guid,
				});
				this.room.msgsSent++;
			} catch (exc) {
				this.room.emit("announce", {
					title: "ERROR",
					html: `
									<h1>MUST REPORT TO MAX!</h1>
									Send max a screenshot of this: ${sanitize(exc)}`,
				});
			}
		});

		//Command handler
		this.socket.on("command", (comd) => {
			try {
const sanitizingEnabled = commands.sanitizeEnabled !== false;
				if (typeof comd != "object") return;
				if (comd.command == "hail") comd.command = "hail";
				else if (comd.command == "crosscolor" || comd.command == "colour")
					comd.command = "color";
				if (typeof comd.param != "string") comd.param = "";
				if (
					typeof commands.commands[comd.command] != "function" ||
					this.slowed ||
					this.public.muted ||
					comd.param.length > 10000 ||
					this.smute
				)
					return;
				if (
(comd.param.length > config.maxmessage &&
sanitizingEnabled &&
this.sanitize) ||
					(config.runlevels[comd.command] != undefined &&
						this.level < config.runlevels[comd.command])
				)
					return;
				this.slowed = true;
				setTimeout(() => {
					this.slowed = false;
				}, config.slowmode);
				comd.param = comd.param
					.replace(/{NAME}/g, this.public.name)
					.replace(/{COLOR}/g, this.public.color);

				if (this.lastmsg == comd.command) this.spamlimit++;
				else this.spamlimit = 0;
				if (this.spamlimit >= config.spamlimit && comd.command != "vote")
					return;
				this.lastmsg = comd.command;

				commands.commands[comd.command](
					this,
sanitizingEnabled && this.sanitize
? sanitize(comd.param)
: comd.param,
				);
				this.room.cmdsSent++;
			} catch (exc) {
				this.room.emit("announce", {
					title: "ERROR",
					html: `
					<h1>MUST REPORT TO STAFF/KINGS!</h1>
					Send staff and/or kings a screenshot of this: ${sanitize(exc.toString())}`,
				});
			}
		});

		//Leave handler
		this.socket.on("disconnect", () => {
			if (this.room.name == "default")
				webhooksay(
					"SERVER",
					"https://bonziworld-avalon.onrender.com/profiles/avalon.png",
					this.public.name + " HAS LEFT!",
				);
			this.room.emit("leave", this.public.guid);
			delete this.room.usersPublic[this.public.guid];
			delete this.room.users[this.public.guid];
			if (Object.keys(this.room.users).length <= 0 && this.room.private)
				delete rooms[this.room.name];
			//Transfer ownership
			else if (this.room.ownerID == this.public.guid) {
				this.room.ownerID =
					this.room.usersPublic[Object.keys(this.room.usersPublic)[0]].guid;
				this.room.users[this.room.ownerID].level = 1;
				this.room.users[this.room.ownerID].socket.emit("update_self", {
					level: this.room.users[this.room.ownerID].level,
					roomowner: true,
				});
			}
		});

		//Check if user typing
		this.socket.on("typing", (state) => {
			if (this.public.muted || typeof state != "number") return;
			let lt = this.public.typing;
			if (state == 2) this.public.typing = "<br>(commanding)";
			else if (state == 1) this.public.typing = "<br>(typing)";
			else this.public.typing = "";
			if (this.public.typing != lt) this.room.emit("update", this.public);
		});
	}
}

function sanitize(text) {
	//Return undefined if no param. Return sanitized if param exists.
	if (text == undefined) return undefined;
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		.replace(/\[/g, "&lbrack;");
}

function desanitize(text) {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lbrack;/g, "[");
}

function webhooksay(name, avatar, msg) {
if (webhooks.length === 0) return;
	if (msg.includes("http://") || msg.includes("https://")) return;
	msg = desanitize(msg);
	webhooks.forEach((url) => {
		//Send message to pisscord
		let postreq = require("https").request({
			method: "POST",
			host: "discord.com",
			path: url,
			port: 443,
			headers: {
				"content-type": "application/json",
			},
		});
		postreq.write(
			JSON.stringify({
				username: name,
				content: msg.replace(/@/g, "#"),
				avatar_url: avatar,
			}),
		);
		postreq.end();
		postreq.on("error", (e) => {
			console.log("failed");
		});
	});
}
