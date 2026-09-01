/**
 * omp ↔ claude-mem compatibility extension (migrated into the ccs-custom fork).
 *
 * 注入模型（缓存安全）:
 * - 记忆时间线每个 (project, session) 只渲染一次并「冻结」：同一会话（含跨进程
 *   `-c` 续会话）的所有请求注入完全相同的字节，位置固定——第一条 user 消息的
 *   首个 text 块。字节稳定保证 OpenAI 兼容中继的严格前缀缓存不被破坏。
 * - 旧实现（`~/.local/bin/omp-claude-mem.ts`）在每次 `context` 事件都向消息
 *   流末尾追加一条新渲染的块；每次渲染的时间戳/统计都在变，请求间字节不一致，
 *   导致 codex 线路前缀缓存失效、命中率钉死在 system+tools 前缀大小。
 *   本实现不再逐轮追加。
 * - 记忆新鲜度由 `memory_recall` 工具覆盖；时间线随新会话 / 缓存 TTL 过期刷新。
 *
 * 思路来源：https://github.com/ArtemisAI/pi-mem 的 pi-agent-memory 0.3.4（AGPL-3.0）。
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Static } from "@oh-my-pi/pi-ai";

const DEFAULT_WORKER_HOST = "127.0.0.1";
const DEFAULT_WORKER_PORT = 37777;
const WORKER_TIMEOUT_MS = 10_000;
const WORKER_HEALTH_TIMEOUT_MS = 250;
const CONTEXT_REQUEST_TIMEOUT_MS = 20_000;
const CONTEXT_INJECT_TIMEOUT_MS = 3_000;
const WORKER_INTERACTIVE_TIMEOUT_MS = 2_000;
const TOOL_RESPONSE_LIMIT = 1000;
const PLATFORM_SOURCE = "pi-agent";
/** 冻结上下文缓存条目 TTL；过期后下一个请求重新渲染并重新冻结（env 可覆盖）。 */
const DEFAULT_CONTEXT_FRESH_MS = 6 * 60 * 60 * 1000;
const SENSITIVE_KEY_SOURCE =
	"authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|device[-_]?id|android[-_]?id|advertising[-_]?id|install(?:ation)?[-_]?id|idfa|idfv|imei|meid|oaid|gaid";
const SENSITIVE_KEY_PATTERN = new RegExp(SENSITIVE_KEY_SOURCE, "i");
const SENSITIVE_TEXT_KEY_SOURCE = `["']?[A-Za-z0-9_-]*(?:${SENSITIVE_KEY_SOURCE})[A-Za-z0-9_-]*["']?`;
const SENSITIVE_QUOTED_VALUE_PATTERN = new RegExp(
	`(^|[^A-Za-z0-9_-])(${SENSITIVE_TEXT_KEY_SOURCE}\\s*[:=]\\s*)(["'])[^"'\\r\\n]*\\3`,
	"gim",
);
const SENSITIVE_VALUE_PATTERN = new RegExp(
	`(^|[^A-Za-z0-9_-])(${SENSITIVE_TEXT_KEY_SOURCE}\\s*[:=]\\s*)(?!["'])[^\\s,;}\\]]+`,
	"gim",
);

/** 结构化的可注入消息（与 `AgentMessage` 结构兼容的最小面）。 */
export type InjectableMessage = {
	role?: string;
	content?: string | Array<{ type?: string; text?: string } | Record<string, unknown>>;
	[key: string]: unknown;
};

export type WorkerSettings = Record<string, unknown>;

function readSettings(): WorkerSettings {
	try {
		const dataDir = process.env.CLAUDE_MEM_DATA_DIR?.trim() || join(homedir(), ".claude-mem");
		const value: unknown = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as WorkerSettings) : {};
	} catch {
		return {};
	}
}

