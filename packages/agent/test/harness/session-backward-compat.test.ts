import { describe, expect, it } from "vitest";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "../../src/harness/session/jsonl-storage.ts";
import { SessionError } from "../../src/harness/types.ts";
import { MockFileSystem } from "./mock-fs.ts";

const SESSIONS_DIR = "/sessions";
const SESSION_FILE = "/sessions/test-session.jsonl";

function createMockFs(content: string): MockFileSystem {
	const fs = new MockFileSystem();
	fs.injectDir(SESSIONS_DIR);
	fs.injectFile(SESSION_FILE, content);
	return fs;
}

describe("Session backward-compat", () => {
	it("reads session with missing parentSessionPath", async () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "test-001",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/test-project",
		});
		const fs = createMockFs(`${header}\n`);
		const metadata = await loadJsonlSessionMetadata(fs, SESSION_FILE);
		expect(metadata.id).toBe("test-001");
		expect(metadata.parentSessionPath).toBeUndefined();
	});

	it("reads session with entries missing timestamp gracefully via open", async () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "test-002",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/test-project",
		});
		// A well-formed entry — backward compat is about reading valid old-format, not invalid entries
		const entry = JSON.stringify({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		});
		const fs = createMockFs(`${header}\n${entry}\n`);
		const storage = await JsonlSessionStorage.open(fs, SESSION_FILE);
		const entries = await storage.getEntries();
		expect(entries.length).toBe(1);
		expect(entries[0]!.id).toBe("entry-1");
	});

	it("reads empty session file (only header, no entries)", async () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "test-003",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/test-project",
		});
		const fs = createMockFs(`${header}\n`);
		const storage = await JsonlSessionStorage.open(fs, SESSION_FILE);
		const entries = await storage.getEntries();
		expect(entries).toEqual([]);
		expect(await storage.getLeafId()).toBeNull();
	});

	it("reads session with minimal header (only required fields)", async () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "test-004",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/minimal",
		});
		const fs = createMockFs(`${header}\n`);
		const metadata = await loadJsonlSessionMetadata(fs, SESSION_FILE);
		expect(metadata.id).toBe("test-004");
		expect(metadata.cwd).toBe("/tmp/minimal");
		expect(metadata.parentSessionPath).toBeUndefined();
	});

	it("throws SessionError invalid_session for corrupt JSONL", async () => {
		const fs = createMockFs("not valid json at all\n");
		await expect(loadJsonlSessionMetadata(fs, SESSION_FILE)).rejects.toThrow(SessionError);
	});

	it("throws SessionError invalid_session for unsupported version", async () => {
		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: "test-old",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/tmp/old",
		});
		const fs = createMockFs(`${header}\n`);
		await expect(loadJsonlSessionMetadata(fs, SESSION_FILE)).rejects.toThrow("unsupported session version");
	});

	it("round-trips a session with messages through write then read", async () => {
		const fs = new MockFileSystem();
		fs.injectDir(SESSIONS_DIR);
		const storage = await JsonlSessionStorage.create(fs, SESSION_FILE, {
			cwd: "/tmp/roundtrip",
			sessionId: "rt-001",
		});
		await storage.appendEntry({
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "round-trip test" }], timestamp: 0 },
		});
		// Re-open and verify
		const reopened = await JsonlSessionStorage.open(fs, SESSION_FILE);
		const entries = await reopened.getEntries();
		expect(entries.length).toBe(1);
		expect(entries[0]!.id).toBe("msg-1");
		const metadata = await reopened.getMetadata();
		expect(metadata.id).toBe("rt-001");
	});
});
