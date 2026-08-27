/**
 * ccs-custom regression: the natives loader must keep the version-pinned
 * cache (~/.omp/natives/<version>/, maintained by the native omp binary)
 * ahead of the repo-local addon so selfbuild rebuilds never contend with
 * the Windows write lock running omp sessions hold on packages/natives/native.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveLoaderCandidates } from "../native/loader-state.js";

describe("ccs-custom natives loader candidates", () => {
	it("prefers the version-pinned cache over the repo-local addon and keeps the original fallbacks", () => {
		const addon = "pi_natives.win32-x64-baseline.node";
		const versionedDir = path.join("/home", ".omp", "natives", "18.0.6");
		const nativeDir = path.join("/repo", "packages", "natives", "native");
		const execDir = path.join("/bun", "bin");

		const candidates = resolveLoaderCandidates({
			addonFilenames: [addon],
			isCompiledBinary: false,
			nativeDir,
			leafPackageDir: null,
			execDir,
			versionedDir,
			userDataDir: "/userdata",
		});

		expect(candidates[0]).toBe(path.join(versionedDir, addon));
		expect(candidates).toContain(path.join(nativeDir, addon));
		expect(candidates).toContain(path.join(execDir, addon));
	});
});
