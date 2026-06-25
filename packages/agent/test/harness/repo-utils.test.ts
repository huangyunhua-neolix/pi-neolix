import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionRepo } from "../../src/harness/session/memory-repo.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import {
	createSessionId,
	createTimestamp,
	getEntriesToFork,
	getFileSystemResultOrThrow,
	toSession,
} from "../../src/harness/session/repo-utils.ts";
import { err, FileError, ok, SessionError } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("createSessionId", () => {
	it("returns a non-empty string", () => {
		const id = createSessionId();
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("produces unique values across calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) ids.add(createSessionId());
		expect(ids.size).toBe(100);
	});

	it("matches the uuid v7 lexical shape (8-4-4-4-12 hex with version 7)", () => {
		const id = createSessionId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

describe("createTimestamp", () => {
	it("returns an ISO 8601 string parseable by Date", () => {
		const ts = createTimestamp();
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
		expect(Number.isNaN(Date.parse(ts))).toBe(false);
	});

	it("returns a timestamp close to the current time", () => {
		const before = Date.now();
		const ts = createTimestamp();
		const after = Date.now();
		const parsed = Date.parse(ts);
		expect(parsed).toBeGreaterThanOrEqual(before);
		expect(parsed).toBeLessThanOrEqual(after);
	});
});

describe("toSession", () => {
	it("wraps a SessionStorage into a Session backed by the same storage", async () => {
		const metadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata });
		const session = toSession(storage);
		expect(await session.getMetadata()).toEqual(metadata);
	});

	it("reflects entries appended through the underlying storage", async () => {
		const storage = new InMemorySessionStorage();
		const session = toSession(storage);
		const id = await session.appendMessage(createUserMessage("hi"));
		const entry = await session.getEntry(id);
		expect(entry?.type).toBe("message");
	});
});

describe("getFileSystemResultOrThrow", () => {
	it("returns the value when the result is ok", () => {
		const value = getFileSystemResultOrThrow(ok("payload"), "should not be used");
		expect(value).toBe("payload");
	});

	it("returns complex values when ok", () => {
		const value = getFileSystemResultOrThrow(ok({ a: 1, b: [2, 3] }), "ctx");
		expect(value).toEqual({ a: 1, b: [2, 3] });
	});

	it("throws a SessionError with code storage for a generic file error", () => {
		const fileError = new FileError("permission_denied", "denied", "/x");
		try {
			getFileSystemResultOrThrow(err<string, FileError>(fileError), "Reading /x");
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionError);
			const sessionError = error as SessionError;
			expect(sessionError.code).toBe("storage");
			expect(sessionError.message).toContain("Reading /x");
			expect(sessionError.message).toContain("denied");
		}
	});

	it("throws a SessionError with code not_found when the file error code is not_found", () => {
		const fileError = new FileError("not_found", "missing file", "/missing");
		try {
			getFileSystemResultOrThrow(err<string, FileError>(fileError), "Opening /missing");
			throw new Error("expected throw");
		} catch (error) {
			const sessionError = error as SessionError;
			expect(sessionError.code).toBe("not_found");
			expect(sessionError.message).toContain("Opening /missing");
		}
	});

	it("preserves the original error as the cause", () => {
		const fileError = new FileError("unknown", "boom");
		try {
			getFileSystemResultOrThrow(err<string, FileError>(fileError), "ctx");
			throw new Error("expected throw");
		} catch (error) {
			const sessionError = error as SessionError;
			expect(sessionError.cause).toBe(fileError);
		}
	});
});

describe("getEntriesToFork", () => {
	it("returns all entries when no entryId is provided", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "s1" });
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		const storage = session.getStorage();
		const entries = await getEntriesToFork(storage, {});
		const messageIds = entries.filter((e) => e.type === "message").map((e) => e.id);
		expect(messageIds).toEqual([user1, assistant1, user2]);
	});

	it("returns the path to the parent of the targeted user message by default (before)", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "s2" });
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		const storage = session.getStorage();
		const entries = await getEntriesToFork(storage, { entryId: user2 });
		expect(entries.map((e) => e.id)).toEqual([user1, assistant1]);
	});

	it("returns the path to the targeted entry itself when position is at", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "s3" });
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		const storage = session.getStorage();
		const entries = await getEntriesToFork(storage, { entryId: user2, position: "at" });
		expect(entries.map((e) => e.id)).toEqual([user1, assistant1, user2]);
	});

	it("throws invalid_fork_target when the entryId does not exist", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "s4" });
		const storage = session.getStorage();
		await expect(getEntriesToFork(storage, { entryId: "nope" })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
	});

	it("throws invalid_fork_target when the target is not a user message (position=before)", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "s5" });
		const _user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const storage = session.getStorage();
		await expect(getEntriesToFork(storage, { entryId: assistant1 })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
	});

	it("exercises a Jsonl-backed storage under a temp directory without touching the user home", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "jsonl-1" });
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		const storage = session.getStorage();
		const entries = await getEntriesToFork(storage, { entryId: user2 });
		expect(entries.map((e) => e.id)).toEqual([user1, assistant1]);
		const atEntries = await getEntriesToFork(storage, { entryId: user2, position: "at" });
		expect(atEntries.map((e) => e.id)).toEqual([user1, assistant1, user2]);
	});
});
