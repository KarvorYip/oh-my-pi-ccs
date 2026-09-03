import { afterEach, expect, test, vi } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vcs from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "ignore" });
	const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
	if (exitCode !== 0) throw new Error(stderr);
}

async function flushFileSystemEvents(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-windows-status-"));
	roots.push(root);
	await git(root, "init", "-q");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await writeFile(join(root, "tracked.txt"), "tracked\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-qm", "initial");
	return root;
}

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

test.skipIf(process.platform !== "win32")("Windows status does not create index.lock", async () => {
	const root = await repository();
	let lockCreated = false;
	const watcher = watch(join(root, ".git"), (_event, filename) => {
		if (filename === "index.lock") lockCreated = true;
	});

	try {
		await vcs.git(root)!.statusSummary();
		await flushFileSystemEvents();
	} finally {
		watcher.close();
	}

	expect(lockCreated).toBe(false);
});
