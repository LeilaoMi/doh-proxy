# Cloudflare DoH Proxy

一个跑在 Cloudflare Workers 上的 DNS over HTTPS（DoH）代理，提供两个端点：

| 端点 | 用途 | 行为 |
|---|---|---|
| `/dns-query` | v2rayNG / Karing / sing-box 等代理客户端 | 纯净转发上游，不改写 |
| `/<ECH_PATH>`（默认关闭） | Chrome / Edge / Firefox 浏览器「安全 DNS」 | 对 Cloudflare 托管站点改写应答，实现 **ECH 直连** |

当前线上端点（ECH 端点路径为私有 secret，不写在这里）：

```text
https://doh.leilaomi.ccwu.cc/dns-query   # 代理客户端
```

## 功能

- 标准 RFC 8484 DoH：`GET ?dns=...` 与 `POST application/dns-message`。
- `GET /dns-query` 空访问返回 `200 ok`，兼容 Karing 可用性检测。
- `GET /health` 健康检查；`GET /<ECH_PATH>/resolve?name=&type=&mode=` 返回 JSON，手机浏览器上就能看改写结果。
- `/dns-query` 原样转发客户端报文（保留 EDNS、DO、CD 等），仅在开启 ECS 时重建查询。
- 可选按 IP 限速（Workers Rate Limiting 绑定 `RL`，默认 600 次/分钟），超出返回 429。
- **ECH 改写模式**（见下文）：注入 Cloudflare ECHConfig + alpn，A/AAAA 换成优选 IP，CNAME 展平。
- 优选 IP 来自同账号的 [cf-best-ip](https://github.com/LeilaoMi/cf-best-ip)（Service Binding），支持按运营商挑选。
- 可选 ECS（EDNS Client Subnet），默认关闭。
- 按 DNS TTL 缓存（Cache API，10–300 秒），可关闭。
- CORS / OPTIONS 支持；Workers 与 Pages Functions 共用 `src/doh.js` 一份代码。

## ECH 改写模式原理

浏览器开启 DoH 后会并行查询 A / AAAA / HTTPS（type 65）记录。HTTPS 记录里的 `ech=` 是服务器公钥，浏览器据此把真实域名加密进 ClientHello 内层，线路上只能看到外层 SNI `cloudflare-ech.com`。

ECH 端点对每个 A / AAAA / HTTPS 查询：

1. 先向上游查 A 记录，地址落在 Cloudflare 公布网段内即判定为 CF 站点；没有 A 记录时再看 AAAA（也可用 `ECH_FORCE` / `ECH_EXCLUDE` 手动指定）。不用 SOA/NS 判定：CF 托管的域名里可能有未开代理（灰云）的记录，按 SOA 改写会把这类站点解析坏。
2. 非 CF 站点：原样转发。
3. CF 站点：
   - **HTTPS**：合成 `1 . alpn=h3,h2 ipv4hint=<优选> ech=<CF 当前 ECHConfig>`。ECHConfig 从 `cloudflare-ech.com` 的 HTTPS 记录自动获取并缓存 30 分钟（CF 约每小时轮换，旧配置仍有效数小时）。
   - **A / AAAA**：返回优选 IP，记录直接挂在查询名下（CNAME 展平；Chromium 要求 A/AAAA 与 HTTPS 同名才会用 ECH）。
   - 没配置优选 IP 时，回退为上游原始的 CF 地址，仍注入 ECH。
4. 改写过程出错时自动回退为纯转发，不会让解析失败。

Cloudflare 边缘对所有 CF 站点都接受 ECH，即使站点面板里关了 ECH，所以不需要目标站点配合。

### 局限

- 只对 **托管在 Cloudflare 上** 的网站有效；Google、YouTube 等原样返回，仍需代理。
- 直连时目标网站能看到你的真实 IP，也绕不过地区限制。
- 外层 SNI 固定是 `cloudflare-ech.com`，特征明显，存在被针对的可能。
- 国内对境外 UDP 443 常有限速，`h3` 不通时浏览器会回退 `h2`；若体验差可把 `ECH_ALPN` 改为 `h2`。
- 浏览器必须自己用 DoH 查 HTTPS 记录才会用 ECH；只在系统或路由器设 DNS 不生效。

## 配置（`wrangler.toml` 的 `[vars]` 或控制台环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOH_UPSTREAM` / `DOH` | `cloudflare-dns.com` | 上游 DoH |
| `ECH_PATH` | 空（关闭） | ECH 端点路径。用 `wrangler secret put ECH_PATH` 设置不可猜测的值，不要写进仓库；泄露后换一个即可 |
| `ECH_ALPN` | `h3,h2` | 注入的 alpn |
| `ECH_ALPN_BY_ISP` | `ct:h3,h2;cu:h3,h2;cm:h2` | 带 `?isp=` 时按运营商覆盖 alpn。Worker 发不了 UDP，无法实测 QUIC，所以是静态开关 |
| `ECH_SOURCE` | `cloudflare-ech.com` | 从哪个域名获取 ECHConfig |
| `ECH_CONFIG` | 空 | 固定 ECHConfig（base64），设置后不再自动获取 |
| `ECH_FORCE` | 空 | 强制按 CF 处理的域名后缀，逗号分隔（需配合优选 IP） |
| `ECH_EXCLUDE` | 空 | 永不改写的域名后缀 |
| `BEST_IPV4` / `BEST_IPV6` | 空 | 固定优选 IP，逗号分隔，优先级高于优选池 |
| `BEST_IP_URL` | 空 | 优选池地址（cf-best-ip `/api/ips` 格式）。有 `BESTIP` 绑定时也用它的 host，需与 cf-best-ip 的 `ALLOWED_HOSTS` 一致 |
| `MAX_IPS` | `4` | 每个地址族最多返回几个 IP（1–8） |
| `ECS` | `off` | 开启后把客户端 IP 的 /24（IPv6 /56）写入 EDNS。默认上游 1.1.1.1 不使用 ECS，配合 `dns.google` 才有意义 |
| `CACHE` | `on` | 按 TTL 缓存上游应答 |

绑定：

```toml
[[services]]
binding = "BESTIP"      # 优选 IP 池
service = "cf-best-ip"
```

### 请求级参数（写在 DoH 地址后面）

```text
https://doh.example.com/<ECH_PATH>?isp=cm          # 按运营商挑优选 IP：ct 电信 / cu 联通 / cm 移动
https://doh.example.com/<ECH_PATH>?ip4=1.2.3.4,5.6.7.8&ip6=2606:4700::1
https://doh.example.com/<ECH_PATH>?alpn=h2         # 只给 h2
https://doh.example.com/<ECH_PATH>?no6=1           # 不返回 IPv6
```

## 客户端设置

### 电脑 / 手机浏览器（ECH 直连）

- Chrome / Edge：设置 → 隐私和安全 → 安全 → 使用安全 DNS → 自定义，填 `https://doh.example.com/<ECH_PATH>`（可带 `?isp=`）。
- Firefox：设置 → 隐私与安全 → DNS over HTTPS → 最大保护，自定义填同一地址。
- 验证：打开 `https://crypto.cloudflare.com/cdn-cgi/trace`，看到 `sni=encrypted` 即生效。

### v2rayNG / Karing（代理客户端）

- 只用 `/dns-query`，不要用 ECH 端点：ECH 会让客户端看不到真实域名，按域名分流可能失效。
- 远程 DNS / 代理流量 DNS 填 `https://doh.example.com/dns-query`。
- 代理服务器 DNS / 启动 DNS 用 system、223.5.5.5、119.29.29.29 等，不要用自建 DoH。

### 安卓「私人 DNS」（DoT）

不建议在使用 CF 节点时开启。系统 DoT 的请求会被代理 App 的 VPN 收进隧道，而 CF Worker 节点无法连接 Cloudflare 自己的 IP（Zero Trust Gateway 的 DoT 正好在 CF 上），结果 DNS 全部失败，看起来像节点不可用；VPS 节点不受影响。建议关闭私人 DNS，在代理 App 内配置 DoH。

## 部署（手动）

```bash
npm install -g wrangler
wrangler login            # 或设置 CLOUDFLARE_API_TOKEN
wrangler secret put ECH_PATH   # 首次部署设置一次
wrangler deploy
```

`wrangler.toml` 已设 `workers_dev = false` 并绑定自定义域名 `doh.leilaomi.ccwu.cc`。

### Pages Functions（可选）

```bash
wrangler pages secret put ECH_PATH --project-name doh-proxy   # Pages 不继承 Worker 的 secret
wrangler pages deploy public --project-name doh-proxy
```

Pages 没有 `RL` 限速绑定，`/dns-query` 不受限速保护；需要限速时请在 zone 的 WAF 里加 Rate limiting 规则，或只用 Workers 版。

`functions/[[path]].js` 把所有请求交给 `src/doh.js`，所以私有 `ECH_PATH` 在 Pages 上同样可用；优选 IP 需用 `BEST_IPV4` 或 `BEST_IP_URL`。

## 测试

```bash
node scripts/test-doh.js https://doh.example.com/dns-query example.com [CF站点，默认 crypto.cloudflare.com]
```

覆盖：空访问、`/health`、OPTIONS、RFC8484 GET / POST、ECH 改写、415、404。ECH 改写测试需要与线上一致的路径，未设置时显示为跳过：

```bash
ECH_PATH=<你的路径> node scripts/test-doh.js https://doh.example.com/dns-query example.com
```

`RL` 绑定调用异常时会放行请求（优先保证可用性）。

手动查看改写结果：

```bash
curl "https://doh.example.com/<ECH_PATH>/resolve?name=discord.com&type=HTTPS"
curl "https://doh.example.com/<ECH_PATH>/resolve?name=discord.com&type=A&isp=ct"
curl "https://doh.example.com/<ECH_PATH>/resolve?name=www.google.com&type=A&mode=plain"
```

## 同类项目参考

- [1molchuan/edge-smart-doh](https://github.com/1molchuan/edge-smart-doh)（AGPL-3.0）：按运营商实测优选 IP、探针决定是否给 h3，功能最完整。
- [RememberOurPromise/Total-ECH](https://github.com/RememberOurPromise/Total-ECH)：CF + Meta CDN 的 ECH 注入，单文件 Worker。
- [rosenii/Doh-ECH](https://github.com/rosenii/Doh-ECH)：ECH 注入 + HTTPS RR 增强模式。
- [dahisea/cloudflare-enech-dns-worker](https://github.com/dahisea/cloudflare-enech-dns-worker)：用 SOA 判定 CF 站点。

本项目代码为独立实现，未复制上述项目代码。
