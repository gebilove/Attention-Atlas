# 自动调试闭环

这个工作流用于把“改代码”和“在真实网页里点击验证”连成闭环。

## 一键运行

```bash
npm run debug:loop
```

脚本会依次完成：

1. 校验 `manifest.json` 的 MV3 扩展入口。
2. 对仓库内的 `.js` / `.mjs` 文件执行 `node --check` 语法检查。
3. 使用临时 Chrome profile 加载当前仓库作为 unpacked extension。
4. 打开测试网页。
5. 通过 Chrome DevTools Protocol 检查扩展 service worker。
6. 检查 content script 是否在网页中渲染了入口、侧边栏或分析块。
7. 如果页面出现 `#sln-prompt-start`，自动点击“自动生成并分析”按钮。
8. 扫描页面运行时异常和浏览器 warning/error 日志。

默认测试页是：

```text
https://hrl.boyuai.com/chapter/1/%E5%8A%A8%E6%80%81%E8%A7%84%E5%88%92%E7%AE%97%E6%B3%95/
```

## 指定网页

```bash
npm run debug:loop -- --url "https://example.com/article"
```

## 指定点击目标

可以用 CSS 选择器指定一个或多个真实点击步骤：

```bash
npm run debug:loop -- --click "#sln-prompt-start [data-sln-prompt-generate]"
```

多个点击：

```bash
npm run debug:loop -- \
  --click "#sln-prompt-start [data-sln-prompt-generate]" \
  --click "#sln-sidebar [data-sln-action='hide']"
```

点击通过 CDP 的 `Input.dispatchMouseEvent` 发送到元素中心点，会触发真实鼠标事件路径。

## 连接已有 Chrome

如果已经手动打开了带远程调试端口的 Chrome：

```bash
npm run debug:loop:attach -- --port 9224 --url "https://hrl.boyuai.com/chapter/1/%E5%8A%A8%E6%80%81%E8%A7%84%E5%88%92%E7%AE%97%E6%B3%95/"
```

## 保留浏览器窗口

```bash
npm run debug:loop -- --keep-open
```

用于脚本结束后继续人工观察页面状态。

## 推荐开发循环

1. 修改扩展代码。
2. 运行 `npm run debug:loop -- --keep-open`。
3. 如果失败，根据终端中的失败项修改代码。
4. 再运行同一命令验证。
5. 需要覆盖具体交互时，用 `--click` 明确点击路径。

这个闭环覆盖的是扩展加载、service worker、content script 注入、网页真实点击、页面异常和浏览器日志。LLM 接口本身仍依赖本地扩展配置；没有配置 LLM 时，点击分析入口后应出现可见的失败侧边栏，而不是静默失败。

## Chrome 版本要求

官方品牌版 Chrome 137+ 不再支持通过 `--load-extension` 自动加载 unpacked extension。完整自动闭环需要使用 Chrome for Testing 或 Chromium。

如果 Chrome for Testing 安装在默认位置，脚本会自动优先使用：

```text
/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

也可以手动指定：

```bash
CHROME_PATH="/path/to/Chrome for Testing" npm run debug:loop
```

或者：

```bash
npm run debug:loop -- --chrome "/path/to/Chrome for Testing"
```

如果只能使用官方 Chrome 137+，需要先手动在 `chrome://extensions` 加载当前仓库，再用 attach 模式连接已有调试端口：

```bash
npm run debug:loop:attach -- --port 9224 --click "#sln-prompt-start [data-sln-prompt-generate]"
```
