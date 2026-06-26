import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionRepo } from "../../src/harness/session/memory-repo.ts";
import { SessionError } from "../../src/harness/types.ts";
import { MockFileSystem } from "./mock-fs.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("InMemorySessionRepo", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		expect(await repo.open(metadata)).toBe(session);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});
});

describe("JsonlSessionRepo", () => {
	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("returns empty list when sessions root does not exist", async () => {
		const fs = new MockFileSystem();
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: "/sessions" });
		const result = await repo.list();
		expect(result).toEqual([]);
	});

	it("skips invalid JSONL files during list and propagates other errors", async () => {
		const fs = new MockFileSystem();
		fs.injectDir("/sessions");
		fs.injectDir("/sessions/--tmp-test--");
		const validHeader = JSON.stringify({
			type: "session",
			version: 3,
			id: "valid-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/test",
		});
		fs.injectFile("/sessions/--tmp-test--/2026-01-01_valid-1.jsonl", `${validHeader}\n`);
		fs.injectFile("/sessions/--tmp-test--/broken.jsonl", "not valid json\n");
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: "/sessions" });
		const result = await repo.list({ cwd: "/tmp/test" });
		expect(result.map((m) => m.id)).toEqual(["valid-1"]);
	});

	it("sorts sessions by createdAt descending", async () => {
		const fs = new MockFileSystem();
		fs.injectDir("/sessions");
		fs.injectDir("/sessions/--tmp-proj--");
		const header1 = JSON.stringify({
			type: "session",
			version: 3,
			id: "older",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/proj",
		});
		const header2 = JSON.stringify({
			type: "session",
			version: 3,
			id: "newer",
			timestamp: "2026-06-01T00:00:00.000Z",
			cwd: "/tmp/proj",
		});
		fs.injectFile("/sessions/--tmp-proj--/2026-01-01_older.jsonl", `${header1}\n`);
		fs.injectFile("/sessions/--tmp-proj--/2026-06-01_newer.jsonl", `${header2}\n`);
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: "/sessions" });
		const result = await repo.list({ cwd: "/tmp/proj" });
		expect(result.map((m) => m.id)).toEqual(["newer", "older"]);
	});

	it("throws SessionError not_found when opening a non-existent session", async () => {
		const fs = new MockFileSystem();
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: "/sessions" });
		await expect(
			repo.open({
				id: "missing",
				createdAt: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
				path: "/sessions/missing.jsonl",
			}),
		).rejects.toThrow(SessionError);
	});

	it("throws SessionError storage when createDir fails", async () => {
		const fs = new MockFileSystem({ failCreateDir: true });
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: "/sessions" });
		let error: unknown;
		try {
			await repo.create({ cwd: "/tmp/test", id: "test-1" });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SessionError);
		expect((error as SessionError).code).toBe("storage");
	});
});

describe("InMemorySessionRepo — error paths", () => {
	it("throws SessionError not_found when opening unknown id", async () => {
		const repo = new InMemorySessionRepo();
		await expect(repo.open({ id: "nonexistent", createdAt: "2026-01-01T00:00:00.000Z" })).rejects.toThrow(
			SessionError,
		);
	});

	it("delete on non-existent session is a no-op", async () => {
		const repo = new InMemorySessionRepo();
		await expect(repo.delete({ id: "nonexistent", createdAt: "2026-01-01T00:00:00.000Z" })).resolves.toBeUndefined();
		expect((await repo.list()).length).toBe(0);
	});
});
