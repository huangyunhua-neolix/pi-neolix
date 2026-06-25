import { describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	migrateSessionEntries,
	type SessionHeader,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set (v3 is current after hookMessage->custom migration)
		expect((entries[0] as SessionHeader).version).toBe(3);

		// Entries should have id/parentId
		const msg1 = entries[1] as SessionMessageEntry;
		const msg2 = entries[2] as SessionMessageEntry;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as SessionMessageEntry).id).toBe("abc12345");
		expect((entries[2] as SessionMessageEntry).id).toBe("def67890");
		expect((entries[2] as SessionMessageEntry).parentId).toBe("abc12345");
	});

	it("migrates a v2 session (with hookMessage role) to v3 by renaming role to custom", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "hookMessage", content: "hook payload", timestamp: 1 },
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header bumped to v3.
		expect((entries[0] as SessionHeader).version).toBe(3);
		// hookMessage role renamed to custom; id/parentId preserved.
		const msg = entries[1] as SessionMessageEntry;
		expect(msg.id).toBe("abc12345");
		expect(msg.parentId).toBeNull();
		// AgentMessage is a union; assert the post-migration shape we read.
		const message = msg.message as { role: string; content: unknown };
		expect(message.role).toBe("custom");
		expect(message.content).toBe("hook payload");
	});

	it("is a no-op on entries already at the current version", () => {
		const entries: FileEntry[] = [
			{
				type: "session",
				id: "sess-1",
				version: CURRENT_SESSION_VERSION,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			{
				type: "message",
				id: "fixed-id1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "fixed-id2",
				parentId: "fixed-id1",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "custom",
					content: [{ type: "text", text: "kept" }],
					timestamp: 2,
				},
			},
		] as FileEntry[];

		// Snapshot before migration for deep equality after.
		const before = JSON.parse(JSON.stringify(entries));
		migrateSessionEntries(entries);
		expect(entries).toEqual(before);
		expect((entries[0] as SessionHeader).version).toBe(CURRENT_SESSION_VERSION);
	});

	it("migrates an older (v1) fixture all the way to the current version in one pass", () => {
		// v1: no version field, no id/parentId, a hookMessage-flavored message (role string).
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-old", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "hookMessage", content: "x", timestamp: 1 },
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: { role: "user", content: "y", timestamp: 2 },
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		expect((entries[0] as SessionHeader).version).toBe(CURRENT_SESSION_VERSION);

		const m1 = entries[1] as SessionMessageEntry;
		const m2 = entries[2] as SessionMessageEntry;
		// Tree structure added (v1 -> v2).
		expect(m1.id).toBeDefined();
		expect(m1.parentId).toBeNull();
		expect(m2.parentId).toBe(m1.id);
		// hookMessage renamed (v2 -> v3).
		expect(m1.message.role).toBe("custom");
		expect(m2.message.role).toBe("user");
	});

	it("handles an empty entries array without throwing", () => {
		const entries: FileEntry[] = [];
		expect(() => migrateSessionEntries(entries)).not.toThrow();
		expect(entries).toEqual([]);
	});

	it("handles entries without a session header (version defaults to v1)", () => {
		// No "session" entry → migrateToCurrentVersion treats version as 1.
		const entries: FileEntry[] = [
			{
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "orphan", timestamp: 1 },
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		const msg = entries[0] as SessionMessageEntry;
		expect(msg.id).toBeDefined();
		expect(msg.parentId).toBeNull();
	});
});

describe("CURRENT_SESSION_VERSION", () => {
	it("matches the documented current version (3)", () => {
		expect(CURRENT_SESSION_VERSION).toBe(3);
	});

	it("is a number", () => {
		expect(typeof CURRENT_SESSION_VERSION).toBe("number");
	});
});
