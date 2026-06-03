# Cloudflare DoH Proxy

一个极简、稳定、适合 v2rayNG / Karing 使用的 DNS over HTTPS（DoH）代理。

当前已验证端点：

```text
https://doh.leilaomi.ccwu.cc/dns-query
```

## 功能

- 支持标准 RFC 8484 DoH：
  - `GET /dns-query?dns=...`
  - `POST /dns-query`，请求头 `content-type: application/dns-message`
- `GET /dns-query` 空访问返回 `200 ok`，兼容 Karing 这类客户端的可用性检测。
- 支持 CORS 和 `OPTIONS` 预检请求。
- 支持通过环境变量切换上游 DoH。
- 禁用响应缓存，避免 DNS 缓存污染。
- 同时提供 Workers 和 Pages Functions 两种部署方式。
- 提供测试脚本：健康检查、OPTIONS、RFC8484 GET、RFC8484 POST。

默认上游：

```text
https://cloudflare-dns.com/dns-query
```

可选环境变量：

```text
DOH_UPSTREAM=https://dns.google/dns-query
```

也兼容：

```text
DOH=dns.google
```

## 为什么建议绑定自定义子域名？

`*.workers.dev` / `*.pages.dev` 在部分网络或客户端里可能不稳定。建议绑定自己的子域名，例如：

```text
https://doh.example.com/dns-query
```

不要默认绑定根域名，除非你明确只想让根域名服务 DoH。

---

## Workers 部署教程

### 1. 安装 Wrangler

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 配置 `wrangler.toml`

最小配置：

```toml
name = "doh-proxy"
main = "worker.js"
compatibility_date = "2026-05-30"
workers_dev = true
```

推荐绑定自定义子域名：

```toml
name = "doh-proxy"
main = "worker.js"
compatibility_date = "2026-05-30"
workers_dev = true
routes = [
  { pattern = "doh.example.com", custom_domain = true }
]
```

### 4. 可选：配置上游 DoH

在 Cloudflare Worker 的环境变量里添加：

```text
DOH_UPSTREAM=https://dns.google/dns-query
```

如果不设置，默认使用：

```text
https://cloudflare-dns.com/dns-query
```

### 5. 部署

```bash
wrangler deploy
```

部署后端点为：

```text
https://doh-proxy.<你的 workers.dev 子域>.workers.dev/dns-query
```

如果绑定了自定义域名，则使用：

```text
https://doh.example.com/dns-query
```

也可以直接用命令绑定一次自定义域名：

```bash
wrangler deploy --domain doh.example.com
```

---

## Pages Functions 部署教程

本项目已包含 Pages Functions 文件：

```text
functions/dns-query.js
```

以及最小静态页面：

```text
public/index.html
```

### 1. 使用 Wrangler 部署 Pages

```bash
wrangler pages deploy public --project-name doh-proxy
```

部署后端点为：

```text
https://<你的 Pages 项目>.pages.dev/dns-query
```

### 2. 可选：配置上游 DoH

在 Cloudflare Pages 项目的环境变量里添加：

```text
DOH_UPSTREAM=https://dns.google/dns-query
```

不设置则默认使用：

```text
https://cloudflare-dns.com/dns-query
```

### 3. 推荐绑定自定义子域名

在 Cloudflare Dashboard：

1. 打开 **Workers & Pages**。
2. 选择你的 Pages 项目。
3. 进入 **Custom domains**。
4. 添加子域名，例如：

```text
doh.example.com
```

最终 DoH 地址：

```text
https://doh.example.com/dns-query
```

---

## 测试

运行内置测试脚本：

```bash
node scripts/test-doh.js https://doh.example.com/dns-query example.com
```

预期：`health`、`OPTIONS`、`RFC8484 GET`、`RFC8484 POST` 都显示 ✅。

手动健康检查：

```bash
curl -i https://doh.example.com/dns-query
```

预期：

```text
HTTP/2 200
ok
```

手动 CORS / OPTIONS 检查：

```bash
curl -i -X OPTIONS https://doh.example.com/dns-query
```

预期：`204`，并包含：

```text
access-control-allow-origin: *
access-control-allow-methods: GET, POST, OPTIONS
```

---

## v2rayNG / Karing 使用建议

远程 DNS / 代理流量 DNS 可填：

```text
https://doh.example.com/dns-query
```

Karing 如果出现“检查代理服务器失败”，不要把这个 DoH 用作 **代理服务器 DNS**。代理服务器 DNS 用系统 DNS、`1.1.1.1`、`8.8.8.8` 或 Cloudflare Zero Trust DoH；这个自建 DoH 更适合放在 **代理流量 DNS** 里。

## 和 Cloudflare Zero Trust DoH 的区别

| 项目 | 自建 Worker/Pages DoH | Cloudflare Zero Trust DoH |
|---|---|---|
| 代码可控 | ✅ | ❌ |
| 可换上游 | ✅ | ❌ |
| 适合代理后使用 | ✅ | ✅ |
| 适合代理前启动解析 | ⚠️ 取决于本地网络 | ✅ 通常更稳 |
| 推荐用途 | 代理流量 DNS | 代理服务器 DNS / 启动前解析 |

## 从 `cmliu/CF-Workers-DoH` 吸收的点

本项目没有照搬完整功能，而是只吸收对 v2rayNG / Karing 有用、且不会明显增加维护成本的部分：

- CORS / OPTIONS 兼容。
- 环境变量切换上游 DoH。
- 测试脚本。

没有加入 `/ip-info`、主页伪装、跳转、TOKEN 路径、JSON 查询页面等功能，因为这些对代理客户端 DoH 使用不是必需项，复杂度和公开服务风险更高。
