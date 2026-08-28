/**
 * ccs-custom regression: the extension API handed to extensions exposes the
 * two read-only subtitle actions — getThinkingState (configured/effective/
 * resolved) and getAdvisorOverview — wired from the session through the
 * interactive controller and the runner runtime, matching the contract the
 * omp-routing subtitle widget consumes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

// Unchecked cast: the capture extension stores its ExtensionAPI on globalThis;
// the test reads it back through the same shape.
const capturedPi = globalThis as typeof globalThis & { __ccsCapturedPi?: ExtensionAPI };

describe("ccs-custom subtitle extension actions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(() => {
		tempDir = TempDir.createSync("@ccs-subtitle-");
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.writeFileSync(
			path.join(extensionsDir, "capture-pi.ts"),
			"export default function (pi: unknown) {\n\t(globalThis as { __ccsCapturedPi?: unknown }).__ccsCapturedPi = pi;\n}\n",
		);
	});

	afterAll(() => {
		delete capturedPi.__ccsCapturedPi;
		authStorage.close();
		tempDir.removeSync();
	});

	it("exposes getThinkingState and getAdvisorOverview on the extension API", async () => {
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		const result = await loadExtensions([path.join(extensionsDir, "capture-pi.ts")], tempDir.path());
		expect(result.errors).toHaveLength(0);
		expect(capturedPi.__ccsCapturedPi).toBeDefined();

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);

		// Session stub at the system boundary: only the three state readers the
		// subtitle actions consult (and the runner handle) are exercised.
		const session = {
			thinkingLevel: Effort.High,
			configuredThinkingLevel: () => "auto",
			autoResolvedThinkingLevel: () => Effort.Medium,
			getAdvisorStatusOverview: () => ({
				configured: true,
				advisors: [{ name: "adv-1", status: "running" }],
			}),
			extensionRunner: runner,
		};
		const ctx = { session, syncComposerShape: () => {} } as unknown as InteractiveModeContext;
		const controller = new ExtensionUiController(ctx);
		controller.initializeHookRunner({} as never, true);

		const pi = capturedPi.__ccsCapturedPi!;
		expect(pi.getThinkingState()).toEqual({ configured: "auto", effective: Effort.High, resolved: Effort.Medium });
		expect(pi.getAdvisorOverview()).toEqual({
			configured: true,
			advisors: [{ name: "adv-1", status: "running" }],
		});
	});
});
