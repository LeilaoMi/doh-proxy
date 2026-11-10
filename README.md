# Cloudflare DoH Proxy

一个跑在 Cloudflare Workers 上的 DNS over HTTPS（DoH）代理，提供两个端点：

| 端点 | 用途 | 行为 |
|---|---|---|
| `/dns-query` | v2rayNG / Karing / sing-box 等代理客户端 | 纯净转发上游，不改写 |
| `/<ECH_PATH>`（默认关闭） | Chrome / Edge / Firefox 浏览器「安全 DNS」 | 对 Cloudflare 托管站点改写应答，实现 **ECH 直连** |

部署后的端点形如（ECH 端点路径为私有 secret）：

```text
https://doh.example.com/dns-query        # 代理客户端
https://doh.example.com/<ECH_PATH>       # 浏览器
```

## 功能

- 标准 RFC 8484 DoH：`GET ?dns=...` 与 `POST application/dns-message`。
- `GET /dns-query` 空访问返回 `200 ok`，兼容 Karing 可用性检测。
- `GET /health` 健康检查（隐身模式下改用 `GET /<ECH_PATH>/health`）；`GET /<ECH_PATH>/resolve?name=&type=&mode=` 返回 JSON，手机浏览器上就能看改写结果。
- `/dns-query` 原样转发客户端报文（保留 EDNS、DO、CD 等），仅在开启 ECS 时重建查询。
- 可选按 IP 限速（Workers Rate Limiting 绑定 `RL`，默认 600 次/分钟），超出返回 429。
- **ECH 改写模式**（见下文）：注入 Cloudflare ECHConfig + alpn，A/AAAA 换成优选 IP，CNAME 展平。
- 优选 IP 三档可选：不配（用 CF 原 IP）/ 固定列表（可分运营商）/ 自建优选池（如 [cf-best-ip](https://github.com/LeilaoMi/cf-best-ip)），见「优选 IP」。
- 可选 ECS（EDNS Client Subnet），默认关闭。
- 按 DNS TTL 缓存（Cache API，10–300 秒），可关闭。
- CORS / OPTIONS 支持；Workers 与 Pages Functions 共用 `src/doh.js` 一份代码。

## 快速开始（fork 后）

两条路，按需选：

**只要一个 DoH 给代理客户端用**

1. fork 本仓库，`wrangler deploy`（或在 Cloudflare 控制台连接你的 fork 自动部署）。不用改任何文件。
2. 在 Worker 设置里绑定你自己的域名（国内访问 `workers.dev` 常被 SNI 阻断）。
3. 客户端填 `https://你的域名/dns-query`。

**还要浏览器 ECH 直连**

4. `wrangler secret put ECH_PATH`，设一个不可猜测的路径（例如 16 位随机串）。
5. 按需配置优选 IP（不配也能用）。
6. 浏览器安全 DNS 填 `https://你的域名/<ECH_PATH>?isp=ct`（`ct` 电信，联通换成 `cu`，移动换成 `cm`），打开 `https://crypto.cloudflare.com/cdn-cgi/trace` 看到 `sni=encrypted` 即成功。

变量都在控制台「设置 → 变量和机密」里填。`wrangler.toml` 设了 `keep_vars = true` 且没有 `[vars]`，同步上游、重新部署都不会冲掉你填的值；请不要为个人配置改 `wrangler.toml`，否则同步上游会冲突。

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
- 国内对境外 UDP 443 常有限速，`h3` 不通时浏览器会回退 `h2`；默认对移动（`?isp=cm`）只给 `h2`，其他情况体验差可在地址后加 `&alpn=h2`。注意带 `?isp=` 时运营商规则优先于 `ECH_ALPN`：只改 `ECH_ALPN` 不够，需同时设 `ECH_ALPN_BY_ISP=off` 或改对应运营商的规则。
- 浏览器必须自己用 DoH 查 HTTPS 记录才会用 ECH；只在系统或路由器设 DNS 不生效。

## 配置（控制台变量；默认值都在代码里，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOH_UPSTREAM` / `DOH` | `cloudflare-dns.com` | 上游 DoH |
| `ECH_PATH` | 空（关闭） | ECH 端点路径。用 `wrangler secret put ECH_PATH` 设置不可猜测的值，不要写进仓库；泄露后换一个即可 |
| `ECH_ALPN` | `h3,h2` | 注入的 alpn；带 `?isp=` 时被 `ECH_ALPN_BY_ISP` 覆盖 |
| `ECH_ALPN_BY_ISP` | `ct:h3,h2;cu:h3,h2;cm:h2` | 带 `?isp=` 时按运营商覆盖 alpn，设为 `off` 关闭。Worker 发不了 UDP，无法实测 QUIC，所以是静态开关 |
| `ECH_SOURCE` | `cloudflare-ech.com` | 从哪个域名获取 ECHConfig |
| `ECH_CONFIG` | 空 | 固定 ECHConfig（base64），设置后不再自动获取 |
| `ECH_FORCE` | 空 | 强制按 CF 处理的域名后缀，逗号分隔（需配合优选 IP） |
| `ECH_EXCLUDE` | 空 | 永不改写的域名后缀 |
| `BEST_IPV4` / `BEST_IPV6` | 空 | 固定优选 IP，逗号分隔 |
| `BEST_IPV4_CT` / `_CU` / `_CM`（IPv6 同理） | 空 | 按运营商的固定优选 IP，带 `?isp=` 时优先使用 |
| `BEST_IP_URL` | 空 | 优选池地址，格式见「优选 IP」。有 `BESTIP` 绑定时也用它的 host |
| `MAX_IPS` | `4` | 每个地址族最多返回几个 IP（1–8） |
| `POOL_LIMIT` | `200` | 每次向优选池请求的条数（1–1000，cf-best-ip 最多返回 200） |
| `ECS` | `off` | 开启后把客户端 IP 的 /24（IPv6 /56）写入 EDNS。默认上游 1.1.1.1 不使用 ECS，配合 `dns.google` 才有意义 |
| `CACHE` | `on` | 按 TTL 缓存上游应答 |

## 优选 IP

由简到繁三档，任选其一：

1. **不配**：返回上游原始的 CF 地址，ECH 照样生效，只是不一定是最快的线路。
2. **固定列表**：控制台填 `BEST_IPV4`，或按运营商分开填 `BEST_IPV4_CT` / `BEST_IPV4_CU` / `BEST_IPV4_CM`，浏览器地址带 `?isp=` 选用。列表需自己定期测速更新。
3. **自建优选池**：部署一个定时测速的服务，返回下面的 JSON，填进 `BEST_IP_URL`。同账号的 Worker 建议用 Service Binding（`BESTIP`，见 `wrangler.prod.example.toml`）调用：Worker 用公网地址调同账号同 zone 的 Worker 可能失败。

```json
{ "ips": [
  { "ip": "104.16.1.1", "family": "v4", "carrier": "ct", "ech": true },
  { "ip": "104.16.1.2", "family": "v4", "carrier": "cu", "ech": false },
  { "ip": "2606:4700::1", "family": "v6", "carrier": "cm", "tested": true }
] }
```

`family` 必填（`v4` / `v6`）；`carrier` 可选（`ct` / `cu` / `cm`，大小写不限）；`tested: false` 的条目会被忽略。

`ech` 可选：`true` 表示带 ECH 访问正常，`false` 表示带 ECH 会报 Cloudflare 1034（部分 CF IP 如此），`null` 或缺省表示未知（旧版池接口没有这个字段）。选 IP 时 `ech: false` 的 IP 一律剔除（同一 IP 任一行为 `false` 即剔除），其余按以下顺序分层拼接，每层内部保持池子原有顺序（延迟/评分），去重后取前 `MAX_IPS` 个。带 `?isp=` 时：

1. 运营商匹配 `?isp=` 且 `ech: true`
2. 无运营商标（`carrier` 为空 / `null` / 缺省）且 `ech: true`
3. 运营商匹配且 `ech` 未知
4. 无运营商标且 `ech` 未知
5. 标了其他运营商的条目（`ech: true` 在前，未知在后），仅作最后补位：它们是在别的运营商网络上测出来的，通常不如本运营商或通用 IP

不带 `?isp=` 时忽略运营商标，即 `ech: true` 在前、未知在后。全部被剔除时不改写，回退上游原始 IP（HTTPS 记录不带 ipv4hint/ipv6hint）。IPv4、IPv6 分别计算。旧版池接口（没有 `ech` 字段）：本运营商的 IP 在前，不足 `MAX_IPS` 时先用无运营商标的补齐，最后才用其他运营商的。手动配置的 IP（`?ip4=`、`BEST_IPV4*` 等）不做 ECH 过滤。

请求池子时总会带上 `limit=200`（可用 `POOL_LIMIT` 改，`BEST_IP_URL` 里原有的 `limit` / `top` 会被替换），让过滤后每个运营商仍有足够的可用 IP；并附加 `ech=1`，支持该参数的池接口会在服务端先排除 `ech: false`，不支持的接口会忽略它，客户端过滤照常生效。池结果缓存 10 分钟，请求失败时回退上游 IP。

优先级（IPv4、IPv6 各自独立判断）：`?ip4=` / `?ip6=` > `BEST_IPV4_<运营商>` > `BEST_IPV4` > 优选池 > 上游原 IP。格式不对的 IP 会被忽略，不会挡住下一级。

因为 `keep_vars = true`，从配置文件删掉某个变量不会清除线上已有的值；不再使用优选池时，请到控制台删除 `BEST_IP_URL`（固定列表同理）。

不建议使用别人的公共优选池：池决定流量去哪个 IP。TLS 证书仍会校验，不会被劫持，但可能被导向慢或不可用的节点，对方也随时可能限制访问。

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

## 部署

### 通用部署（fork 用户）

```bash
npm install -g wrangler
wrangler login                 # 或设置 CLOUDFLARE_API_TOKEN
wrangler secret put ECH_PATH   # 需要 ECH 时设置一次
wrangler deploy
```

也可以在 Cloudflare 控制台创建 Worker 时连接你的 fork，推送即部署，效果相同。部署后在 Worker 设置里绑定自定义域名、填变量。

### 需要 Service Binding 或想把域名写进配置

Service Binding 只能写在配置文件里。复制模板，个人配置不入库：

```bash
cp wrangler.prod.example.toml wrangler.prod.toml   # 已 gitignore
# 必改：routes 里的域名
# 必改：BEST_IP_URL 的 host 换成 cf-best-ip 的 ALLOWED_HOSTS 里允许的域名
# 没有 cf-best-ip：删掉 [[services]] 和 BEST_IP_URL；以前部署过的，还要到控制台删掉 BEST_IP_URL
wrangler deploy -c wrangler.prod.toml
```

> 两份配置的 Worker 名都是 `doh-proxy`。已用 `wrangler.prod.toml` 部署的，之后也只用它部署；直接 `wrangler deploy` 会打开 workers.dev 并去掉 `BESTIP` 绑定。想并行测试，先改 `wrangler.toml` 的 `name`，例如 `doh-proxy-test`。

### Pages Functions（可选）

```bash
wrangler pages secret put ECH_PATH --project-name doh-proxy   # Pages 不继承 Worker 的 secret
wrangler pages deploy public --project-name doh-proxy
```

Pages 没有 `RL` 限速绑定，`/dns-query` 不受限速保护；需要限速时请在 zone 的 WAF 里加 Rate limiting 规则，或只用 Workers 版。

`functions/[[path]].js` 把所有请求交给 `src/doh.js`，所以私有 `ECH_PATH` 在 Pages 上同样可用；优选 IP 用固定列表或 `BEST_IP_URL`。

## 测试

本地单元测试（Node 22+，无依赖，不联网）：优选池的 ECH 过滤、运营商分层顺序（其他运营商最后补位）、全部不可用时回退上游 IP、旧接口兼容、手动 IP 不过滤。

```bash
node --test test/*.test.mjs
```

线上端到端测试：

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

## 隐身模式（STEALTH）

国内常见的封锁方式：主机名带 `doh`、`dns` 会被按 SNI 重置，公开的 `/dns-query` 会被主动探测，探测到后整个域名被封。建议：

- 主机名用与 DNS 无关的名字，不要用 `doh.`、`dns.`。
- 设置变量 `STEALTH=1`。开启后 `/`、`/health`、`/dns-query` 一律返回 404，只保留 `/<ECH_PATH>`、`/<ECH_PATH>/resolve` 和 `/<ECH_PATH>/health`。
- 只有同时设置了 `ECH_PATH` 时 STEALTH 才生效，避免把自己锁在外面。
- 开启后 `scripts/test-doh.js` 中针对 `/dns-query` 的检查会失败，属于预期行为。
