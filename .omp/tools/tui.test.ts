import { expect, test, vi } from "bun:test";
import { Screen } from "./tui";

test("Screen ignores late PTY data after dispose", () => {
	let disposed = false;
	const term = {
		write: vi.fn(() => {
			if (disposed) throw new Error("KittyTerminal used after dispose()");
		}),
		dispose: vi.fn(() => {
			disposed = true;
		}),
	} as unknown as ConstructorParameters<typeof Screen>[0];
	const screen = new Screen(term);

	screen.dispose();
	expect(() => screen.feed(new Uint8Array([1]))).not.toThrow();
	screen.dispose();

	expect(term.write).not.toHaveBeenCalled();
	expect(term.dispose).toHaveBeenCalledTimes(1);
});
