# Enterprise DAM

Private enterprise digital asset management for controlled collaboration between organizations.

## Local prerequisites

- Node.js 24+
- pnpm 10+
- Docker Desktop with Linux containers

## Start the foundation stack

```powershell
Copy-Item .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

The web console runs at `http://localhost:5173`, the API at `http://localhost:3000`,
and OpenAPI documentation at `http://localhost:3000/api/docs`.

The local PostgreSQL host port is `5433` because port `5432` is already reserved by
another local project.


## 测试策略（平衡质量与速度）
1. 分级验证：核心逻辑（状态变更、数据持久化、权限校验、支付/登录流程）必须验证；UI 文案、样式、样板代码只需代码审查，不跑测试。
2. 每个改动路径只测 1 轮：1 次正常路径 + 最多 1 次该路径上真实存在的关键异常（例如登录只测：正确凭据登入 + 错误密码被拒）。通过即止，禁止重复运行。
3. 边界测试只做两类：需求里明确提到的；业务中真实会发生且出错会造成实际损失的（如金额、账号锁定）。其余边界场景（超长输入、并发、特殊字符等）用代码审查排查，不靠运行测试。
4. 对抗性审查不依赖跑测试：交付前自己以攻击者视角审查代码（越权、注入、空指针、状态竞态），发现问题才修，没问题不跑额外测试。
5. 功能齐全靠需求清单保证：交付前逐条对照原始需求核对实现，任何未实现项必须列出说明，不得以"没测"为由遗漏。
6. 全套测试套件只在两种情况下运行：改动确实影响核心流程，或用户明确要求。
