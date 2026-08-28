import { afterEach, expect, test, vi } from "bun:test";
import * as vcs from "../native/vcs.js";

afterEach(() => vi.restoreAllMocks());

test.skipIf(process.platform !== "win32")("Windows status bypasses gitoxide worker threads", async () => {
	const repository = vcs.git(process.cwd());
	if (!repository) throw new Error(`not a repository: ${process.cwd()}`);
	const nativeStatus = vi.spyOn(Object.getPrototypeOf(repository), "statusSummary").mockImplementation(() => {
		throw new Error("native gitoxide status must not run on Windows");
	});

	const summary = await repository.statusSummary();

	expect(nativeStatus).not.toHaveBeenCalled();
	expect(summary.staged).toBeGreaterThanOrEqual(0);
	expect(summary.unstaged).toBeGreaterThanOrEqual(0);
	expect(summary.untracked).toBeGreaterThanOrEqual(0);
});
