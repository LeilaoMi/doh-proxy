# doh-proxy 与 cmliu/CF-Workers-DoH 对比结论

生成时间：2026-06-05（Asia/Shanghai）
用户项目：`https://github.com/LeilaoMi/doh-proxy`
对比项目：`https://github.com/cmliu/CF-Workers-DoH`
线上端点：`https://doh.leilaomi.ccwu.cc/dns-query`

## 1. 直接结论

**不建议把当前已部署的 `doh-proxy` 直接替换成 `cmliu/CF-Workers-DoH`。**

原因：你的当前项目已经满足代理客户端 DoH 的核心需求，线上验证通过，而且代码更小、更稳、更适合 v2rayNG / Karing 这类客户端。`cmliu/CF-Workers-DoH` 更像一个“DoH 工具站 + 查询页面 + IP 信息查询 + 主页伪装”的综合项目，功能更多，但复杂度和公开服务风险也更高。

推荐策略：

1. 当前 CF 已部署服务继续保留。
2. 不直接替换线上端点。
3. 如果想要网页查询页面、IP 信息查询、主页伪装等功能，可以从 `cmliu` 项目按需“移植小模块”，不要整仓库替换。
4. 真要试新版，也应该部署到新的测试子域名，例如 `doh-test.leilaomi.ccwu.cc`，验证稳定后再考虑切换。

## 2. 当前项目状态

本地路径：`/home/workspace/Projects/doh-proxy`

目录结构：

```text
doh-proxy/
├── README.md
├── worker.js
├── functions/
│   └── dns-query.js
├── public/
│   └── index.html
├── scripts/
│   └── test-doh.js
├── wrangler.toml
└── .gitignore
```

`wrangler.toml` 当前绑定：

```toml
name = "doh-proxy"
main = "worker.js"
compatibility_date = "2026-05-30"
workers_dev = true
routes = [
  { pattern = "doh.leilaomi.ccwu.cc", custom_domain = true }
]
```

## 3. 线上验证结果

执行命令：

```bash
node scripts/test-doh.js https://doh.leilaomi.ccwu.cc/dns-query example.com
```

输出：

```text
Endpoint: https://doh.leilaomi.ccwu.cc/dns-query
Domain:   example.com
----------------------------------------
✅ health         128.8ms  status=200 type=text/plain; charset=utf-8 answers=- rcode=-
✅ OPTIONS         98.1ms  status=204 type= answers=- rcode=-
✅ RFC8484 GET     98.8ms  status=200 type=application/dns-message answers=2 rcode=0
✅ RFC8484 POST    98.7ms  status=200 type=application/dns-message answers=2 rcode=0
```

语法检查：

```bash
node --check worker.js
node --check functions/dns-query.js
node --check scripts/test-doh.js
```

均通过。

## 4. 两个项目定位差异

| 对比项 | LeilaoMi/doh-proxy | cmliu/CF-Workers-DoH |
|---|---|---|
| 核心定位 | 极简 DoH 代理 | DoH 代理 + 网页查询工具 + IP 信息 + 伪装 |
| 适合场景 | v2rayNG / Karing / 代理客户端 DNS | 浏览器查询、展示、公开工具站、自用 DoH |
| 部署结构 | 标准 Worker 项目，有 `wrangler.toml` | 单文件 `_worker.js`，复制部署为主 |
| 代码规模 | 小，约 500 多行含 README | 大，`_worker.js` 1683 行 |
| DoH RFC8484 GET | 支持 | 支持 |
| DoH RFC8484 POST | 支持 | 支持 |
| GET 空访问健康检查 | `200 ok`，兼容 Karing | 默认直接访问 DoH 路径返回 `400 Bad Request` |
| CORS / OPTIONS | 支持，OPTIONS 返回 204 | 支持，OPTIONS 返回 200 空响应 |
| 禁用缓存 | 明确设置 `cache-control: no-store...` | 没有同等明确的全链路禁缓存策略 |
| 上游配置 | `DOH_UPSTREAM` / `DOH` | `DOH` |
| 路径配置 | 固定 `/dns-query` | `TOKEN` / `PATH` 可改路径 |
| 网页 UI | 极简静态页 | 完整 Bootstrap 查询页面 |
| IP 信息查询 | 无 | 有 `/ip-info`，依赖 ip-api.com |
| 主页伪装/跳转 | 无 | 有 `URL`、`URL302`、nginx 伪装 |
| 维护风险 | 低 | 较高，后端/前端/伪装耦合在单文件 |
| 安全/滥用面 | 小 | 更大，功能越多暴露面越大 |

## 5. 你的项目已经吸收了哪些有用点

`README.md` 里已经明确写了“从 `cmliu/CF-Workers-DoH` 吸收的点”：

