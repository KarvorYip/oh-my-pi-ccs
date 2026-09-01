# ccs-custom 分支使用说明

本分支（`ccs-custom`）是 `can1357/oh-my-pi` 的私用定制线，基线上游 tag（当前 `v18.0.9`）。注入以 commits 形式维护，每次上游发版 `git rebase v<新版本>` 即可——不再依赖对 `dist/cli.js` 的文本锚点补丁。

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

## 本机构建与发布

发布脚本随分支分发：仓库根目录 `ccs-selfbuild.py`，不依赖任何机器外文件（终验为内联注入标记检查，不依赖外部补丁器）。

```powershell
cd <本仓库克隆目录>
python ccs-selfbuild.py
```

步骤：取 native `omp --version`（`~/.local/bin/omp.exe`）→ `git fetch upstream --tags` → `rebase ccs-custom @ v<版本>`（冲突即 abort 并失败退出）→ 原生 `.node` 就位（`~/.omp/natives/<版本>/`）→ `bun install` → `gen:bundle` → 版本冒烟 + 注入标记终验 → 推送 fork。任一步失败不改动旧 dist。

手动等价：

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
- **natives 版本必须精确匹配**：loader 有版本哨兵（`__piNativesV<major>_<minor>_<patch>`），版本不符会在加载期报错。

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

# 注入语义终验（与构建脚本内置检查同源）
python ccs-selfbuild.py --skip-push
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
- worker 不可用时静默降级（不注入、不阻塞请求）；`/api/sessions/init`、
  observations、summarize 等协议交互与旧版一致。

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

上游发新 tag 后：直接启动一次 `omp-ccs`（自动触发 rebase+重建），或手动跑 `python ccs-selfbuild.py`。启动链的重建条件为**语义化版本比较**（仅 native 更新才重建）——dist 允许领先 native（如 release 尚未发布而手动 `--target-version` 同步），不会被旧 native 拖回。rebase 冲突时脚本失败退出且分支原样，人工解决后重跑。natives 版本必须与构建目标精确一致（脚本强制校验）；`~/.omp/natives/<版本>/` 由对应版本 native omp 首次运行时自解压。完整设计见 claude_settings 仓 `docs/adr/0005-omp-source-selfbuild-channel.md`。
