import assert from "node:assert";
import { describe, it } from "node:test";
import {
	allocateImageId,
	encodeITerm2,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	imageFallback,
} from "../src/terminal-image.ts";

/**
 * Coverage for the pure byte-buffer image dimension parsers and helpers in
 * terminal-image.ts. The existing terminal-image.test.ts covers isImageLine,
 * detectCapabilities, hyperlink, encodeKitty, renderImage, delete/deleteAll
 * Kitty images, setCapabilities/setCellDimensions. These tests cover the
 * dimension parsers + encodeITerm2 + allocateImageId + imageFallback, which
 * are NOT covered by the existing file.
 */

// Minimal valid fixture builders. Buffers are passed to the parsers as base64
// strings (the public API surface).

function pngBuffer(width: number, height: number): Buffer {
	// PNG: 8-byte signature, then IHDR chunk with 4-byte width + 4-byte height (BE).
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	// length (4) + type "IHDR" (4) + data + crc (4)
	const type = Buffer.from("IHDR", "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(ihdrData.length, 0);
	const crc = Buffer.alloc(4); // parsers don't validate CRC
	return Buffer.concat([sig, length, type, ihdrData, crc]);
}

function gifBuffer(width: number, height: number): Buffer {
	const sig = Buffer.from("GIF89a", "ascii");
	const dims = Buffer.alloc(4);
	dims.writeUInt16LE(width, 0);
	dims.writeUInt16LE(height, 2);
	// Trailing bytes to reach the minimum 10-byte header.
	const trailer = Buffer.alloc(4);
	return Buffer.concat([sig, dims, trailer]);
}

function jpegSofBuffer(width: number, height: number): Buffer {
	// SOI
	const soi = Buffer.from([0xff, 0xd8]);
	// A SOS-less minimal stream: SOF0 marker (0xFFC0) with height/width.
	// SOF0 segment: length (2 BE) + precision (1) + height (2 BE) + width (2 BE) + components...
	const sofData = Buffer.alloc(8);
	sofData.writeUInt16BE(6, 0); // length = 6+2 bytes after, but length field counts itself
	sofData[2] = 8; // precision
	sofData.writeUInt16BE(height, 3);
	sofData.writeUInt16BE(width, 5);
	const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), sofData]);
	return Buffer.concat([soi, sof]);
}

function webpVp8xBuffer(width: number, height: number): Buffer {
	const riff = Buffer.from("RIFF", "ascii");
	const size = Buffer.alloc(4); // file size placeholder
	const webp = Buffer.from("WEBP", "ascii");
	const chunk = Buffer.from("VP8X", "ascii");
	const chunkSize = Buffer.alloc(4);
	chunkSize.writeUInt32LE(10, 0);
	const flags = Buffer.alloc(10); // flags + reserved, then canvas w/h as 3-byte LE each
	// VP8X stores width-1 and height-1 as 24-bit LE.
	flags[4] = (width - 1) & 0xff;
	flags[5] = ((width - 1) >> 8) & 0xff;
	flags[6] = ((width - 1) >> 16) & 0xff;
	flags[7] = (height - 1) & 0xff;
	flags[8] = ((height - 1) >> 8) & 0xff;
	flags[9] = ((height - 1) >> 16) & 0xff;
	return Buffer.concat([riff, size, webp, chunk, chunkSize, flags]);
}

function toBase64(buffer: Buffer): string {
	return buffer.toString("base64");
}

describe("getPngDimensions", () => {
	it("parses a minimal valid PNG IHDR", () => {
		const dims = getPngDimensions(toBase64(pngBuffer(800, 600)));
		assert.deepStrictEqual(dims, { widthPx: 800, heightPx: 600 });
	});

	it("parses a 1x1 PNG", () => {
		const dims = getPngDimensions(toBase64(pngBuffer(1, 1)));
		assert.deepStrictEqual(dims, { widthPx: 1, heightPx: 1 });
	});

	it("returns null for a buffer shorter than 24 bytes", () => {
		const short = Buffer.alloc(20, 0);
		assert.strictEqual(getPngDimensions(toBase64(short)), null);
	});

	it("returns null for a buffer with a wrong magic number", () => {
		const fake = Buffer.alloc(24, 0);
		fake[0] = 0x00;
		assert.strictEqual(getPngDimensions(toBase64(fake)), null);
	});

	it("returns null for empty input", () => {
		assert.strictEqual(getPngDimensions(""), null);
	});

	it("returns null for invalid base64 that decodes to nothing usable", () => {
		assert.strictEqual(getPngDimensions("!!!notbase64!!!"), null);
	});
});

