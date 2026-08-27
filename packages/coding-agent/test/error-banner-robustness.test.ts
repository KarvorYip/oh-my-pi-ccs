/**
 * Regression: the pinned error banner receives whatever the failure path
 * hands it. A non-string payload (Error object, undefined from a missing
 * field) used to throw inside getPreviewLines — the exception escaped the
 * event handler, dumped a raw stack over the TUI, and killed the composer.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { ErrorBannerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/error-banner";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("ErrorBannerComponent robustness", () => {
	it("renders an Error object payload instead of throwing", () => {
		const banner = new ErrorBannerComponent(new Error("boom-payload") as unknown as string);
		const rows = banner.render(80).map(row => Bun.stripANSI(row));
		expect(rows.join("\n")).toContain("boom-payload");
	});

	it("renders an undefined payload as the unknown-error banner", () => {
		const banner = new ErrorBannerComponent(undefined as unknown as string);
		const rows = banner.render(80).map(row => Bun.stripANSI(row));
		expect(rows.join("\n")).toContain("Unknown error");
	});

	it("stringifies a plain object payload", () => {
		const banner = new ErrorBannerComponent({ detail: "coded-failure" } as unknown as string);
		const rows = banner.render(80).map(row => Bun.stripANSI(row));
		expect(rows.length).toBeGreaterThan(0);
	});
});
