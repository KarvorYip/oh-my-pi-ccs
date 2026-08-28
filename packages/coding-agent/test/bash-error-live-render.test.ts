import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function createFixture() {
	const blocks: unknown[] = [];
	const ctx = {
		isInitialized: true,
		init: async () => {},
		ui: { requestRender: () => {}, requestComponentRender: () => {} },
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: { invalidate: () => {}, markActivityStart: () => {} },
		session: { isAborting: false },
		settings: { get: () => false },
		updateEditorTopBorder: () => {},
		clearPinnedError: () => {},
		ensureLoadingAnimation: () => {},
		noteDisplayableThinkingContent: () => false,
		effectiveHideThinkingBlock: false,
		streamingComponent: {
			setHideThinkingBlock: () => {},
			markTranscriptBlockFinalized: () => {},
			updateContent: () => {},
			setCacheInvalidation: () => {},
			setErrorPinned: () => {},
		},
		streamingMessage: undefined,
		viewSession: { isStreaming: false, getToolByName: () => undefined, hasBuiltInTool: () => true },
		sessionManager: { getCwd: () => "/tmp" },
		chatContainer: {
			addChild: (block: unknown) => blocks.push(block),
			removeChild: () => {},
			canRemoveBlock: () => false,
		},
		toolOutputExpanded: false,
		showWarning: () => {},
		showPinnedError: () => {},
		present: () => {},
	} as unknown as InteractiveModeContext;
	return { ctx, controller: new EventController(ctx), blocks };
}

function streamedBashBlock(toolCallId: string): Extract<AgentSessionEvent, { type: "message_update" }> {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_start" },
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls /nonexistent-xyz-123" } },
			],
		},
	} as unknown as Extract<AgentSessionEvent, { type: "message_update" }>;
}

function bashStart(toolCallId: string): Extract<AgentSessionEvent, { type: "tool_execution_start" }> {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName: "bash",
		args: { command: "ls /nonexistent-xyz-123" },
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
}

function bashErrorEnd(toolCallId: string): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		isError: true,
		result: {
			content: [
				{
					type: "text",
					text: "ls: cannot access '/nonexistent-xyz-123': No such file or directory\n\nCommand exited with code 2",
				},
			],
			details: { exitCode: 2, timedOut: false, wallTimeMs: 87 },
		},
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

function renderBlocks(blocks: unknown[]): string {
	const transcript = new TranscriptContainer();
	for (const block of blocks) transcript.addChild(block as Component);
	const batch = transcript.peekFinalizedBatch(80, 0);
	return Bun.stripANSI(batch?.rows.join("\n") ?? "");
}

describe("bash error live rendering stays inside the framed output block", () => {
	it("renders an isError bash result with the error text inside the frame", async () => {
		const f = createFixture();
		await f.controller.handleEvent(streamedBashBlock("bash-err-1"));
		await f.controller.handleEvent(bashStart("bash-err-1"));
		await f.controller.handleEvent(bashErrorEnd("bash-err-1"));

		expect(f.blocks.length).toBeGreaterThan(0);
		const text = renderBlocks(f.blocks);

		// The error text must be present…
		expect(text).toContain("No such file or directory");
		// …and framed: the output block draws its own border rows.
		const lines = text.split("\n");
		const errorLine = lines.findIndex(l => l.includes("No such file or directory"));
		expect(errorLine).toBeGreaterThan(-1);
		const hasFrame = lines.some(l => /[╭┌├└╰]/.test(l));
		expect(hasFrame).toBe(true);
		// No bare unframed dump: error content lines must sit between borders.
		for (const line of lines) {
			if (line.includes("No such file") || line.includes("Exit: 2")) {
				const before = lines.slice(0, lines.indexOf(line));
				const after = lines.slice(lines.indexOf(line) + 1);
				expect(before.some(l => /[╭┌]/.test(l))).toBe(true);
				expect(after.some(l => /[╰└]/.test(l))).toBe(true);
			}
		}
	});

	it("survives a message_end whose assistant message has no usage (provider error)", async () => {
		const f = createFixture();
		// A provider failure (e.g. 429) can end a turn with stopReason=error and
		// no usage object. The live message_end path must not dereference it.
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "429 rate limited",
				usage: undefined,
				timestamp: Date.now(),
			},
		} as unknown as Parameters<typeof f.controller.handleEvent>[0];

		await expect(f.controller.handleEvent(event)).resolves.toBeUndefined();
	});
});