describe("getGifDimensions", () => {
	it("parses a GIF89a header", () => {
		const dims = getGifDimensions(toBase64(gifBuffer(320, 240)));
		assert.deepStrictEqual(dims, { widthPx: 320, heightPx: 240 });
	});

	it("parses a GIF87a header", () => {
		const sig = Buffer.from("GIF87a", "ascii");
		const dims = Buffer.alloc(4);
		dims.writeUInt16LE(100, 0);
		dims.writeUInt16LE(50, 2);
		const buf = Buffer.concat([sig, dims, Buffer.alloc(4)]);
		assert.deepStrictEqual(getGifDimensions(toBase64(buf)), { widthPx: 100, heightPx: 50 });
	});

	it("returns null for a buffer shorter than 10 bytes", () => {
		assert.strictEqual(getGifDimensions(toBase64(Buffer.alloc(5))), null);
	});

	it("returns null for a wrong signature", () => {
		const fake = Buffer.from("NOTGIF", "ascii");
		const buf = Buffer.concat([fake, Buffer.alloc(4)]);
		assert.strictEqual(getGifDimensions(toBase64(buf)), null);
	});

	it("returns null for empty input", () => {
		assert.strictEqual(getGifDimensions(""), null);
	});
});

describe("getJpegDimensions", () => {
	it("parses an SOF0 frame to extract width and height", () => {
		const dims = getJpegDimensions(toBase64(jpegSofBuffer(640, 480)));
		assert.deepStrictEqual(dims, { widthPx: 640, heightPx: 480 });
	});

	it("returns null for a buffer without the JPEG SOI marker", () => {
		const fake = Buffer.alloc(20, 0x41);
		assert.strictEqual(getJpegDimensions(toBase64(fake)), null);
	});

	it("returns null for a JPEG with no SOF marker", () => {
		// SOI only, nothing else.
		const buf = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
		assert.strictEqual(getJpegDimensions(toBase64(buf)), null);
	});

	it("returns null for empty input", () => {
		assert.strictEqual(getJpegDimensions(""), null);
	});

	it("returns null for a too-short buffer", () => {
		assert.strictEqual(getJpegDimensions(toBase64(Buffer.from([0xff, 0xd8]))), null);
	});
});

describe("getWebpDimensions", () => {
	it("parses a VP8X (extended) WebP", () => {
		const dims = getWebpDimensions(toBase64(webpVp8xBuffer(1280, 720)));
		assert.deepStrictEqual(dims, { widthPx: 1280, heightPx: 720 });
	});

	it("parses a 1x1 VP8X WebP", () => {
		const dims = getWebpDimensions(toBase64(webpVp8xBuffer(1, 1)));
		assert.deepStrictEqual(dims, { widthPx: 1, heightPx: 1 });
	});

	it("returns null for a buffer with a wrong RIFF magic", () => {
		const fake = Buffer.alloc(30, 0);
		assert.strictEqual(getWebpDimensions(toBase64(fake)), null);
	});

	it("returns null for a RIFF file that is not a WebP", () => {
		const riff = Buffer.from("RIFF", "ascii");
		const size = Buffer.alloc(4);
		const wave = Buffer.from("WAVE", "ascii");
		const buf = Buffer.concat([riff, size, wave, Buffer.alloc(20)]);
		assert.strictEqual(getWebpDimensions(toBase64(buf)), null);
	});

	it("returns null for a WebP with an unknown chunk type", () => {
		const riff = Buffer.from("RIFF", "ascii");
		const size = Buffer.alloc(4);
		const webp = Buffer.from("WEBP", "ascii");
		const chunk = Buffer.from("XXXX", "ascii");
		const buf = Buffer.concat([riff, size, webp, chunk, Buffer.alloc(20)]);
		assert.strictEqual(getWebpDimensions(toBase64(buf)), null);
	});

	it("returns null for empty input", () => {
		assert.strictEqual(getWebpDimensions(""), null);
	});

	it("returns null for a too-short buffer", () => {
		assert.strictEqual(getWebpDimensions(toBase64(Buffer.alloc(10))), null);
	});
});

describe("getImageDimensions (dispatcher)", () => {
	it("dispatches to getPngDimensions for image/png", () => {
		assert.deepStrictEqual(getImageDimensions(toBase64(pngBuffer(10, 20)), "image/png"), {
			widthPx: 10,
			heightPx: 20,
		});
	});

	it("dispatches to getJpegDimensions for image/jpeg", () => {
		assert.deepStrictEqual(getImageDimensions(toBase64(jpegSofBuffer(30, 40)), "image/jpeg"), {
			widthPx: 30,
			heightPx: 40,
		});
	});

	it("dispatches to getGifDimensions for image/gif", () => {
		assert.deepStrictEqual(getImageDimensions(toBase64(gifBuffer(50, 60)), "image/gif"), {
			widthPx: 50,
			heightPx: 60,
		});
	});

	it("dispatches to getWebpDimensions for image/webp", () => {
		assert.deepStrictEqual(getImageDimensions(toBase64(webpVp8xBuffer(70, 80)), "image/webp"), {
			widthPx: 70,
			heightPx: 80,
		});
	});

	it("returns null for an unsupported mime type", () => {
		assert.strictEqual(getImageDimensions(toBase64(pngBuffer(1, 1)), "image/bmp"), null);
		assert.strictEqual(getImageDimensions(toBase64(pngBuffer(1, 1)), "image/tiff"), null);
	});

	it("returns null for a supported mime type but malformed buffer", () => {
		assert.strictEqual(getImageDimensions(toBase64(Buffer.alloc(5)), "image/png"), null);
	});
});

