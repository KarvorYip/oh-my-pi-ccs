/**
 * ccs-custom regression: while the screen has room (no history retired), the
 * composed frame is padded to the full terminal height so the input block
 * sits on the last rows from the first paint. Under history pressure the pad
 * is zero — retirement pacing, scroll anchoring, and resize reconciliation
 * must stay byte-identical to upstream.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class InputBlock implements Component {
	render(): string[] {
		return ["EDIT-TOP", "EDIT-MID", "EDIT-BOT"];
	}
}

beforeAll(async () => {
	await initTheme();
});

describe("ccs-custom composer input pinning", () => {
	it("pads the short-session frame to full height so the input block owns the last rows", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const terminal = new VirtualTerminal(80, 40);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false },
			welcome: { version: "t", modelName: "m", providerName: "p" },
		});
		composer.setRuntimeChildren([new TranscriptContainer(), new InputBlock()]);
		composer.start({ playWelcomeIntro: false });

		const plan = composer.renderFrame({ columns: 80, rows: 40 });
		expect(plan.history).toBeUndefined();
		expect(plan.viewport.length).toBe(40);
		expect(plan.viewport[39]).toContain("EDIT-BOT");
		expect(plan.viewport[37]).toContain("EDIT-TOP");
		composer.ui.stop();
	});

	it("never pads once history pressure retires the header", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const terminal = new VirtualTerminal(80, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false },
			welcome: { version: "t", modelName: "m", providerName: "p" },
		});
		composer.setRuntimeChildren([new TranscriptContainer(), new InputBlock()]);
		composer.start({ playWelcomeIntro: false });

		const plan = composer.renderFrame({ columns: 80, rows: 12 });
		expect(plan.history).toBeDefined();
		expect(plan.viewport.length).toBeLessThanOrEqual(12);
		expect(plan.viewport.filter(row => row === "").length).toBe(0);
		expect(plan.viewport[plan.viewport.length - 1]).toContain("EDIT-BOT");
		composer.ui.stop();
	});

	it("pins the bootstrap frame before the runtime tree mounts", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const terminal = new VirtualTerminal(80, 40);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false },
			welcome: { version: "t", modelName: "m", providerName: "p" },
		});
		composer.start({ playWelcomeIntro: false });

		const plan = composer.renderFrame({ columns: 80, rows: 40 });
		expect(plan.viewport.length).toBe(40);
		const rendered = plan.viewport.map(row => Bun.stripANSI(row).trimEnd());
		const lastContent = rendered.reduce((acc, row, index) => (row.trim() ? index : acc), -1);
		expect(lastContent).toBe(39);
		composer.ui.stop();
	});
});

afterAll(() => {
	vi.restoreAllMocks();
});
