# doh-proxy 后续改造执行计划

生成时间：2026-06-05（Asia/Shanghai）
项目路径：`/home/workspace/Projects/doh-proxy`
当前线上端点：`https://doh.leilaomi.ccwu.cc/dns-query`

## 0. 总结论

当前不要替换成 `cmliu/CF-Workers-DoH`。

`doh-proxy` 的定位应该保持为：

```text
极简、稳定、低暴露面的 DoH 代理端点
```

它适合放在 Karing 的：

```text
远程 DNS / 代理流量 DNS / 规则 DNS / Fake-IP 上游 DNS
```

不适合放在：

```text
代理服务器 DNS / 节点服务器 DNS / 启动前解析 DNS / 直连 DNS
```

后续动手方向不是“换项目”，而是：

1. 修正文档和 Karing 使用方式。
2. 增加健康检查能力。
3. 准备备用端点。
4. 保持代码极简，避免增加公开风险。

---

## 1. 第一阶段：文档与使用方式修正

### 1.1 README 增加 Karing DNS 分工说明

目标：避免以后再次把自建 Worker DoH 放到错误位置。

建议新增内容：

```text
Karing 推荐配置：

代理服务器 DNS / 启动 DNS：
- system
- 1.1.1.1
- 8.8.8.8
- 223.5.5.5
- 119.29.29.29

远程 DNS / 代理流量 DNS：
- https://doh.leilaomi.ccwu.cc/dns-query

不要把本项目 DoH 放进“代理服务器 DNS”，否则代理尚未建立前可能无法访问该 DoH，导致“代理服务器失败”。
```

### 1.2 README 增加故障解释

建议明确写：

```text
如果 Karing 提示“代理服务器失败”，通常不是本 DoH 协议不可用，而是它被放到了启动阶段 DNS 位置。请改用系统 DNS / 公共 DNS 作为代理服务器 DNS。
```

### 1.3 README 保持克制表达

不要在公开说明中过度强调：

```text
代理
翻墙
节点
科学上网
VLESS
```

可以使用更中性的表达：

```text
DNS over HTTPS resolver
private DNS endpoint
client DNS configuration
bootstrap DNS
remote DNS
```

---

## 2. 第二阶段：代码小增强

### 2.1 增加 `/health`

目标：让健康检查更清晰，不和 `/dns-query` 混在一起。

建议路径：

```text
GET /health
```

建议返回：

```json
{
  "status": "ok",
  "service": "doh-proxy",
  "endpoint": "/dns-query"
}
```

注意：

- 不返回完整环境变量值。
- 不暴露敏感配置。
- 可以返回上游 host，但不要返回 secret。

Workers 版本需要改：

```text
worker.js
```

Pages Functions 版本如果继续保留，需要同步增加：

```text
functions/health.js
```

或者只把 Pages Functions 当备用部署结构，README 说明清楚。

### 2.2 保留 `GET /dns-query` 空访问返回 `ok`

不要改掉这个行为。

原因：Karing 这类客户端可能用空 GET 做可用性检测。

当前行为：

```text
GET /dns-query → 200 ok
```

必须保留。

### 2.3 不加入复杂 UI

暂不建议加 cmliu 那种完整网页 DNS 查询页面。

原因：

1. 对 Karing 没帮助。
2. 增加暴露面。
3. 增加 Worker 请求入口。
4. 代码复杂度上升。
5. 可能增加被扫和滥用风险。

如果要美化根路径，只建议返回极简文本或极简 HTML：

```text
DoH Proxy running. Endpoint: /dns-query
```

---

## 3. 第三阶段：测试脚本增强

当前测试脚本已经覆盖：

```text
health
OPTIONS
RFC8484 GET
RFC8484 POST
```

建议后续增加：

### 3.1 测试 `/health`

新增测试项：

```text
GET /health
```

预期：

```text
200 application/json status=ok
```

### 3.2 测试错误方法

可选新增：

```text
PUT /dns-query → 405
POST /dns-query without application/dns-message → 415
/random-path → 404
```

这可以保证后续修改不会破坏边界行为。

### 3.3 保留线上测试命令

标准验证命令：

```bash
node scripts/test-doh.js https://doh.leilaomi.ccwu.cc/dns-query example.com
```

如果新增 `/health`，可以扩展脚本自动从 endpoint 推导 base URL。

---

## 4. 第四阶段：备用端点策略

