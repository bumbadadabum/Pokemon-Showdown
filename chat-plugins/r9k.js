/*
* Robot9000 mode chat plugin.
*
* For an explanation on what Robot9000 is, see <https://blog.xkcd.com/2008/01/14/robot9000-and-xkcd-signal-attacking-noise-in-chat/>
* This implementation of r9k mode is a variation of the original idea, trying to focus more on filtering often spammed messages, with a much smaller load on disk space and long-term RAM usage.
* Each chat message is converted into a sha1 checksum, which is then put in a temporary cache. When a message is repeated, and therefore triggers the r9k filter, it is moved into a permanent storage.
*
* Written by bumbadadabum.
*/

'use strict';

const FS = require('../fs');
const crypto = require('crypto');

const R9K_DIRECTORY = ('config/r9k');

class R9KCache {
	constructor() {
		this.caches = new Map();
	}

	init(room, checksums) {
		this.caches.set(room.id, new Set(checksums));
	}

	add(room, checksum) {
		if (!this.caches.has(room.id)) this.caches.set(room.id, new Set());
		this.caches.get(room.id).add(checksum);
	}

	has(room, checksum) {
		let cache = this.caches.get(room.id);
		return cache && cache.has(checksum);
	}
}

const tempCache = new R9KCache();
const permanentCache = new R9KCache();

function sha1(str) {
	 let generator = crypto.createHash('sha1');
	 generator.update(str);
	 return generator.digest('hex');
}

function checkR9k(user, room, message) {
	let checksum = sha1(toId(message));

	if (tempCache.has(room, checksum) || permanentCache.has(room, checksum)) {
		if (room.chatRoomData && !permanentCache.has(room, checksum)) {
			appendPermanent(room, checksum);
		}

		if (user.can('mute', null, room)) return;

		if (!room.r9kPunishments) room.r9kPunishments = new Map();
		let userid = toId(user);

		let muteTime = room.r9kPunishments.get(userid);

		if (!muteTime) {
			room.r9kPunishments.set(userid, 2);
			return 2;
		}

		muteTime *= 2;
		room.r9kPunishments.set(userid, muteTime);
		return muteTime;
	} else {
		tempCache.add(room, checksum);
		return 0;
	}
}

/**
 * @param {Room} room
 * @param {string} checksum
 */
async function loadPermanent(room) {
	let data = await FS(`${R9K_DIRECTORY}/${room.id}.txt`).readTextIfExists();
	data = data.split("\n").filter(val => val.length === 40);
	if (data.length) permanentCache.init(room, data);
}

/**
 * @param {Room} room
 * @param {string} checksum
 */
async function appendPermanent(room, checksum) {
	permanentCache.add(room, checksum);

	await prune();

	FS(`${R9K_DIRECTORY}/${room.id}.txt`).append(`${checksum}\n`);
}

async function prune() {
	let files = await FS(R9K_DIRECTORY).readdir();
	files = files.filter(file => file.endsWith('.txt') && !Rooms(file.split('.')[0]));
	for (let i = 0; i < files.length; i++) {
		FS(`${R9K_DIRECTORY}/${files[i]}`).unlinkIfExists();
	}
}

module.exports = {
	chatfilter: function (message, user, room) {
		if (room && room.r9k && !user.can('bypassall')) {
			let muteTime = checkR9k(user, room, message);
			if (muteTime) {
				room.mute(user, muteTime * 1000);
				this.errorReply(`Since Robot9000 mode is enabled in this room and the message you entered was not unique, you've been muted for ${muteTime} seconds.`);
				this.update();
				return false;
			}
		}
	},
	commands: {
		robot9000: 'r9k',
		r9k: function (target, room, user) {
			if (!target) {
				const r9k = (room.r9k ? "enabled" : "disabled");
				return this.sendReply(`Robot9000 mode is currently ${r9k}.`);
			}
			if (!this.canTalk()) return;
			if (!this.can('editroom', null, room)) return false;

			if (target === 'enable' || target === 'on' || target === 'true') {
				if (room.r9k) return this.errorReply(`Robot9000 mode is already enabled for this room`);
				if (!permanentCache.caches.has(room.id)) loadPermanent(room);
				room.r9k = true;
			} else if (target === 'disable' || target === 'off' || target === 'false') {
				if (!room.r9k) return this.errorReply(`Robot9000 mode is already disabled for this room`);
				room.r9k = false;
			} else {
				return this.parse("/help r9k");
			}
			const r9k = (room.r9k ? "on" : "off");
			this.add(`|raw|<div class="broadcast-red"><b>Robot9000 mode was turned ${r9k}!</b><br /><a href="https://blog.xkcd.com/2008/01/14/robot9000-and-xkcd-signal-attacking-noise-in-chat/">What is Robot9000?</a></div>`);
			this.privateModCommand(`(${user.name} turned Robot9000 mode ${r9k})`);

			if (room.chatRoomData) {
				room.chatRoomData.r9k = room.r9k;
				Rooms.global.writeChatRoomData();
			}
		},
		r9khelp: [
			"/r9k [on/off] - Turns Robot9000 mode on or off in the current room.",
		],
	},
};

setImmediate(() => {
	Rooms.rooms.forEach(room => {
		if (room.r9k) loadPermanent(room);
	});
});
