/**
 * Regression: a component whose render() throws used to escape the render
 * loop — the uncaught stack dumped raw over the TUI and painting stopped,
 * which the user sees as the input area vanishing under a wall of error
 * text. Contract: one broken frame logs and keeps the previous frame; the
 * loop stays alive and the next healthy render repaints.
 */
import { describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class FlakyComponent implements Component {
	failing = false;
	invalidate(): void {}
	render(_width: number): readonly string[] {
		if (this.failing) throw new Error("component render exploded");
		return ["recovered-row"];
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

function stepRender(scheduler: DeferredRenderScheduler): number | null {
	while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();
	const timer = scheduler.timers.shift();
	if (!timer || timer.canceled) return null;
	scheduler.nowMs += timer.delayMs;
	timer.callback();
	return timer.delayMs;
}

describe("TUI render failure containment", () => {
	it("keeps the render loop alive and repaints after a throwing component recovers", () => {
		const term = new VirtualTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const flaky = new FlakyComponent();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(flaky);

		try {
			tui.start();
			stepRender(scheduler);
			scheduler.timers.length = 0;
			scheduler.immediates.length = 0;

			flaky.failing = true;
			tui.requestRender();
			expect(() => stepRender(scheduler)).not.toThrow();

			flaky.failing = false;
			tui.requestRender();
			stepRender(scheduler);
			const viewport = term.getViewport().map(row => Bun.stripANSI(row));
			expect(viewport.some(row => row.includes("recovered-row"))).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