### 4.1 不动正式端点

正式端点继续保持：

```text
https://doh.leilaomi.ccwu.cc/dns-query
```

### 4.2 新增测试/备用子域

推荐测试子域：

```text
doh-test.leilaomi.ccwu.cc
```

推荐备用子域：

```text
doh2.leilaomi.ccwu.cc
```

用途：

- `doh-test`：测试新代码、新上游、新功能。
- `doh2`：正式备用，不和测试混用。

### 4.3 备用部署方案

可选：

1. Cloudflare Worker 第二个服务。
2. Cloudflare Pages Functions。
3. Deno Deploy。
4. VPS + AdGuard Home / mosdns / smartdns。

优先级建议：

```text
Cloudflare Worker 第二服务 > Pages Functions > Deno Deploy > VPS
```

原因：最少改动、最快验证、域名体系一致。

---

## 5. 第五阶段：Karing 实际配置建议

### 5.1 如果节点服务器域名在境外

推荐：

```text
代理服务器 DNS：system / 1.1.1.1 / 8.8.8.8
远程 DNS：https://doh.leilaomi.ccwu.cc/dns-query
直连 DNS：223.5.5.5 / 119.29.29.29
```

### 5.2 如果节点服务器域名在国内可解析

推荐：

```text
代理服务器 DNS：223.5.5.5 / 119.29.29.29 / system
远程 DNS：https://doh.leilaomi.ccwu.cc/dns-query
```

### 5.3 如果经常出现“代理服务器失败”

优先改成：

```text
代理服务器 DNS：system
远程 DNS：https://doh.leilaomi.ccwu.cc/dns-query
```

不要第一时间改 Worker 代码。

---

## 6. 第六阶段：风险控制

### 6.1 不建议增加 TOKEN 路径

例如：

```text
/CMLiussss
```

理由：

- 会改变标准 `/dns-query` 路径。
- 部分客户端配置容易出错。
- 对 Karing 当前问题没有本质帮助。

如果未来要限制滥用，可考虑测试路径 token，但不是当前优先事项。

### 6.2 不建议加入 `/ip-info`

理由：

- 依赖第三方 `ip-api.com`。
- 增加接口暴露面。
- 对 DoH 客户端没有帮助。
- 可能引入额外限速/错误来源。

### 6.3 不建议加入主页反代伪装

理由：

- 简单反代不等于稳定伪装。
- 可能引入额外风险。
- 当前项目只需要低调极简首页即可。

---

## 7. 建议的实际动手顺序

### 第一步：改 README

目标：把 Karing 放置位置讲清楚。

涉及文件：

```text
README.md
```

验证：

```bash
git diff README.md
```

### 第二步：加 `/health`

涉及文件：

```text
worker.js
functions/health.js
scripts/test-doh.js
README.md
```

验证：

```bash
node --check worker.js
node --check functions/dns-query.js
node --check scripts/test-doh.js
node scripts/test-doh.js https://doh.leilaomi.ccwu.cc/dns-query example.com
```

部署前不要动线上。

### 第三步：本地/预部署检查

如果使用 Wrangler，可先检查配置：

```bash
wrangler deploy --dry-run
```

如 dry-run 不适用，再只做语法和脚本验证。

### 第四步：确认后部署

这是线上操作，执行前必须再次确认。

部署命令：

```bash
wrangler deploy
```

部署后验证：

```bash
node scripts/test-doh.js https://doh.leilaomi.ccwu.cc/dns-query example.com
curl -i https://doh.leilaomi.ccwu.cc/health
```

### 第五步：可选备用子域

这一步涉及 Cloudflare 路由/DNS，单独做，不和代码修改混在一起。

---

## 8. 本次暂不执行的事项

本计划阶段不执行：

```text
不部署
不改 DNS
不绑定新域名
不替换为 cmliu 项目
不加入完整网页查询 UI
不加入 /ip-info
不加入主页反代伪装
```

---

## 9. 最终推荐路线

推荐按这个顺序推进：

```text
README 修正 Karing 配置说明
  ↓
新增 /health
  ↓
增强 test-doh.js 覆盖 /health
  ↓
验证通过
  ↓
用户确认
  ↓
部署到现有 Cloudflare Worker
  ↓
线上复测
  ↓
再考虑 doh-test / doh2 备用端点
```

这个路线风险最低，也最符合当前问题本质。
