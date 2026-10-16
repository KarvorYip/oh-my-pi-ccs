# ccs-custom 分支使用说明

本分支（`ccs-custom`）是 `can1357/oh-my-pi` 的私用定制线，已同步至 `origin/main` 的 `a536558dc2`（2026-10-16，版本 `18.11.1`，含该版本后的 Unreleased 改动）。定制改动以 commits 形式维护；共享分支同步使用 merge，不重写已发布历史，不依赖对 `dist/cli.js` 的文本锚点补丁。

## 分支携带的改动

| # | Commit | 内容 |
|---|---|---|
| 1 | `feat(ccs): welcome screen labels honor __ompCcsWelcomeLabels map` | 欢迎页模型/provider 标签优先读 `globalThis.__ompCcsWelcomeLabels`（CCS bridge/plugin 注入），`ccswitch-*` 前缀回退 `id/api`，否则 `name/provider` |
| 2 | `feat(ccs): expose getThinkingState/getAdvisorOverview extension actions` | 扩展 API 新增两个只读 action：思考三态（configured/effective/resolved）与 advisor 名册；消费方 `omp-routing` 副栏 |
| 3 | `feat(ccs): prefer version-pinned natives cache in loader candidates` | natives loader 把 `~/.omp/natives/<版本>/` 提为首选候选——重建时运行中的 omp 会话对 repo 内 `.node` 持 Windows 写锁，版本化缓存免锁 |
| 4 | `feat(ccs): pin the input block to the terminal bottom rows` | 输入框自首帧起固定在终端最后一行（Claude Code `NO_FLICKER=1` 观感）；短会话态在 transcript 与输入区之间垫空行补满屏高，history 压力来临时 pad 归零，退休/滚动/resize 语义不变 |
| 5 | `test(ccs): regression coverage for the four ccs-custom seams` | 上述四项的回归测试（红/绿矩阵：vanilla 全红、本分支全绿；「压力下不垫」守护测试两侧皆绿） |
| 6 | `feat(ccs): ship the selfbuild release script inside the fork` | 发布脚本入仓（`ccs-selfbuild.py`，仓库根）：零机器绝对路径，终验内联 |
| 7 | `docs(ccs)` | 本使用说明（构建/接线/验证/回滚/新机迁移/上游同步） |
| 8 | `fix(ccs): keep the TUI alive when an error payload breaks a component render` | 错误横幅崩溃修复：`getPreviewLines` 入口收敛非字符串载荷（Error 对象/undefined 不再抛 `text.split`）；TUI 渲染循环围堵组件异常（落文件日志、保留上一帧），输入区不再因渲染异常消失/原始栈砸屏 |
| 9 | `fix(ccs): force-fetch upstream tags` | 上游曾重写 v18.0.7 tag，普通 `--tags` fetch 拒绝覆盖会中止整个同步 |
| 10 | `fix(ccs): reject version-skewed natives from the bun-global fallback` | 兜底 natives 源版本校验：18.0.9 的码配 18.0.6 的 `.node` 构建期能过、运行期缺 `vcsGitDiscover` 每帧炸（status-line VCS 段） |
| 11 | `feat(ccs): ship omp-claude-mem as an in-repo plugin with cache-safe injection` | claude-mem 兼容扩展从 `~/.local/bin` 迁入 `plugins/omp-claude-mem/`；记忆时间线改为**每会话一次渲染并冻结**（跨进程 resume 复用同一字节，注入位置固定为第一条 user 消息头部），修复 codex 线路前缀缓存被逐轮追加的易变上下文击穿的问题 |
| 12 | `fix(catalog): 按 SKU 钉死 GPT-5.6 Codex 上下文窗口` | 订阅版 Codex 各 SKU 真实窗口（luna 128K / terra 272K / sol 1M，>272K 加价层）取代 upstream 全家族 1M floor：`CODEX_GPT_5_6_CONTEXT_WINDOWS` 单一常量落在 discovery、生成期策略与 model-registry 运行时策略（`-wm` 后缀归一，先钉死后走 `extendedContext` 272K 钳制）三层；`models.json` 仅同步三个条目（全量 regen 有约 1 万行无关漂移且当前丢 sol 行）。（v18.2.11 同步后 terra 已改为 1M 钉值 + 272K 钳制的付费层切换语义，见 #14） |
| 13 | `fix(ccs): harden memory search and MSYS repaint` | mem-search 工具更名 `memory_search`（避开与内建 search 撞名）；bash 工具结束后 250ms 延迟二次强制重绘，堵 MSYS 晚期 stderr 写穿 TUI 的窗口 |
| 14 | `Merge origin/main v18.2.11` + `fix(ccs): align terra with sol/astra premium-tier window semantics` | 同步上游 v18.2.11（428 笔）；gpt-5.6-terra 从硬钉 272K 改为 sol 同款语义：1M 钉值 + extendedContext 关闭时 272K 钳制（astra/sol/terra 同一套付费层切换语义，luna 保持 128K 硬钉） |
| 15 | `fix(ccs): map gpt-6 sol/luna subscription windows` + `fix(ccs): pin gpt-6 sol/luna relay context windows` | gpt-6 窗口映射：sol 走 astra 模板（272K 默认 / 922K 扩展上限），luna 参照 5.6-luna 硬钉 128K；KDL 规则 + TS relay 钉表双层落地（见下节） |
| 16 | `Merge upstream v18.8.4 into ccs-custom` (`c83b5a89cf`) | 修复 6.1-sol 思考等级继承；中继窗口改为复用 Codex KDL 轴，删除 GPT-6 TS 硬编码钉表；权威窗口与显式覆盖保持优先 |
| 17 | 同步 `origin/main` 至 `a536558dc2`（18.11.1） | 保留 CCS 定制并融合上游滚动历史锚点、输入路由、累计用量优化；6.1-sol 跟随上游免费标准窗口提升至 500K，扩展仍为 922K |


