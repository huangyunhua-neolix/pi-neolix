import {
	err,
	type FileError,
	FileError as FileErrorCtor,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
} from "../../src/harness/types.ts";

type FileContent = string | Uint8Array;

interface MockFileEntry {
	kind: FileKind;
	content?: FileContent;
}

export interface MockFileSystemOptions {
	cwd?: string;
	failCreateDir?: boolean;
}

function makeFileError(code: string, message: string, path?: string): FileError {
	return new FileErrorCtor(code as any, message, path);
}

export class MockFileSystem {
	readonly cwd: string;
	private files = new Map<string, MockFileEntry>();
	private failCreateDir = false;

	constructor(options: MockFileSystemOptions = {}) {
		this.cwd = options.cwd ?? "/mock";
		this.failCreateDir = options.failCreateDir ?? false;
	}

	private normalize(path: string): string {
		if (!path) return this.cwd;
		if (path.startsWith("/")) return path;
		return `${this.cwd}/${path}`.replace(/\/+/g, "/");
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(parts.join("/").replace(/\/+/g, "/"));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const entry = this.files.get(this.normalize(path));
		if (!entry || entry.kind !== "file") {
			return err(makeFileError("not_found", `File not found: ${path}`, path));
		}
		const content = entry.content;
		if (typeof content === "string") return ok(content);
		return ok(new TextDecoder().decode(content));
	}

	async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		const lines = result.value.split("\n");
		const maxLines = options?.maxLines;
		return ok(maxLines !== undefined ? lines.slice(0, maxLines) : lines);
	}

	async writeFile(path: string, content: FileContent): Promise<Result<void, FileError>> {
		this.files.set(this.normalize(path), { kind: "file", content });
		return ok(undefined);
	}

	async appendFile(path: string, content: FileContent): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const entry = this.files.get(normalized);
		const existing = entry?.kind === "file" ? entry.content : undefined;
		const existingStr = typeof existing === "string" ? existing : existing ? new TextDecoder().decode(existing) : "";
		const newStr = typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, { kind: "file", content: existingStr + newStr });
		return ok(undefined);
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const normalized = this.normalize(path);
		const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
		const children: FileInfo[] = [];
		const seen = new Set<string>();
		for (const [filePath, entry] of this.files) {
			if (!filePath.startsWith(prefix)) continue;
			const remainder = filePath.slice(prefix.length);
			if (!remainder || remainder.includes("/")) continue;
			if (seen.has(remainder)) continue;
			seen.add(remainder);
			children.push({
				name: remainder,
				path: filePath,
				kind: entry.kind,
				size: typeof entry.content === "string" ? entry.content.length : (entry.content?.byteLength ?? 0),
				mtimeMs: 0,
			});
		}
		const dirEntry = this.files.get(normalized);
		if (children.length === 0 && !dirEntry) {
			return err(makeFileError("not_found", `Directory not found: ${path}`, path));
		}
		return ok(children);
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) return ok(true);
		const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
		for (const filePath of this.files) {
			if (filePath[0].startsWith(prefix)) return ok(true);
		}
		return ok(false);
	}

	async createDir(path: string): Promise<Result<void, FileError>> {
		if (this.failCreateDir) {
			return err(makeFileError("permission_denied", `Mock createDir failure: ${path}`, path));
		}
		const normalized = this.normalize(path);
		if (!this.files.has(normalized)) {
			this.files.set(normalized, { kind: "directory" });
		}
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.files.delete(normalized);
		const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
		for (const filePath of [...this.files.keys()]) {
			if (filePath.startsWith(prefix)) {
				this.files.delete(filePath);
			}
		}
		return ok(undefined);
	}

	async cleanup(): Promise<void> {}

	injectFile(path: string, content: string): void {
		this.files.set(this.normalize(path), { kind: "file", content });
	}

	injectDir(path: string): void {
		this.files.set(this.normalize(path), { kind: "directory" });
	}

	hasFile(path: string): boolean {
		return this.files.has(this.normalize(path));
	}

	getFileContent(path: string): string | undefined {
		const entry = this.files.get(this.normalize(path));
		if (!entry || entry.kind !== "file") return undefined;
		return typeof entry.content === "string" ? entry.content : new TextDecoder().decode(entry.content);
	}
}
