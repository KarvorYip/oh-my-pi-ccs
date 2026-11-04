/**
 * Regression: the pinned error banner receives whatever the failure path
 * hands it. Both terminal rendering and native descriptions must accept
 * non-string payloads without throwing or losing the unknown-error fallback.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ErrorBannerComponent } from "@oh-my-pi/pi-tui/overlays/error-banner";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { TurnUsageTally } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

describe("ErrorBannerComponent robustness", () => {
	it("renders an Error object payload instead of throwing", () => {
		const banner = new ErrorBannerComponent(new Error("boom-payload"));
		const rows = banner.render(80).map(row => Bun.stripANSI(row));
		expect(rows.join("\n")).toContain("boom-payload");
		expect(banner.describe().c?.[0]).toMatchObject({
			k: "text",
			p: { spans: [{ t: "Error: boom-payload" }] },
		});
	});

	it("renders an undefined payload as the unknown-error banner", () => {
		const banner = new ErrorBannerComponent(undefined);
		const rows = banner.render(80).map(row => Bun.stripANSI(row));
		expect(rows.join("\n")).toContain("Unknown error");
		expect(banner.describe().c?.[0]).toMatchObject({
			k: "text",
			p: { spans: [{ t: "Unknown error" }] },
		});
	});

	it("keeps the full normalized error when native details are expanded", () => {
		const banner = new ErrorBannerComponent(new Error("\x1b[31mheadline\nprovider detail\x1b[0m"));
		expect(Bun.stripANSI(banner.render(80).join("\n"))).toContain("provider detail");
		expect(banner.describe().c?.[0]).toMatchObject({
			k: "text",
			p: { spans: [{ t: "Error: headline" }], title: "Error: headline\nprovider detail" },
		});
		banner.handleNativeEvent({ type: "action", key: "", act: "details", mods: [] });
		expect(banner.describe().c?.[0]).toMatchObject({
			k: "text",
			p: { spans: [{ t: "Error: headline\nprovider detail" }], wrap: "word" },
		});
	});
});

// A malformed provider failure can omit the normally required usage payload.
function assistantWithoutUsage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: "429 rate limited",
		timestamp: 1,
	} as AssistantMessage;
}

describe("CCS provider failure and MSYS repaint safety", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("keeps streaming thinking drawable when provider usage is absent", () => {
		const component = new AssistantMessageComponent(undefined, true);
		try {
			const message = assistantWithoutUsage([{ type: "thinking", thinking: "unfinished reasoning" }]);
			expect(() => component.updateContent(message, { transient: true })).not.toThrow();
			const rendered = Bun.stripANSI(component.render(80).join("\n"));
			expect(rendered).toContain("Thinking");
			expect(rendered).not.toContain("toks/s");
		} finally {
			component.dispose();
		}
	});

	it("pins a provider error without usage instead of failing in turn accounting", async () => {
		const message = assistantWithoutUsage([]);
		const component = new AssistantMessageComponent();
		const ctx = createInteractiveModeContext({ streamingComponent: component, streamingMessage: message });
		const showPinnedError = vi.spyOn(ctx, "showPinnedError");
		const controller = new EventController(ctx);
		try {
			await controller.handleEvent({ type: "message_end", message });
			expect(showPinnedError).toHaveBeenCalledWith("429 rate limited");
			expect(ctx.streamingComponent).toBeUndefined();
		} finally {
			controller.dispose();
			component.dispose();
		}
	});

	it("repaints after bash teardown at 250ms and cancels the pending repaint on dispose", async () => {
		vi.useFakeTimers();
		const ctx = createInteractiveModeContext();
		const requestRender = vi.spyOn(ctx.ui, "requestRender");
		const controller = new EventController(ctx);
		const completeBash = (toolCallId: string) =>
			controller.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "bash",
				isError: true,
				result: { content: [{ type: "text", text: "fork: Resource temporarily unavailable" }] },
			});
		try {
			await completeBash("bash-1");
			expect(requestRender).toHaveBeenCalledWith(true);
			requestRender.mockClear();
			vi.advanceTimersByTime(249);
			expect(requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(requestRender).toHaveBeenCalledWith(true);

			await completeBash("bash-2");
			controller.dispose();
			requestRender.mockClear();
			vi.advanceTimersByTime(250);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			controller.dispose();
		}
	});

	it("retains tool usage when a later failure omits usage, then resets the completed turn", () => {
		const tally = new TurnUsageTally();
		const message = assistantWithoutUsage([]);
		expect(
			tally.add(
				{
					...message,
					stopReason: "toolUse",
					usage: {
						input: 100,
						output: 5,
						cacheRead: 50,
						cacheWrite: 20,
						totalTokens: 175,
						cost: { input: 0.01, output: 0.01, cacheRead: 0.005, cacheWrite: 0.005, total: 0.03 },
					},
				},
				1_000,
			),
		).toBeUndefined();
		expect(tally.add({ ...message, stopReason: "toolUse" }, 1_000)).toBeUndefined();
		expect(tally.add({ ...message, completedAt: 2_500 }, 1_000)).toEqual({
			elapsedMs: 1_500,
			input: 120,
			output: 5,
			cost: 0.03,
		});
		expect(tally.add(message, 1_000)).toBeUndefined();
	});
});