## Codex SKU 上下文窗口语义（防再犯）

当前生效策略（`extendedContext` = 设置里的扩展上下文开关）：

| SKU | 默认 | extendedContext 开 | 语义 |
|---|---|---|---|
| gpt-6-astra / gpt-6-sol | 272K | 922K | astra 模板：标准价 272K，付费层恢复上限 |
| gpt-6.1-sol / gpt-6.1-sol-wm | 500K | 922K | 上游记录 2026-10-11 将 Codex 免费标准窗口提升至 500K；不是默认开启扩展档 |
| gpt-6-luna / gpt-5.6-luna | 128K | 128K | 低档 SKU 硬钉，无扩展上限 |
| gpt-5.6-terra / gpt-5.6-sol | 272K | 1M | 1M 钉值 + 关闭时 272K 钳制 |

**两层落点，共用政策来源：**

1. **KDL 层**（`packages/catalog/src/compat/rules/providers/openai-codex.kdl`）：`limits-patch context-window` + `max-context-window`。改后必须 `bun run gen:compat` 并提交 `rules.json`。
2. **中继投影层**（`packages/coding-agent/src/config/model-registry.ts` 的 `#codexRelayContextWindow`）：`ccswitch-*` 自定义模型使用 `resolveCatalogAxes` 读取 `openai-codex` 的同一组 KDL 输入预算，避免回退到第一方 API 的 1.05M 参考窗口；不再维护 GPT-6 TS 钉表。GPT-5.6 历史 SKU 仍使用 `discovery/codex.ts` 的 `CODEX_GPT_5_6_CONTEXT_WINDOWS`。投影只处理 CCS 中继，避免再次钳制直连提供方已选择的窗口档位；显式模型覆盖随后应用并优先。新增 SKU 应补 `model-registry.test.ts` 的关闭→开启→关闭及 manifest 显式窗口用例。

上游合并注意：upstream 的 `model-registry.test.ts` 断言可能按官方目录写（如 terra 1M）；与 ccs-custom 钉值冲突时以本分支策略为准调整断言，并重放本分支自有测试（合并冲突时以上游版本为基、`git diff <merge-base>..HEAD~1` 重放自有 hunks，勿整体 `--ours`——会丢上游对同文件的更新）。

## v18.8.4 卡顿核验（2026-10-16）

