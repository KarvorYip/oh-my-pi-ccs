/**
 * omp-claude-mem 插件契约测试。
 *
 * 守护的可观察契约：
 * 1. 注入位置固定：记忆块只出现在第一条 user 消息的内容头部，绝不追加到末尾。
 * 2. 字节稳定：同一会话（同一消息对象跨数组复用）的注入结果对象身份一致；
 *    已注入的消息不再重复注入（幂等）。
 * 3. 冻结存储跨进程复用：写入后新实例（模拟 resume 新进程）读到同一字节；
 *    TTL 过期后视为缺失；损坏文件不崩溃。
 * 4. 注入器：worker 不可用不注入且不渲染；缓存命中不重复渲染；并发渲染去重；
 *    渲染失败不写缓存、下一请求重试；warm 只渲染不注入。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	type ContextInjector,
	FrozenContextStore,
	createContextInjector,
	injectContextBlock,
	type InjectableMessage,
	wrapContextBlock,
} from "../index";

const BLOCK = wrapContextBlock("# [work] recent context, 2026-09-01 4:00pm GMT+8\n### Sep 1, 2026\n48886 3:36p ✓ 修复登录态");

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "omp-claude-mem-test-"));
}

function userMessage(text: string): InjectableMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

describe("injectContextBlock", () => {
	it("在第一条 user 消息内容头部注入块，其它消息不动", () => {
		const messages: InjectableMessage[] = [
			userMessage("first"),
			{ role: "assistant", content: "a reply" },
			userMessage("second"),
		];
		const out = injectContextBlock(messages, BLOCK);
		expect(out).toHaveLength(3);
		const first = out[0]!.content as Array<{ type?: string; text?: string }>;
		expect(first[0]).toEqual({ type: "text", text: BLOCK });
		expect((first[1] as { text?: string }).text).toBe("first");
		expect(out[1]).toBe(messages[1]);
		expect(out[2]).toBe(messages[2]);
	});

	it("同一消息对象跨数组复用返回同一注入对象（字节稳定）", () => {
		const first = userMessage("shared first message object");
		const a: InjectableMessage[] = [first, { role: "assistant", content: "x" }];
		const b: InjectableMessage[] = [first, { role: "assistant", content: "y" }, userMessage("z")];
		const outA = injectContextBlock(a, BLOCK);
		const outB = injectContextBlock(b, BLOCK);
		// append-only context 路径：每轮数组是新拷贝，但消息对象复用——
		// 注入结果必须是同一对象，才能保证请求间前缀字节一致。
		expect(outA[0]).toBe(outB[0]);
	});

	it("已注入的消息幂等：再次注入返回原数组", () => {
		const messages: InjectableMessage[] = [userMessage("first")];
		const once = injectContextBlock(messages, BLOCK);
		expect(once).not.toBe(messages);
		const twice = injectContextBlock(once, BLOCK);
		expect(twice).toBe(once);
	});

	it("字符串内容的消息以块为前缀注入", () => {
		const messages: InjectableMessage[] = [{ role: "user", content: "plain string" }];
		const out = injectContextBlock(messages, BLOCK);
		expect(out[0]!.content).toBe(`${BLOCK}\n\nplain string`);
	});

	it("没有 user 消息时原样返回", () => {
		const messages: InjectableMessage[] = [{ role: "assistant", content: "hi" }];
		expect(injectContextBlock(messages, BLOCK)).toBe(messages);
	});

	it("换一块内容会重新注入（同对象不同块）", () => {
		const first = userMessage("first");
		const outA = injectContextBlock([first], BLOCK);
		const outB = injectContextBlock([first], wrapContextBlock("other"));
		expect(outA[0]).not.toBe(outB[0]);
		const contentB = outB[0]!.content as Array<{ type?: string; text?: string }>;
		expect(contentB[0]!.text).toContain("other");
	});
});

describe("FrozenContextStore", () => {
	it("跨实例（模拟 resume 新进程）读到同一冻结字节", async () => {
		const dir = tempDir();
		try {
			const file = join(dir, "frozen.json");
			const storeA = new FrozenContextStore({ file, freshMs: 60_000 });
			await storeA.set("proj", "session-1", BLOCK);
			const storeB = new FrozenContextStore({ file, freshMs: 60_000 });
			expect(await storeB.get("proj", "session-1")).toBe(BLOCK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("不同 session 互不影响", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "frozen.json"), freshMs: 60_000 });
			await store.set("proj", "session-1", "block-1");
			await store.set("proj", "session-2", "block-2");
			expect(await store.get("proj", "session-1")).toBe("block-1");
			expect(await store.get("proj", "session-2")).toBe("block-2");
			expect(await store.get("other", "session-1")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("TTL 过期后 get 视为缺失，getRaw 仍可读", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "frozen.json"), freshMs: 0 });
			await store.set("proj", "session-1", BLOCK);
			expect(await store.get("proj", "session-1")).toBeUndefined();
			expect(await store.getRaw("proj", "session-1")).toBe(BLOCK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("损坏的缓存文件不崩溃，从空存储开始", async () => {
		const dir = tempDir();
		try {
			const file = join(dir, "frozen.json");
			await Bun.write(file, "{not json");
			const store = new FrozenContextStore({ file, freshMs: 60_000 });
			expect(await store.get("proj", "session-1")).toBeUndefined();
			await store.set("proj", "session-1", BLOCK);
			expect(await store.get("proj", "session-1")).toBe(BLOCK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createContextInjector", () => {
	function makeInjector(options: {
		store: FrozenContextStore;
		fetch: (project: string) => Promise<string | undefined>;
		probe: () => Promise<boolean>;
		timeoutMs?: number;
	}): { injector: ContextInjector; fetchCalls: string[] } {
		const fetchCalls: string[] = [];
		const injector = createContextInjector({
			store: options.store,
			fetchContext: async project => {
				fetchCalls.push(project);
				return options.fetch(project);
			},
			probeWorker: options.probe,
			timeoutMs: options.timeoutMs ?? 2_000,
		});
		return { injector, fetchCalls };
	}

	it("worker 不可用：不注入、不渲染", async () => {
		const dir = tempDir();
		try {
			const { injector, fetchCalls } = makeInjector({
				store: new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 }),
				fetch: async () => BLOCK,
				probe: async () => false,
			});
			const messages = [userMessage("hi")];
			expect(await injector.inject("proj", "s1", messages)).toBeUndefined();
			expect(fetchCalls).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("缓存命中：不重复渲染，注入冻结字节", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			await store.set("proj", "s1", BLOCK);
			const { injector, fetchCalls } = makeInjector({ store, fetch: async () => "SHOULD NOT FETCH", probe: async () => true });
			const out = await injector.inject("proj", "s1", [userMessage("hi")]);
			expect(fetchCalls).toEqual([]);
			const content = out![0]!.content as Array<{ type?: string; text?: string }>;
			expect(content[0]!.text).toBe(BLOCK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("首次渲染成功：冻结并持久化，后续请求不再渲染", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			const { injector, fetchCalls } = makeInjector({ store, fetch: async () => BLOCK, probe: async () => true });
			const out1 = await injector.inject("proj", "s1", [userMessage("hi")]);
			expect(out1).toBeDefined();
			expect(fetchCalls).toEqual(["proj"]);
			const out2 = await injector.inject("proj", "s1", [userMessage("hi again")]);
			expect(fetchCalls).toEqual(["proj"]);
			expect(out2![0]).not.toBe(out1![0]); // 不同消息对象 → 不同注入对象，但字节一致
			const content = out2![0]!.content as Array<{ type?: string; text?: string }>;
			expect(content[0]!.text).toBe(BLOCK);
			// 新 store 实例（模拟 resume）也能拿到冻结字节
			const storeB = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			expect(await storeB.get("proj", "s1")).toBe(BLOCK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("并发渲染去重：同一会话同时请求只渲染一次", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			const { injector, fetchCalls } = makeInjector({
				store,
				fetch: async () => {
					await Bun.sleep(20);
					return BLOCK;
				},
				probe: async () => true,
			});
			const [a, b] = await Promise.all([
				injector.inject("proj", "s1", [userMessage("a")]),
				injector.inject("proj", "s1", [userMessage("b")]),
			]);
			expect(a).toBeDefined();
			expect(b).toBeDefined();
			expect(fetchCalls).toEqual(["proj"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("渲染失败：不注入、不写缓存，下一请求重试", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			let fail = true;
			const { injector, fetchCalls } = makeInjector({
				store,
				fetch: async () => (fail ? undefined : BLOCK),
				probe: async () => true,
			});
			expect(await injector.inject("proj", "s1", [userMessage("hi")])).toBeUndefined();
			expect(fetchCalls).toEqual(["proj"]);
			expect(await store.get("proj", "s1")).toBeUndefined();
			fail = false;
			const out = await injector.inject("proj", "s1", [userMessage("hi")]);
			expect(out).toBeDefined();
			expect(fetchCalls).toEqual(["proj", "proj"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("渲染超时：有界等待后返回 undefined，不注入", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			const { injector } = makeInjector({
				store,
				fetch: () => new Promise(() => undefined), // 永不返回
				probe: async () => true,
				timeoutMs: 50,
			});
			expect(await injector.inject("proj", "s1", [userMessage("hi")])).toBeUndefined();
			expect(await store.get("proj", "s1")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("同一会话连续两轮请求的共享前缀字节一致（回归：防逐轮重渲染/末尾追加）", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			const { injector } = makeInjector({ store, fetch: async () => BLOCK, probe: async () => true });
			const user1 = userMessage("turn one");
			const turn1 = await injector.inject("proj", "s1", [user1]);
			expect(turn1).toBeDefined();
			// 第二轮：同一 user1 消息对象（append-only 路径复用对象）+ 新消息
			const turn2 = await injector.inject("proj", "s1", [
				user1,
				{ role: "assistant", content: "a1" },
				userMessage("turn two"),
			]);
			expect(turn2).toBeDefined();
			expect(turn2!.length).toBeGreaterThan(turn1!.length);
			// 共享前缀（turn1 的全部条目）逐条字节一致——任何「每轮新渲染块 /
			// 向末尾追加块」的回归都会让这里变红。
			for (let i = 0; i < turn1!.length; i++) {
				expect(JSON.stringify(turn2![i])).toBe(JSON.stringify(turn1![i]));
			}
			// 块必须位于第一条 user 消息内容头部（固定位置），而不是独立追加的条目
			const first = turn1![0]!.content as Array<{ type?: string; text?: string }>;
			expect(first[0]).toEqual({ type: "text", text: BLOCK });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("warm 只渲染冻结、不注入；随后 inject 命中缓存", async () => {
		const dir = tempDir();
		try {
			const store = new FrozenContextStore({ file: join(dir, "f.json"), freshMs: 60_000 });
			const { injector, fetchCalls } = makeInjector({ store, fetch: async () => BLOCK, probe: async () => true });
			await injector.warm("proj", "s1");
			expect(fetchCalls).toEqual(["proj"]);
			expect(await store.get("proj", "s1")).toBe(BLOCK);
			const out = await injector.inject("proj", "s1", [userMessage("hi")]);
			expect(fetchCalls).toEqual(["proj"]);
			const content = out![0]!.content as Array<{ type?: string; text?: string }>;
			expect(content[0]!.text).toBe(BLOCK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
