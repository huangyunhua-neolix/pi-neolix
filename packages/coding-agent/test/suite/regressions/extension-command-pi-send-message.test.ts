/**
 * Regression: `/agent:<name>` slash command surfaced results via `ctx.sendMessage`,
 * which was removed from ExtensionCommandContext (now only on ReplacedSessionContext).
 * The handler ran the subagent successfully then threw
 * `TypeError: ctx.sendMessage is not a function` at the result-surfacing step.
 *
 * Fix (PR #32): call `pi.sendMessage(...)` on the top-level ExtensionAPI instead.
 *
 * This test pins the contract the fix relies on: a command handler scoped to
 * ExtensionCommandContext can reach `pi.sendMessage` to surface a custom message
 * inline. If the API moves again (sendMessage removed from ExtensionAPI, or
 * re-scoped to a context only available inside withSession()), this test breaks
 * instead of letting the crash ship silently again.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("regression: extension command surfaces result via pi.sendMessage", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: (pi: ExtensionAPI) => void, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-sendmsg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});

		const rebindSession = async (): Promise<void> => {
			const session = runtime.session;
			await session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.agent.waitForIdle(),
					newSession: async (options) => runtime.newSession(options),
					fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
					navigateTree: async (targetId, options) => ({
						cancelled: (
							await session.navigateTree(targetId, {
								summarize: options?.summarize,
								customInstructions: options?.customInstructions,
								replaceInstructions: options?.replaceInstructions,
								label: options?.label,
							})
						).cancelled,
					}),
					switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
					reload: async () => {
						await session.reload();
					},
				},
			});
		};

		runtime.setRebindSession(async () => {
			await rebindSession();
		});
		await rebindSession();

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		return { runtime, faux };
	}

	it("command handler reaches pi.sendMessage without throwing (surfaces inline custom message)", async () => {
		// Reproduce the subagent extension's result-surfacing pattern: a command
		// handler scoped to ExtensionCommandContext calls the top-level
		// pi.sendMessage to deliver a custom message. Pre-fix this threw because
		// the handler used ctx.sendMessage (not on ExtensionCommandContext).
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerMessageRenderer("subagent-result", (message) => {
					const content = typeof message.content === "string" ? message.content : "";
					return { type: "text", text: content } as never;
				});
				pi.registerCommand("agent:repro", {
					description: "repro",
					argumentHint: "<requirement>",
					handler: async (_args, _ctx) => {
						// Mirror subagent/index.ts:1158 — pi.sendMessage, NOT ctx.sendMessage.
						pi.sendMessage({
							customType: "subagent-result",
							content: "agent output",
							display: true,
						});
					},
				});
			},
			["faux reply"],
		);

		// Must not throw. Pre-fix this rejected with TypeError.
		await runtime.session.prompt("/agent:repro do something");

		const messages = runtime.session.messages.map((m) => `${m.role}:${getText(m)}`);
		expect(messages).toContain("custom:agent output");
	});

	it("ExtensionCommandContext type does not expose sendMessage (compile-time guard)", () => {
		// Static check: if someone re-adds sendMessage to ExtensionCommandContext,
		// the subagent extension should switch back to ctx.sendMessage. This test
		// asserts the current contract that forces pi.sendMessage.
		type AssertNoSendMessage<T> = T extends { sendMessage: unknown } ? false : true;
		type HasNoSendMessage = AssertNoSendMessage<
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1]
		>;
		const _check: HasNoSendMessage = true as const;
		expect(_check).toBe(true);
	});
});