- 旧版本机日志有 `ui.loop-blocked`：最重一次为 `ui.transcript-retire` 阻塞 6344ms、CPU 156ms；仅凭阶段和 CPU 采样不能判定根因或宣称升级已治愈。
- 最新 main 的 [#15874](https://github.com/can1357/oh-my-pi/pull/15874) 优化长子代理会话状态刷新。运行现有 `bench/subagent-tree-cost.bench.ts` 的真实会话夹具，对照旧提交的聚合实现：8 个子代理各 2000 轮、500 次刷新，旧聚合每次 5.231ms / 新聚合 0.197ms，累计费用校验一致。对照共用新版会话实现，证明的是聚合热点改善，不是完整旧新 CLI 的总延迟。
- [#15693](https://github.com/can1357/oh-my-pi/issues/15693) 修复表格、tab、思考文本导致的滚动退役停滞；[#15820](https://github.com/can1357/oh-my-pi/pull/15820) 修复历史缺行和乱序；均随本次同步进入，但尚未复现日志中的 6.344 秒等待。
- [#15787](https://github.com/can1357/oh-my-pi/pull/15787) 减少 Windows 长粘贴期间的逐键终端写入；讨论中报告者仍未见秒级延迟改善，不能视为 [#15757](https://github.com/can1357/oh-my-pi/issues/15757) 的确定治愈。CCS 未覆盖其 `terminal.ts` / `stdin-buffer.ts` 修复路径。
- 最终本机验证：262 项定向回归通过，四个相关包类型检查通过，`dist/cli.js --smoke-test` 返回 `ok`。经真实 `omp-ccs` 启动链的 ConPTY 冒烟中，13,329 字节 / 120 行粘贴约 102ms 显示卡片，110×30 缩放至 90×24 正确，思考等级从 med 切至 high，进程正常退出。此结果不替代 JetBrains 逐键输入环境或长时间会话的卡顿复测。


## 本机构建与发布

本次手动 merge 发布按文末「上游同步」流程执行。`ccs-selfbuild.py` 是历史 tag/rebase 自动通道；以下命令仅适用于该通道，不要在已同步最新 main 的共享分支上重放 rebase。

```powershell
cd <本仓库克隆目录>
python ccs-selfbuild.py
```

脚本步骤：取 native `omp --version`（`~/.local/bin/omp.exe`）→ `git fetch upstream --tags` → `rebase ccs-custom @ v<版本>`（冲突即 abort 并失败退出）→ 原生 `.node` 就位（`~/.omp/natives/<版本>/`）→ `bun install` → `gen:bundle` → 版本冒烟 + 注入标记终验 → 推送 fork。`gen:bundle` 会先清理旧产物，执行前应将整个 dist 备份到仓库外，不能依赖失败自动保留旧 dist。

历史脚本的手动等价（不是本次 main 同步流程）：

```powershell
cd <本仓库克隆目录>
git fetch upstream --tags --prune
git rebase v<版本>
# natives：确认 %USERPROFILE%\.omp\natives\<版本>\ 存在（跑一次 native omp 即自解压）
bun install
cd packages\coding-agent
bun run gen:bundle
bun dist\cli.js --version   # 应输出 omp/<版本>
```



## 关键约束

- **产物必须留在本工作副本运行**：`dist/cli.js` 非自包含——`@babel/parser`、`puppeteer-core`、`@oh-my-pi/pi-natives` 是运行时外部依赖，从工作副本 `node_modules` 解析。不要把 dist 拷到别处单独跑。
- **保持工作副本干净**：selfbuild 前置检查拒绝脏工作树（`dist/`、`.node` 均已 gitignore）。
- **natives 必须匹配源码能力**：正式发布版本使用 `__piNativesBuildVersion()` 固定槽哨兵（兼容旧 `__piNativesV*`）。main 的 Unreleased 代码可能已新增原生导出，即使包版本相同，正式 release 的 `.node` 也不一定足够；必须调用新增接口冒烟，不能只检查 `--version`。
- **本次 main 原生包来源**：[目标提交官方 CI](https://github.com/can1357/oh-my-pi/actions/runs/38845332140) 的 `native-addons`，经公开镜像下载后核对整包 SHA256 为 `5ecba1b0351a50932ccb0666f8b8eb6d8a50bae2f7185fa3d0a330057612077a`。Windows baseline 经仓库 `stamp-native-version.ts` 写入 `18.11.1` 后放到标准 `~/.omp/natives/18.11.1/`；旧 release addon 保留在 `18.11.1-release-backup-20261016-174846/`，启动链无需额外环境变量。

## 本机接线（omp-ccs 启动链）

`omp-ccs-paths.json`（`~\.local\bin\`）：

```json
{
  "channel": "selfbuild",
  "ompPath": "C:\\Users\\<user>\\.local\\bin\\omp-self.cmd",
  "distPath": "<本仓库克隆目录>\\packages\\coding-agent\\dist\\cli.js"
}
```

发布脚本位置无需配置：`omp-ccs.ps1` 从 `distPath` 上溯四级推导仓库根，自动定位同仓的 `ccs-selfbuild.py`（也可用 `OMP_SELFBUILD_SCRIPT` 环境变量或 `selfbuildPath` 键显式覆盖）。

- `omp-self.cmd`：`bun "<本仓库克隆目录>\packages\coding-agent\dist\cli.js" %*`
- `omp-ccs.ps1` 的 `[omp-selfbuild-sync]` 块：native 或 dist 的 mtime 新于戳（或 dist 缺失）即核对两侧版本，分叉自动跑 selfbuild；失败不写戳下次重试。`channel=selfbuild` 时启动链不走补丁路径。

## 验证

```powershell
# 回归测试（6 例）
cd packages\natives && bun test test/ccs-loader-candidates.test.ts
cd ..\coding-agent && bun test test/ccs-composer-pin.test.ts test/ccs-welcome-labels.test.ts test/ccs-subtitle-actions.test.ts

# claude-mem 插件契约测试（注入字节稳定 / 冻结跨进程复用 / worker 降级）
cd ..\.. && bun test plugins/omp-claude-mem/test/omp-claude-mem.test.ts

# 冒烟（经 omp-ccs 启动链）
& ~\.local\bin\omp-ccs.ps1 --version        # omp/<版本>

# 发布产物后台运行链验证（不会 rebase 或 push）
bun packages\coding-agent\dist\cli.js --smoke-test
```

交互目视：欢迎页显示 CCS 短标签（如 `gpt-5.6-terra`）；输入框贴终端底行不随内容跳动；副栏显示 `⟳ auto`/等级/advisor 徽标。

## claude-mem 兼容插件（随分支分发）

记忆接入（原 `~/.local/bin/omp-claude-mem.ts`）已迁入仓库 `plugins/omp-claude-mem/`，通过标准插件机制加载：

```powershell
omp plugin link <本仓库克隆目录>\plugins\omp-claude-mem
omp plugin list        # 应出现 omp-claude-mem@0.1.0
/memory-status         # 交互内检查 worker 连接
```

行为契约（与旧版的关键差异）：

- **每会话一次渲染并冻结**：记忆时间线按 `(项目, 会话)` 渲染一次，字节固化到
  `~/.claude-mem/omp-frozen-context.json`；同一会话内（含跨进程 `-c` 续会话）
  的所有请求注入**完全相同的字节**，不再每轮向消息流末尾追加新渲染的上下文。
- **注入位置固定**：作为第一条 user 消息的首个 text 块——请求间前缀字节稳定，
  OpenAI 兼容中继（如百田 codex 线路）的严格前缀缓存不再被击穿。
- 新鲜度：`memory_recall` 工具按需检索；时间线随新会话 / 缓存 TTL（默认 6h，
  `CLAUDE_MEM_CONTEXT_FRESH_MS` 可调）过期后重新渲染。
- 完整查询：`mem-search` skill 按 `search → timeline → get_observations → get_tool_uses`
  分层检索；普通回忆仍可直接使用 `memory_recall`。
- worker 不可用时先在后台调用已安装 claude-mem 的 `worker-service.cjs start`，等待 3 秒后复查健康；仍不可达才静默降级（不注入、不阻塞请求）。`/api/sessions/init`、observations、summarize 等协议交互与旧版一致。

回退：`omp plugin uninstall omp-claude-mem` 后恢复旧文件即可。

## 回滚

`omp-ccs-paths.json` 改回三键即切回 bun 通道（npm 停发前可用）：

```json
{ "channel": "bun",
  "ompPath": "C:\\Users\\<user>\\.bun\\bin\\omp.exe",
  "distPath": "C:\\Users\\<user>\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" }
```

bun 通道恢复 `welcome-apply` 自动补丁链（18.0.6 补丁完好）。要撤销单个定制：`git revert <commit>` 后重跑 selfbuild。

## 新机迁移

构建/发布零机器绑定，新机只需：

1. `git clone -b ccs-custom <fork> && cd oh-my-pi-*`（或任意 clone 后 `git checkout ccs-custom`；确认 `origin`=fork、`upstream`=`can1357/oh-my-pi`）；
2. 安装官方 omp（独立二进制落到 `~\.local\bin\omp.exe`）并跑一次（生成 `~\.omp\natives\<版本>\`）；
3. `python ccs-selfbuild.py`（自动 fetch/rebase/install/bundle/验证）；
4. 配置 `~\.local\bin\omp-ccs-paths.json`（上面模板）与 `omp-self.cmd`（`bun "<克隆目录>\packages\coding-agent\dist\cli.js" %*`）；
5. `omp plugin link "<克隆目录>\plugins\omp-claude-mem"`（claude-mem 记忆接入插件随分支分发，见上文）。

CCS 生态其余部分（bridge、provider plugin、omp-routing 扩展）不在本仓库，迁移见 `claude_settings` 仓的 `OMP_CCS_UPDATE_REPAIR_HANDOFF.md`。


## 上游同步

共享的 `ccs-custom` 分支手动同步：先 `git fetch origin main`，再 `git merge --no-commit --no-ff origin/main`，消解冲突并保留上游结构与 CCS 定制，执行 `bun install --frozen-lockfile`、`bun run gen:compat`、定向测试与类型检查，准备与源码版本精确匹配的 natives 后执行 `bun run gen:bundle`。通过 `omp-self.cmd --version`、`dist/cli.js --smoke-test` 与真实 `omp-ccs` 交互验证后，提交合并并普通 push；不要 force-push 共享历史。`ccs-selfbuild.py` 仍是历史 tag/rebase 自动通道，不用于这条手动 merge 流程。启动链只在 native 语义版本更高时自动重建，因此本次 18.11.1 dist 不会被旧 18.8.4 native 拖回。natives 使用独立版本目录，不覆盖正在运行的 `.node`。