function validPort(value: unknown): number | undefined {
	const port =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN;
	return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

function resolveContextFreshMs(): number {
	const raw = process.env.CLAUDE_MEM_CONTEXT_FRESH_MS?.trim();
	if (!raw) return DEFAULT_CONTEXT_FRESH_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_FRESH_MS;
}

const SETTINGS = readSettings();
const ENV_WORKER_HOST = process.env.CLAUDE_MEM_WORKER_HOST?.trim();
const SETTINGS_WORKER_HOST =
	typeof SETTINGS.CLAUDE_MEM_WORKER_HOST === "string" ? SETTINGS.CLAUDE_MEM_WORKER_HOST.trim() : "";
const WORKER_HOST = ENV_WORKER_HOST || SETTINGS_WORKER_HOST || DEFAULT_WORKER_HOST;
const WORKER_PORT =
	validPort(process.env.CLAUDE_MEM_WORKER_PORT) ?? validPort(SETTINGS.CLAUDE_MEM_WORKER_PORT) ?? DEFAULT_WORKER_PORT;
const CONTEXT_FRESH_MS = resolveContextFreshMs();
const CONTEXT_CACHE_FILE = join(
	process.env.CLAUDE_MEM_DATA_DIR?.trim() || join(homedir(), ".claude-mem"),
	"omp-frozen-context.json",
);

export function projectName(cwd: string): string {
	return process.env.PI_MEM_PROJECT?.trim() || basename(cwd);
}

export function wrapContextBlock(text: string): string {
	return `<claude-mem-context>\n${text}\n</claude-mem-context>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 脱敏（与旧实现一致：观察上报前剔除凭据类内容）
// ─────────────────────────────────────────────────────────────────────────────

export function redactSensitiveText(text: string): string {
	return text
		.replace(/(\b(?:authorization|cookie)\b\s*[:=]\s*)[^\r\n]+/gi, "$1[已脱敏]")
		.replace(SENSITIVE_QUOTED_VALUE_PATTERN, "$1$2$3[已脱敏]$3")
		.replace(SENSITIVE_VALUE_PATTERN, "$1$2[已脱敏]")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[已脱敏邮箱]")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[已脱敏标识]")
		.replace(/(?:\+?\d[\s-]?){7,18}\d/g, "[已脱敏号码]")
		.replace(/(^|[^A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{32,}(?=$|[^A-Za-z0-9+_=-])/g, "$1[已脱敏凭据]");
}

export function redactSensitiveValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) return "[已脱敏]";
	if (typeof value === "string") return redactSensitiveText(value);
	if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item, "", seen));
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[循环引用]";
	seen.add(value);

	const redacted: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		redacted[childKey] = redactSensitiveValue(childValue, childKey, seen);
	}
	return redacted;
}

// ─────────────────────────────────────────────────────────────────────────────
// 冻结上下文存储：按 (project, session) 固化渲染字节，跨进程复用
// ─────────────────────────────────────────────────────────────────────────────

interface FrozenEntry {
	text: string;
	renderedAt: number;
}

interface FrozenFileShape {
	version: 1;
	entries: Record<string, FrozenEntry>;
}

/**
 * 文件备份的「每会话冻结上下文」存储。
 *
 * 同一 (project, sessionId) 只渲染一次；会话内（含跨进程 resume）的所有请求
 * 都拿到同一字节串。TTL 过期后视为缺失，下一个请求重新渲染并覆盖。
 * 并发说明：多进程同时写同一文件时按 key 合并后落盘，极端竞态下以最后一次
 * 完整写入为准（上下文缓存，可接受）。
 */
export class FrozenContextStore {
	readonly file: string;
	readonly freshMs: number;
	#entries = new Map<string, FrozenEntry>();
	#loaded = false;

	constructor(options: { file: string; freshMs: number }) {
		this.file = options.file;
		this.freshMs = options.freshMs;
	}

	static key(project: string, sessionId: string): string {
		return `${project}::${sessionId}`;
	}

	async #load(): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		try {
			const raw = await Bun.file(this.file).text();
			const parsed = JSON.parse(raw) as FrozenFileShape;
			if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
				for (const [key, entry] of Object.entries(parsed.entries)) {
					if (entry && typeof entry.text === "string" && typeof entry.renderedAt === "number") {
						this.#entries.set(key, entry);
					}
				}
			}
		} catch {
			// 文件缺失或损坏：从空存储开始
		}
	}

	/** 返回未过期的冻结块；缺失或过期返回 undefined。 */
	async get(project: string, sessionId: string): Promise<string | undefined> {
		await this.#load();
		const entry = this.#entries.get(FrozenContextStore.key(project, sessionId));
		if (!entry) return undefined;
		if (Date.now() - entry.renderedAt > this.freshMs) return undefined;
		return entry.text;
	}

	/** 忽略 TTL 直接读（测试/诊断用）。 */
	async getRaw(project: string, sessionId: string): Promise<string | undefined> {
		await this.#load();
		return this.#entries.get(FrozenContextStore.key(project, sessionId))?.text;
	}

	async set(project: string, sessionId: string, text: string): Promise<void> {
		await this.#load();
		this.#entries.set(FrozenContextStore.key(project, sessionId), { text, renderedAt: Date.now() });
		await this.#persist();
	}

	async #persist(): Promise<void> {
		// 落盘前合并磁盘上其它进程写入的条目，缩小多进程竞态窗口。
		try {
			const raw = await Bun.file(this.file).text();
			const parsed = JSON.parse(raw) as FrozenFileShape;
			if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
				for (const [key, entry] of Object.entries(parsed.entries)) {
					if (!this.#entries.has(key) && entry && typeof entry.text === "string") {
						this.#entries.set(key, entry);
					}
				}
			}
		} catch {
			// 首次写入或文件损坏：以内存为准
		}
		const shape: FrozenFileShape = { version: 1, entries: Object.fromEntries(this.#entries) };
		const tmp = `${this.file}.tmp`;
		await Bun.write(tmp, JSON.stringify(shape));
		await fs.rename(tmp, this.file);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 注入：把冻结块固定进第一条 user 消息（幂等 + 字节稳定）
// ─────────────────────────────────────────────────────────────────────────────

const injectCache = new WeakMap<object, { block: string; injected: InjectableMessage }>();

function contentParts(content: InjectableMessage["content"]): Array<{ type?: string; text?: string }> {
	return Array.isArray(content)
		? content.filter((part): part is { type?: string; text?: string } => part !== null && typeof part === "object")
		: [];
}

function contentAlreadyHasBlock(message: InjectableMessage, block: string): boolean {
	const content = message.content;
	if (typeof content === "string") {
		return content.startsWith(block);
	}
	return contentParts(content).some(part => part.type === "text" && part.text === block);
}

function prependBlock(content: InjectableMessage["content"], block: string): InjectableMessage["content"] {
	if (typeof content === "string") {
		return `${block}\n\n${content}`;
	}
	return [{ type: "text", text: block }, ...(Array.isArray(content) ? content : [])];
}

/**
 * 把冻结的记忆块作为第一条 user 消息的首个 text 块注入。
 *
 * - 幂等：同一条消息对象经 memo 返回同一注入对象（append-only context 路径要求
 *   共享前缀的对象身份稳定）；已带该块的消息原样返回。
 * - 位置固定：块永远在第一条 user 消息内容头部——请求间字节稳定，
 *   不破坏 provider 前缀缓存。
 */
export function injectContextBlock(messages: InjectableMessage[], block: string): InjectableMessage[] {
	const index = messages.findIndex(message => message.role === "user");
	if (index < 0) return messages;
	const first = messages[index]!;
	if (contentAlreadyHasBlock(first, block)) return messages;
	const cached = injectCache.get(first);
	if (cached !== undefined && cached.block === block) {
		const out = messages.slice();
		out[index] = cached.injected;
		return out;
	}
	const injected = { ...first, content: prependBlock(first.content, block) };
	injectCache.set(first, { block, injected });
	const out = messages.slice();
	out[index] = injected;
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 注入器：每会话一次渲染 + 冻结 + 注入（可独立测试）
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextFetcher {
	(project: string): Promise<string | undefined>;
}

export interface WorkerProbe {
	(): Promise<boolean>;
}

export interface ContextInjector {
	inject(
		project: string,
		sessionId: string,
		messages: InjectableMessage[],
	): Promise<InjectableMessage[] | undefined>;
	warm(project: string, sessionId: string): Promise<void>;
}

/**
 * 构建上下文注入器。
 *
 * - 缓存命中（未过期）→ 直接注入冻结字节。
 * - 缓存未命中 → 等待一次真实的 context 渲染（有界超时），成功即冻结持久化；
 *   失败返回 undefined（本请求不注入，下一请求重试）——保证首轮注入可靠，
 *   避免「首轮缺失、次轮出现」造成的前缀断裂。
 * - 同一 (project, session) 的并发渲染去重。
 * - `warm` 只渲染+冻结、不注入（供 before_agent_start 预热，让首轮命中缓存）。
 */
export function createContextInjector(options: {
	store: FrozenContextStore;
	fetchContext: ContextFetcher;
	probeWorker: WorkerProbe;
	timeoutMs?: number;
}): ContextInjector {
	const inFlight = new Map<string, Promise<string | undefined>>();
	const timeoutMs = options.timeoutMs ?? CONTEXT_INJECT_TIMEOUT_MS;

	const renderAndFreeze = async (project: string, sessionId: string): Promise<string | undefined> => {
		const key = FrozenContextStore.key(project, sessionId);
		const existing = inFlight.get(key);
		if (existing) return existing;
		const promise = (async () => {
			const text = await Promise.race([
				options.fetchContext(project),
				Bun.sleep(timeoutMs).then(() => undefined),
			]);
			if (text === undefined) return undefined;
			await options.store.set(project, sessionId, text);
			return text;
		})();
		inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			inFlight.delete(key);
		}
	};

	return {
		async inject(project, sessionId, messages) {
			let block = await options.store.get(project, sessionId);
			if (block === undefined) {
				if (!(await options.probeWorker())) return undefined;
				block = await renderAndFreeze(project, sessionId);
				if (block === undefined) return undefined;
			}
			const injected = injectContextBlock(messages, block);
			return injected === messages ? undefined : injected;
		},
		async warm(project, sessionId) {
			const block = await options.store.get(project, sessionId);
			if (block !== undefined) return;
			if (!(await options.probeWorker())) return;
			await renderAndFreeze(project, sessionId);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 扩展装配
// ─────────────────────────────────────────────────────────────────────────────

export default function claudeMemExtension(pi: ExtensionAPI) {
	const { z } = pi.zod;
	const pendingObservations = new Set<Promise<void>>();
	let workerAvailable = false;
	const store = new FrozenContextStore({ file: CONTEXT_CACHE_FILE, freshMs: CONTEXT_FRESH_MS });

	async function workerFetch(path: string, init?: RequestInit, timeoutMs = WORKER_TIMEOUT_MS): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`http://${WORKER_HOST}:${WORKER_PORT}${path}`, {
				...init,
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`claude-mem worker HTTP ${response.status}`);
			return response;
		} catch (error) {
			workerAvailable = false;
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async function probeWorker(): Promise<boolean> {
		try {
			await workerFetch("/api/health", undefined, WORKER_HEALTH_TIMEOUT_MS);
			workerAvailable = true;
			return true;
		} catch {
			return false;
		}
	}

	async function workerPost(path: string, body: Record<string, unknown>): Promise<void> {
		await workerFetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(redactSensitiveValue(body)),
		});
	}

	function contentText(content: unknown, limit = Number.POSITIVE_INFINITY): string {
		const chunks =
			typeof content === "string"
				? [content]
				: Array.isArray(content)
					? content.flatMap(block => {
							if (!block || typeof block !== "object") return [];
							const candidate = block as { type?: unknown; text?: unknown };
							return candidate.type === "text" && typeof candidate.text === "string"
								? [candidate.text]
								: [];
						})
					: [];
		const text = chunks.join("\n");
		if (text.length <= limit) return text;
		const suffix = "…[已截断]";
		return text.slice(0, limit - suffix.length) + suffix;
	}

	function lastAssistantText(messages: ReadonlyArray<{ role?: string; content?: unknown }>): string {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role === "assistant") return contentText(message.content);
		}
		return "";
	}

	const fetchContext = async (project: string): Promise<string | undefined> => {
		try {
			const response = await workerFetch(
				`/api/context/inject?projects=${encodeURIComponent(project)}&platformSource=${encodeURIComponent(PLATFORM_SOURCE)}`,
				undefined,
				CONTEXT_REQUEST_TIMEOUT_MS,
			);
			const text = await response.text();
			if (!text.trim()) return undefined;
			return wrapContextBlock(text);
		} catch {
			return undefined;
		}
	};

	const injector = createContextInjector({ store, fetchContext, probeWorker });

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		if (!(await probeWorker())) return;
		await workerPost("/api/sessions/init", {
			contentSessionId: sessionId,
			project: projectName(ctx.cwd),
			prompt: event.prompt,
			platformSource: PLATFORM_SOURCE,
		}).catch(() => undefined);
		if (!workerAvailable) return;
		// 预热：首轮 context 事件命中冻结缓存，而不是现场等待渲染
		void injector.warm(projectName(ctx.cwd), sessionId);
	});

	pi.on("context", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const messages = await injector.inject(
			projectName(ctx.cwd),
			sessionId,
			event.messages as unknown as InjectableMessage[],
		);
		if (messages === undefined) return;
		return { messages: messages as unknown as typeof event.messages };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "memory_recall" || !workerAvailable) return;
		const observation = workerPost("/api/sessions/observations", {
			contentSessionId: ctx.sessionManager.getSessionId(),
			tool_name: event.toolName,
			tool_input: event.input,
			tool_response: contentText(event.content, TOOL_RESPONSE_LIMIT),
			cwd: ctx.cwd,
			platformSource: PLATFORM_SOURCE,
		}).catch(() => undefined);
		pendingObservations.add(observation);
		void observation
			.finally(() => pendingObservations.delete(observation))
			.catch(() => undefined);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue || !workerAvailable) return;
		await Promise.all(pendingObservations);
		if (!workerAvailable) return;
		await workerPost("/api/sessions/summarize", {
			contentSessionId: ctx.sessionManager.getSessionId(),
			last_assistant_message: lastAssistantText(event.messages),
			platformSource: PLATFORM_SOURCE,
		}).catch(() => undefined);
	});

	const memoryRecallParameters = z.object({
		query: z.string().min(1).describe("自然语言检索词"),
		limit: z.number().int().min(1).max(100).optional().describe("返回条数，默认 5，最多 100"),
	});

	pi.registerTool({
		name: "memory_recall",
		label: "记忆检索",
		description: "检索 claude-mem 中跨 Claude、Codex 与 OMP 会话共享的历史记录。",
		parameters: memoryRecallParameters,
		approval: "read",
		async execute(
			_toolCallId,
			params: Static<typeof memoryRecallParameters>,
			_signal,
			_onUpdate,
			ctx,
		) {
			const result = (await probeWorker())
				? await workerFetch(
					`/api/search?query=${encodeURIComponent(params.query)}&limit=${params.limit ?? 5}&project=${encodeURIComponent(projectName(ctx.cwd))}`,
					undefined,
					WORKER_INTERACTIVE_TIMEOUT_MS,
				)
					.then(response => response.json())
					.catch(() => null)
				: null;
			let resultText = "";
			if (result && typeof result === "object" && "content" in result) {
				resultText = contentText(result.content);
			}
			return {
				content: [{ type: "text" as const, text: resultText || "未找到匹配的历史记录，或 claude-mem 暂时不可用。" }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("memory-status", {
		description: "检查 claude-mem worker 连接状态",
		handler: async (_args, ctx) => {
			try {
				const ok = await probeWorker();
				if (!ok) throw new Error("claude-mem worker unavailable");
				const response = await workerFetch("/api/health", undefined, WORKER_INTERACTIVE_TIMEOUT_MS);
				const data = (await response.json()) as Record<string, unknown>;
				const version =
					typeof data.version === "string" || typeof data.version === "number" ? String(data.version) : "未知";
				ctx.ui.notify(`claude-mem 已连接（版本 ${version}，项目 ${projectName(ctx.cwd)}）`, "info");
			} catch {
				ctx.ui.notify("claude-mem worker 当前不可达", "error");
			}
		},
	});
}