describe("allocateImageId", () => {
	it("returns a positive integer in the valid Kitty id range", () => {
		const id = allocateImageId();
		assert.strictEqual(typeof id, "number");
		assert.ok(Number.isInteger(id), "id should be an integer");
		assert.ok(id >= 1, `id should be >= 1, got ${id}`);
		assert.ok(id <= 0xffffffff, `id should be <= 0xffffffff, got ${id}`);
	});

	it("returns potentially different ids across calls (random)", () => {
		// Probabilistic: allocateImageId draws from a 32-bit range. With only 50
		// draws, a birthday-paradox collision is astronomically unlikely
		// (~50² / (2·2³²) ≈ 3e-7) but not strictly impossible. The assertion
		// only requires at least two distinct ids (`size > 1`), which holds as
		// long as not every draw coincidentally lands on the same value.
		const ids = new Set<number>();
		for (let i = 0; i < 50; i++) {
			ids.add(allocateImageId());
		}
		assert.ok(ids.size > 1, "allocateImageId should produce varied ids across calls");
	});

	it("never returns zero", () => {
		for (let i = 0; i < 100; i++) {
			assert.notStrictEqual(allocateImageId(), 0);
		}
	});
});

describe("imageFallback", () => {
	it("renders a fallback with mime type only when nothing else is provided", () => {
		assert.strictEqual(imageFallback("image/png"), "[Image: [image/png]]");
	});

	it("includes the filename when provided", () => {
		assert.strictEqual(imageFallback("image/png", undefined, "photo.png"), "[Image: photo.png [image/png]]");
	});

	it("includes dimensions when provided", () => {
		assert.strictEqual(imageFallback("image/jpeg", { widthPx: 640, heightPx: 480 }), "[Image: [image/jpeg] 640x480]");
	});

	it("includes filename, mime type, and dimensions together", () => {
		assert.strictEqual(
			imageFallback("image/gif", { widthPx: 100, heightPx: 100 }, "anim.gif"),
			"[Image: anim.gif [image/gif] 100x100]",
		);
	});

	it("works for unsupported mime types (error path)", () => {
		assert.strictEqual(imageFallback("image/bmp"), "[Image: [image/bmp]]");
		assert.strictEqual(
			imageFallback("image/tiff", { widthPx: 2, heightPx: 2 }, "x.tif"),
			"[Image: x.tif [image/tiff] 2x2]",
		);
	});
});

describe("encodeITerm2", () => {
	it("produces an inline iTerm2 file escape with the base64 payload", () => {
		const seq = encodeITerm2("AAAA");
		assert.ok(seq.startsWith("\x1b]1337;File="), "should start with the iTerm2 file escape");
		assert.ok(seq.endsWith("\x07"), "should end with BEL");
		assert.ok(seq.includes("inline=1"), "inline defaults to 1");
		assert.ok(seq.includes(":AAAA"), "payload should follow the colon");
	});

	it("can disable inline mode", () => {
		const seq = encodeITerm2("AAAA", { inline: false });
		assert.ok(seq.includes("inline=0"), "inline should be 0 when disabled");
	});

	it("encodes width and height when provided", () => {
		const seq = encodeITerm2("AAAA", { width: 10, height: "auto" });
		assert.ok(seq.includes("width=10"), "width param should be encoded");
		assert.ok(seq.includes("height=auto"), "height param should be encoded");
	});

	it("base64-encodes the name parameter", () => {
		const seq = encodeITerm2("AAAA", { name: "photo.png" });
		// "photo.png" base64 = "cGhvdG8ucG5n"
		assert.ok(seq.includes("name=cGhvdG8ucG5n"), "name should be base64-encoded");
	});

	it("can disable preserveAspectRatio", () => {
		const seq = encodeITerm2("AAAA", { preserveAspectRatio: false });
		assert.ok(seq.includes("preserveAspectRatio=0"), "preserveAspectRatio should be 0");
	});

	it("does not include preserveAspectRatio when left at default", () => {
		const seq = encodeITerm2("AAAA");
		assert.ok(!seq.includes("preserveAspectRatio"), "preserveAspectRatio should be absent by default");
	});

	it("round-trips a small pixel buffer payload unchanged", () => {
		// The payload is opaque to encodeITerm2; verify it is embedded verbatim.
		const payload = "iVBORw0KGgoAAAANSUhEUg==";
		const seq = encodeITerm2(payload);
		assert.ok(seq.includes(`:${payload}\x07`), "payload should be embedded verbatim before BEL");
	});
});
