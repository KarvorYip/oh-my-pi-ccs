import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock } from "../native/index.js";
import { withNativeRuntimeInstallLock } from "../native/loader-state.js";

test("FileLock binds release to one native owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-lock-"));
	const lockPath = path.join(root, "resource.lock");
	try {
		const first = FileLock.tryAcquire(lockPath);
		expect(first.acquired).toBe(true);

		const blocked = FileLock.tryAcquire(lockPath);
		expect(blocked.acquired).toBe(false);
		blocked.release();

		first.release();
		const successor = FileLock.tryAcquire(lockPath);
		expect(successor.acquired).toBe(true);

		first.release();
		const third = FileLock.tryAcquire(lockPath);
		expect(third.acquired).toBe(false);
		third.release();
		expect(successor.acquired).toBe(true);

		const usesInMemoryName = process.platform === "linux" || process.platform === "win32";
		expect(await Bun.file(lockPath).exists()).toBe(!usesInMemoryName);

		successor.release();
		const finalOwner = FileLock.tryAcquire(lockPath);
		expect(finalOwner.acquired).toBe(true);
		finalOwner.release();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("native runtime installation waits for the cross-process owner", () => {
	const events: string[] = [];
	let attempts = 0;
	const bindings = {
		FileLock: {
			tryAcquire() {
				attempts += 1;
				const acquired = attempts === 2;
				return {
					acquired,
					release() {
						events.push(acquired ? "release:owner" : "release:blocked");
					},
				};
			},
		},
		__ompInstallTokioRuntime() {
			events.push("install");
		},
	};

	withNativeRuntimeInstallLock(bindings.FileLock, bindings.__ompInstallTokioRuntime, () => events.push("wait"));

	expect(events).toEqual(["release:blocked", "wait", "install", "release:owner"]);
});
