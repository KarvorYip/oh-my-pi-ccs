import * as fs from "node:fs";
import { loadNative } from "./loader-state.js";

let native;
function api() {
	native ??= loadNative();
	return native;
}
function vcsError(code, message) {
	const error = new Error(message);
	error.name = "VcsError";
	error.code = code;
	error.exitCode = 1;
	error.stdout = "";
	error.stderr = message;
	return error;
}

const windowsGitRepositories = new WeakMap();

async function gitStatusPorcelain(root, options = {}, signal) {
	const untracked = options.untracked ?? "normal";
	if (untracked !== "no" && untracked !== "normal" && untracked !== "all") {
		throw vcsError("Backend", `unsupported untracked mode: ${untracked}`);
	}
	const argv = ["git", "--no-optional-locks", "-C", root, "status", "--porcelain=v1", `--untracked-files=${untracked}`];
	if (options.nulTerminated) argv.push("-z");
	if (options.pathspecs?.length) argv.push("--", ...options.pathspecs);
	let proc;
	try {
		proc = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			...(signal instanceof AbortSignal ? { signal } : {}),
		});
	} catch (error) {
		throw vcsError("Backend", `git status failed to start: ${error instanceof Error ? error.message : String(error)}`);
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw vcsError("Backend", stderr.trim() || `git status exited with code ${exitCode}`);
	}
	return stdout;
}

function wrapWindowsGitRepository(repository, root) {
	if (!repository || process.platform !== "win32") return repository;
	const cached = windowsGitRepositories.get(repository);
	if (cached) return cached;
	const boundMethods = new Map();
	const proxy = new Proxy(repository, {
		get(target, property) {
			if (property === "statusPorcelain") {
				return (options, signal) => gitStatusPorcelain(root, options, signal);
			}
			if (property === "statusSummary") {
				return async signal => {
					const text = await gitStatusPorcelain(root, { untracked: "normal" }, signal);
					const summary = { staged: 0, unstaged: 0, untracked: 0 };
					for (const line of text.split(/\r?\n/u)) {
						if (line.length < 2) continue;
						if (line.startsWith("??")) summary.untracked += 1;
						else {
							if (line[0] !== " ") summary.staged += 1;
							if (line[1] !== " ") summary.unstaged += 1;
						}
					}
					return summary;
				};
			}
			if (property === "isDirty") {
				return async signal => (await gitStatusPorcelain(root, { untracked: "normal" }, signal)).length > 0;
			}
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			let bound = boundMethods.get(property);
			if (!bound) {
				bound = value.bind(target);
				boundMethods.set(property, bound);
			}
			return bound;
		},
	});
	windowsGitRepositories.set(repository, proxy);
	return proxy;
}

/**
 * True when `error` is a native VCS failure. The native layer constructs these
 * on the JS thread as real `Error` objects with `name: "VcsError"`, a
 * machine-readable `code`, and `exitCode`/`stdout`/`stderr` properties — an
 * `instanceof` check is impossible for foreign-constructed errors, so identity
 * rides on `name`.
 */
export function isVcsError(error) {
	return error instanceof Error && error.name === "VcsError";
}

/** True when a cherry-pick failed because the commit is already applied. */
export function isEmptyCherryPick(error) {
	return isVcsError(error) && error.code === "EmptyCherryPick";
}

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export function git(dir) {
	const discovered = api().vcsGitDiscover(dir);
	return wrapWindowsGitRepository(discovered, discovered?.info().repoRoot);
}
/** Discover the repository owning `dir`; `null` outside any repository. */
export function repo(dir) {
	const discovered = api().vcsDiscover(dir);
	return discovered?.kind() === "git" ? wrapWindowsGitRepository(discovered, discovered.root()) : discovered;
}

/** Like {@link repo}, asserting any requested backend capabilities. */
export function require(dir, ...features) {
	const discovered = repo(dir);
	if (!discovered) throw vcsError("NotARepository", `not a repository: ${dir}`);
	for (const feature of features) {
		if (!discovered.supports(feature)) {
			throw vcsError(
				"Unsupported",
				`\`${feature}\` is not supported on a ${discovered.kind()} repository`,
			);
		}
	}
	return discovered;
}

/** Like {@link git}, but throws a `NotARepository` VcsError. */
export function requireGit(dir) {
	const repo = git(dir);
	if (!repo) {
		throw vcsError("NotARepository", `not a repository: ${dir}`);
	}
	return repo;
}

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export function gitInfo(dir) {
	return api().vcsGitRepoInfo(dir);
}

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export function jj(dir) {
	return api().vcsJjDiscover(dir);
}

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export function isPureJj(dir) {
	return api().vcsIsPureJj(dir);
}

/** Clone a repository (git CLI under the hood for credential parity). */
export function clone(url, target, options = {}, signal) {
	return api().vcsGitClone(url, target, options, signal);
}

/** Sever a copied working tree from shared git metadata. */
export function detachGitDir(worktreeRoot, sourceCommonDir, signal) {
	return api().vcsDetachGitDir(worktreeRoot, sourceCommonDir, signal);
}

/** Join patch fragments, preserving each part's trailing newline. */
export function joinPatches(parts) {
	return api().vcsJoinPatches(parts);
}

/** Validate hunk selections against a raw diff. */
export function validateHunkSelections(rawDiff, selections) {
	return api().vcsValidateHunkSelections(rawDiff, selections);
}

/** Stat-poll interval for {@link watch}. */
export const HEAD_WATCH_INTERVAL_MS = 1000;

/**
 * Watch a repository for head changes; returns a disposer.
 *
 * Stat-polls via `fs.watchFile` instead of `fs.watch`: backends may atomically
 * replace the watched entry, permanently silencing inotify-backed watchers.
 */
export function watch(repo, onChange, intervalMs = HEAD_WATCH_INTERVAL_MS) {
	const target = repo.watchTarget();
	const listener = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
	};
	fs.watchFile(target, { interval: intervalMs }, listener).unref();
	return () => fs.unwatchFile(target, listener);
}
