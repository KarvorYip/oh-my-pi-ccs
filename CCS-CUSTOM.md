# ccs-custom 分支使用说明

本分支（`ccs-custom`）是 `can1357/oh-my-pi` 的私用定制线，基线上游 tag（当前 `v18.0.6`）。注入以 commits 形式维护，每次上游发版 `git rebase v<新版本>` 即可——不再依赖对 `dist/cli.js` 的文本锚点补丁。

## 分支携带的改动

| # | Commit | 内容 |
|---|---|---|
| 1 | `feat(ccs): welcome screen labels honor __ompCcsWelcomeLabels map` | 欢迎页模型/provider 标签优先读 `globalThis.__ompCcsWelcomeLabels`（CCS bridge/plugin 注入），`ccswitch-*` 前缀回退 `id/api`，否则 `name/provider` |
| 2 | `feat(ccs): expose getThinkingState/getAdvisorOverview extension actions` | 扩展 API 新增两个只读 action：思考三态（configured/effective/resolved）与 advisor 名册；消费方 `omp-routing` 副栏 |
| 3 | `feat(ccs): prefer version-pinned natives cache in loader candidates` | natives loader 把 `~/.omp/natives/<版本>/` 提为首选候选——重建时运行中的 omp 会话对 repo 内 `.node` 持 Windows 写锁，版本化缓存免锁 |
| 4 | `feat(ccs): pin the input block to the terminal bottom rows` | 输入框自首帧起固定在终端最后一行（Claude Code `NO_FLICKER=1` 观感）；短会话态在 transcript 与输入区之间垫空行补满屏高，history 压力来临时 pad 归零，退休/滚动/resize 语义不变 |
| 5 | `test(ccs): regression coverage for the four ccs-custom seams` | 上述四项的回归测试（红/绿矩阵：vanilla 全红、本分支全绿；「压力下不垫」守护测试两侧皆绿） |

## 本机构建与发布

自动（推荐）——`omp-selfbuild.py`（本机 `D:\workspace\claude_settings\.claude\tools\omp-selfbuild.py`）：

```powershell
python D:\workspace\claude_settings\.claude\tools\omp-selfbuild.py
```

步骤：取 native `omp --version` → `git fetch upstream --tags` → `rebase ccs-custom @ v<版本>`（冲突即 abort 并失败退出）→ 原生 `.node` 就位 → `bun install` → `gen:bundle` → 版本/补丁器终验 → 推送 fork。任一步失败不改动旧 dist。

手动等价：

```powershell
cd C:\workspace\oh-my-pi-ccs
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
  "distPath": "C:\\workspace\\oh-my-pi-ccs\\packages\\coding-agent\\dist\\cli.js",
  "selfbuildPath": "D:\\workspace\\claude_settings\\.claude\\tools\\omp-selfbuild.py"
}
```

- `omp-self.cmd`：`bun "C:\workspace\oh-my-pi-ccs\packages\coding-agent\dist\cli.js" %*`
- `omp-ccs.ps1` 的 `[omp-selfbuild-sync]` 块：native 或 dist 的 mtime 新于戳（或 dist 缺失）即核对两侧版本，分叉自动跑 selfbuild；失败不写戳下次重试。`channel=selfbuild` 时启动链不走补丁路径。

## 验证

```powershell
# 回归测试（6 例）
cd C:\workspace\oh-my-pi-ccs\packages\natives && bun test test/ccs-loader-candidates.test.ts
cd ..\coding-agent && bun test test/ccs-composer-pin.test.ts test/ccs-welcome-labels.test.ts test/ccs-subtitle-actions.test.ts

# 冒烟
& ~\.local\bin\omp-ccs.ps1 --version        # omp/<版本>
python D:\workspace\claude_settings\.claude\tools\omp-core-compat-patch.py welcome-check --target <distPath>
```

交互目视：欢迎页显示 CCS 短标签（如 `gpt-5.6-terra`）；输入框贴终端底行不随内容跳动；副栏显示 `⟳ auto`/等级/advisor 徽标。

## 回滚

`omp-ccs-paths.json` 改回三键即切回 bun 通道（npm 停发前可用）：

```json
{ "channel": "bun",
  "ompPath": "C:\\Users\\<user>\\.bun\\bin\\omp.exe",
  "distPath": "C:\\Users\\<user>\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" }
```

bun 通道恢复 `welcome-apply` 自动补丁链（18.0.6 补丁完好）。要撤销单个定制：`git revert <commit>` 后重跑 selfbuild。

## 上游同步

上游发新 tag 后：直接启动一次 `omp-ccs`（自动触发 rebase+重建），或手动跑 `omp-selfbuild.py`。rebase 冲突时脚本失败退出且分支原样，人工解决后重跑。完整设计见 `D:\workspace\claude_settings\docs\adr\0005-omp-source-selfbuild-channel.md`。
