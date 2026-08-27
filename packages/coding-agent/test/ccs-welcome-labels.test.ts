/**
 * ccs-custom regression: the welcome screen renders model/provider labels
 * from globalThis.__ompCcsWelcomeLabels (populated by the CCS bridge/plugin)
 * instead of the raw bundled model identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession } from "./utilities";

// Unchecked cast: the production contract augments globalThis with this map
// (see interactive-mode.ts); tests install and clear it through the same shape.
type CcsWelcomeLabels = Map<string, { modelName: string; providerName: string }>;
const ccsLabelsGlobal = globalThis as typeof globalThis & { __ompCcsWelcomeLabels?: CcsWelcomeLabels };
describe("ccs-custom welcome labels", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		delete ccsLabelsGlobal.__ompCcsWelcomeLabels;
		vi.restoreAllMocks();
	});

	it("renders CCS welcome labels from globalThis.__ompCcsWelcomeLabels", async () => {
		const terminal = new VirtualTerminal(80, 30);
		const composer = new Composer({ preferences: { ...COMPOSER_DEFAULTS }, terminal });
		composer.start();
		const testSession = await createTestSession({ inMemory: true });
		let mode: InteractiveMode | undefined;
		try {
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			ccsLabelsGlobal.__ompCcsWelcomeLabels = new Map([
				["anthropic/claude-sonnet-4-5", { modelName: "ccs-model-label", providerName: "ccs-provider-label" }],
			]);
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				composer,
			);
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

			await mode.init({ suppressWelcomeIntro: true });

			const screen = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(screen).toContain("ccs-model-label");
			expect(screen).toContain("ccs-provider-label");
		} finally {
			mode?.stop();
			await testSession.cleanup();
		}
	});
});