- CORS / OPTIONS 兼容。
- 环境变量切换上游 DoH。
- 测试脚本。

并且明确没有加入：

- `/ip-info`
- 主页伪装
- 跳转
- TOKEN 路径
- JSON 查询页面

这个取舍是合理的：你的目标是给代理客户端稳定使用，而不是做公开查询工具站。

## 6. 为什么不建议整站替换

### 6.1 你的线上端点已经可用

当前 `https://doh.leilaomi.ccwu.cc/dns-query` 已通过：

- health
- OPTIONS
- RFC8484 GET
- RFC8484 POST

这说明它对 DoH 客户端已经满足主要协议要求。

### 6.2 cmliu 项目对 Karing/v2rayNG 未必更优

`cmliu` 项目功能更多，但它的 DoH 路径直接空访问返回 `400 Bad Request`。而你的项目专门做了：

```text
GET /dns-query 空访问返回 200 ok
```

这对 Karing 这类客户端的“可用性检测”更友好。

### 6.3 cmliu 项目复杂度更高

`cmliu` 的 `_worker.js` 同时包含：

- Worker 路由
- DoH 转发
- DNS JSON 查询聚合
- IP 信息查询代理
- Bootstrap HTML
- 大量前端 DOM 操作
- 主页代理/伪装

后续每改一个功能，都可能影响其它功能。你的项目结构更清楚，风险更低。

### 6.4 公开服务风险更大

如果只是自用 DoH，越少功能越好。`/ip-info`、网页查询、反代伪装都会增加请求入口和潜在滥用面。考虑到用户历史上很重视 Cloudflare 滥用/封禁风险，当前极简版更稳妥。

## 7. 什么时候才值得引入 cmliu 的功能

只有在你明确需要以下功能时，才建议按模块移植：

1. **需要网页 DNS 查询页面**：给自己浏览器里查 A/AAAA/NS。
2. **需要展示 IP 国家/ASN**：移植 `/ip-info`，但要考虑 ip-api 限速和鉴权。
3. **需要隐藏首页**：加一个简单根路径伪装，不一定要完整反代。
4. **需要自定义 DoH 路径 token**：例如 `/CMLiussss`，但这会改变客户端配置和 README。

不建议一次性全部加。

## 8. 建议的后续路线

### 路线 A：保持当前稳定版（推荐）

适合：继续给 v2rayNG / Karing 使用。

动作：

- 不换项目。
- 保留 `doh.leilaomi.ccwu.cc/dns-query`。
- 定期用 `scripts/test-doh.js` 验证。
- 如要换上游，只改 Cloudflare 环境变量 `DOH_UPSTREAM`。

### 路线 B：新建测试子域名试 cmliu 功能

适合：想体验完整网页查询页面，但不影响现有客户端。

建议子域：

```text
doh-test.leilaomi.ccwu.cc
```

动作：

- 不动现有 `doh.leilaomi.ccwu.cc`。
- 用 `cmliu/CF-Workers-DoH` 或移植模块部署到测试 Worker。
- 验证 1-2 天。
- 确认可用后再决定是否迁移。

### 路线 C：在当前项目中小步移植功能

适合：只想加一两个小功能。

优先级建议：

1. 根路径返回更友好的中文说明页。
2. 可选 `/health` endpoint。
3. 可选 `/ip-info`，但必须加 token 或限制用途。
4. 不建议加完整反代伪装，除非确实需要。

## 9. 后续修改注意事项

1. `worker.js` 与 `functions/dns-query.js` 当前逻辑高度相似，但分别服务 Workers 与 Pages Functions。改协议逻辑时要同步两边，避免 Workers 可用但 Pages 版本落后。
2. 当前固定路径 `/dns-query` 是好事，最适合标准 DoH 客户端；不要为了“隐藏”轻易换路径，除非客户端都能同步更新。
3. 如果要引入 TOKEN 鉴权，要注意很多 DoH 客户端只接受标准 DoH URL，不一定支持额外 header；路径 token 可以用，但会改变 URL。
4. 如果要降低公开滥用风险，优先考虑：保留非显眼子域、根路径只显示简单文本、不要加开放查询 UI。
5. 每次改动后至少验证：
   - `node --check worker.js`
   - `node --check functions/dns-query.js`
   - `node --check scripts/test-doh.js`
   - `node scripts/test-doh.js https://doh.leilaomi.ccwu.cc/dns-query example.com`

## 10. 最终建议

**现在不要换。**

你的 `doh-proxy` 已经是更贴合你当前用途的版本：小、清楚、线上通过测试、对 Karing/v2rayNG 兼容更友好。

`cmliu/CF-Workers-DoH` 可以当功能参考库，不适合作为当前线上 DoH 的直接替代品。后续如果你想加功能，建议从它里面“摘功能”，而不是整项目替换。
