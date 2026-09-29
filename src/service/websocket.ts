import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/*
	The smallest WebSocket server the Studio plugin needs (spec 007): text
	messages both ways, ping/pong and close. Studio's
	HttpService:CreateWebStreamClient speaks RFC 6455 like any client; the
	measurement that settled this used the same framing (spec 007, M2).

	Written here rather than taken from a package so the service stays free of
	runtime dependencies that need their own bundling care (see build.mjs).
*/

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Larger messages are refused; the plugin only sends a few hundred bytes. */
const MAX_MESSAGE = 64 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WebSocketLink {
	send(text: string): void;
	close(): void;
	readonly open: boolean;
	onMessage: (text: string) => void;
	onClose: () => void;
}

function frame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	let head: Buffer;
	if (length < 126) head = Buffer.from([0x80 | opcode, length]);
	else if (length < 65536) {
		head = Buffer.alloc(4);
		head[0] = 0x80 | opcode;
		head[1] = 126;
		head.writeUInt16BE(length, 2);
	} else {
		head = Buffer.alloc(10);
		head[0] = 0x80 | opcode;
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([head, payload]);
}

/*
	Completes the handshake for an upgrade request and returns the link, or
	answers 400 and returns null when the request is not a WebSocket one.
*/
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): WebSocketLink | null {
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string" || (request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return null;
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

	let open = true;
	let buffer: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
	let fragments: Buffer[] = [];
	let fragmentsLength = 0;

	const finish = () => {
		if (!open) return;
		open = false;
		link.onClose();
	};
	const fail = () => {
		socket.destroy();
		finish();
	};

	const link: WebSocketLink = {
		get open() {
			return open;
		},
		send(text) {
			if (open) socket.write(frame(OP_TEXT, Buffer.from(text, "utf8")));
		},
		close() {
			if (!open) return;
			socket.end(frame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
			finish();
		},
		onMessage: () => undefined,
		onClose: () => undefined,
	};

	const consume = () => {
		while (buffer.length >= 2) {
			const fin = (buffer[0] & 0x80) !== 0;
			const opcode = buffer[0] & 0x0f;
			const masked = (buffer[1] & 0x80) !== 0;
			let length = buffer[1] & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) return;
				const big = buffer.readBigUInt64BE(2);
				if (big > BigInt(MAX_MESSAGE)) return fail();
				length = Number(big);
				offset = 10;
			}
			// Clients must mask (RFC 6455, 5.1); an unmasked frame is not from a WebSocket client.
			if (!masked || length > MAX_MESSAGE) return fail();
			const total = offset + 4 + length;
			if (buffer.length < total) return;
			const mask = buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(buffer.subarray(offset + 4, total));
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			buffer = buffer.subarray(total);

			if (opcode === OP_CLOSE) {
				if (open) socket.end(frame(OP_CLOSE, payload.subarray(0, 2)));
				return finish();
			}
			if (opcode === OP_PING) {
				socket.write(frame(OP_PONG, payload));
				continue;
			}
			if (opcode === OP_PONG) continue;
			if (opcode === OP_TEXT || opcode === OP_BINARY || opcode === OP_CONTINUATION) {
				if (opcode !== OP_CONTINUATION) {
					fragments = [];
					fragmentsLength = 0;
				}
				fragments.push(payload);
				fragmentsLength += payload.length;
				if (fragmentsLength > MAX_MESSAGE) return fail();
				if (!fin) continue;
				const text = Buffer.concat(fragments).toString("utf8");
				fragments = [];
				fragmentsLength = 0;
				try {
					link.onMessage(text);
				} catch {
					// a bad message is the handler's to report; the link stays up
				}
				continue;
			}
			return fail();
		}
	};

	socket.on("data", (chunk: Buffer) => {
		buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
		consume();
	});
	socket.on("close", finish);
	socket.on("error", finish);
	if (buffer.length > 0) queueMicrotask(consume);
	return link;
}
