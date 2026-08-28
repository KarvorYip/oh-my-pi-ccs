#!/usr/bin/env python3
"""ccs-custom 源码自建通道构建脚本（ADR 0005：fork 分支 + rebase）。

随 fork 分支分发（仓库根目录），不依赖任何本机绝对路径：
- 工作副本 = 本脚本所在仓库（origin=fork，upstream=can1357/oh-my-pi）；
- 目标版本 = native omp --version（~/.local/bin/omp.exe，omp 官方安装位置）；
- 原生 .node = ~/.omp/natives/<版本>/（native omp 自解压维护），
  bun 全局包 @oh-my-pi/pi-natives-win32-x64 仅作兜底。

流程：rebase ccs-custom @ v<版本> → natives 就位 → bun install → gen:bundle
→ 注入标记终验 → 推送 fork。失败语义：任一步失败即退出非零、不改动已可用的
旧 dist，omp-ccs 启动链下次启动重试。版本戳由 omp-ccs.ps1 同步块写入。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
NATIVE_OMP_DEFAULT = Path.home() / ".local" / "bin" / "omp.exe"
NATIVES_CACHE_DEFAULT = Path.home() / ".omp" / "natives"
BUN_NATIVES_DEFAULT = (
	Path.home() / ".bun" / "install" / "global" / "node_modules" / "@oh-my-pi" / "pi-natives-win32-x64"
)

BRANCH = "ccs-custom"
UPSTREAM_REMOTE = "upstream"
ADDON_NAMES = (
	"pi_natives.win32-x64-modern.node",
	"pi_natives.win32-x64-baseline.node",
	"pi_natives.win32-x64.node",
)
# 注入语义终验标记（与补丁器 SELFBUILD_MARKERS 一致）：自建 dist 由源码 commits
# 内联注入，三个标记齐全即视为构建正确。
SELFBUILD_MARKERS = ("__ompCcsWelcomeLabels", "getThinkingState", "getAdvisorOverview")


class SelfbuildError(RuntimeError):
	pass


def log(message: str) -> None:
	print(f"[ccs-selfbuild] {message}")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
	kwargs.setdefault("capture_output", True)
	kwargs.setdefault("text", True)
	kwargs.setdefault("encoding", "utf-8")
	kwargs.setdefault("errors", "replace")
	completed = subprocess.run(cmd, **kwargs)
	if completed.returncode != 0:
		detail = (completed.stderr or completed.stdout or "").strip().splitlines()
		tail = "\n".join(detail[-8:])
		raise SelfbuildError(f"命令失败（{completed.returncode}）：{' '.join(cmd)}\n{tail}")
	return completed


def detect_target_version(native_omp: Path, override: str | None) -> str:
	if override:
		return override
	if not native_omp.is_file():
		raise SelfbuildError(f"找不到 native omp：{native_omp}")
	output = run([str(native_omp), "--version"]).stdout.strip().splitlines()
	version = output[0].strip() if output else ""
	if not version.startswith("omp/"):
		raise SelfbuildError(f"native omp 版本输出异常：{version!r}")
	return version.removeprefix("omp/")


def git(src: Path, *args: str) -> subprocess.CompletedProcess[str]:
	return run(["git", "-C", str(src), *args])


def prepare_branch(src: Path, version: str) -> None:
	if not (src / ".git").exists():
		raise SelfbuildError(f"源码工作副本不存在：{src}")
	dirty = git(src, "status", "--porcelain", "-uno").stdout.strip()
	if dirty:
		raise SelfbuildError(f"源码工作副本有未提交改动，先处理后再构建：\n{dirty}")
	branch = git(src, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
	if branch != BRANCH:
		git(src, "checkout", BRANCH)
	log(f"fetch {UPSTREAM_REMOTE} --tags …")
	git(src, "fetch", UPSTREAM_REMOTE, "--tags", "--prune", "--force")
	tag = f"v{version}"
	git(src, "rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}")
	log(f"rebase {BRANCH} @ {tag} …")
	rebase = subprocess.run(
		["git", "-C", str(src), "rebase", tag],
		capture_output=True,
		text=True,
		encoding="utf-8",
		errors="replace",
	)
	if rebase.returncode != 0:
		subprocess.run(
			["git", "-C", str(src), "rebase", "--abort"],
			capture_output=True,
			text=True,
		)
		detail = (rebase.stderr or rebase.stdout or "").strip().splitlines()
		raise SelfbuildError(
			f"rebase 到 {tag} 冲突，已还原分支；请人工解决后重跑：\n" + "\n".join(detail[-8:])
		)


def find_native_addons(version: str) -> list[Path]:
	sources = [NATIVES_CACHE_DEFAULT / version, BUN_NATIVES_DEFAULT]
	found: list[Path] = []
	for source in sources:
		if not source.is_dir():
			continue
		# 兜底源必须版本精确匹配：版本错配的 .node 缺新导出符号（如 18.0.9 的
		# vcsGitDiscover），构建期能过、运行期才炸（status-line 每帧抛异常）。
		# 版本化缓存目录名即版本，天然匹配；bun 全局包读 package.json 校验。
		if source == BUN_NATIVES_DEFAULT:
			try:
				manifest = json.loads((source / "package.json").read_text(encoding="utf-8"))
			except (OSError, ValueError):
				manifest = {}
			if str(manifest.get("version")) != version:
				log(f"跳过兜底源（版本 {manifest.get('version')} ≠ {version}）：{source}")
				continue
		for name in ADDON_NAMES:
			candidate = source / name
			if candidate.is_file():
				found.append(candidate)
		if found:
			log(f"原生模块来源：{source}")
			return found
	raise SelfbuildError(
		f"找不到版本匹配的原生 .node（{version}）；已尝试："
		+ "、".join(str(s) for s in sources)
		+ "。先运行一次 native omp 触发解压。"
	)


def verify_dist(dist: Path, version: str, bun: str) -> None:
	smoke = subprocess.run(
		[bun, str(dist), "--version"],
		capture_output=True,
		text=True,
		encoding="utf-8",
		errors="replace",
	)
	if smoke.returncode != 0 or smoke.stdout.strip() != f"omp/{version}":
		raise SelfbuildError(
			f"版本冒烟失败（exit={smoke.returncode}）：{smoke.stdout.strip() or smoke.stderr.strip()}"
		)
	log(f"版本冒烟通过：omp/{version}")
	text = dist.read_text(encoding="utf-8", errors="surrogateescape")
	missing = [marker for marker in SELFBUILD_MARKERS if marker not in text]
	if missing:
		raise SelfbuildError(f"注入标记终验失败，缺失：{', '.join(missing)}")
	log("注入标记终验通过。")


def main() -> int:
	parser = argparse.ArgumentParser(prog="ccs-selfbuild.py")
	parser.add_argument("--src", default=str(REPO_ROOT), help="源码工作副本（默认本脚本所在仓库）")
	parser.add_argument("--native", default=str(NATIVE_OMP_DEFAULT), help="native omp.exe（版本源）")
	parser.add_argument("--target-version", help="覆盖目标版本（默认取 native omp --version）")
	parser.add_argument("--skip-push", action="store_true", help="跳过向 fork 推送 rebased 分支")
	args = parser.parse_args()

	src = Path(args.src)
	native_omp = Path(args.native)

	try:
		version = detect_target_version(native_omp, args.target_version)
		log(f"目标版本：{version}")
		prepare_branch(src, version)

		addons = find_native_addons(version)
		natives_target = src / "packages" / "natives" / "native"
		# 仅在缺失时落盘：运行中的 omp 会话对 repo 内 .node 持写锁，重复覆盖会
		# Permission denied；loader（ccs-custom）优先用版本化缓存目录，repo 副本只是兜底。
		staged = []
		for addon in addons:
			destination = natives_target / addon.name
			if not destination.exists():
				shutil.copy2(addon, destination)
				staged.append(addon.name)
		log(f"原生模块就位：{', '.join(a.name for a in addons)}（新落盘 {len(staged)}）")

		bun = shutil.which("bun")
		if not bun:
			raise SelfbuildError("PATH 中找不到 bun。")
		log("bun install …")
		run([bun, "install"], cwd=str(src))
		log("gen:bundle …")
		run([bun, "run", "gen:bundle"], cwd=str(src / "packages" / "coding-agent"))

		# dist 非自包含：@babel/parser、puppeteer-core、@oh-my-pi/pi-natives 为
		# RUNTIME_EXTERNAL/ALWAYS_EXTERNAL，须从工作副本 node_modules 解析，故产物
		# 直接留在源码工作副本内运行（omp-ccs 接线指向该路径）。
		dist = src / "packages" / "coding-agent" / "dist" / "cli.js"
		if not dist.is_file() or dist.stat().st_size == 0:
			raise SelfbuildError(f"构建产物缺失：{dist}")
		log(f"产物就绪：{dist}")

		verify_dist(dist, version, bun)

		if not args.skip_push:
			push = subprocess.run(
				["git", "-C", str(src), "push", "origin", BRANCH, "--force-with-lease"],
				capture_output=True,
				text=True,
				encoding="utf-8",
				errors="replace",
			)
			if push.returncode == 0:
				log("已推送 ccs-custom 到 fork。")
			else:
				log(f"WARN: 推送 fork 失败（不影响本次构建）：{(push.stderr or push.stdout or '').strip()}")
	except (OSError, SelfbuildError) as error:
		print(f"[ccs-selfbuild] FAIL: {error}", file=sys.stderr)
		return 1
	log(f"自建完成：omp/{version} → {dist}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
