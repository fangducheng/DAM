# 身份与权限迭代实施计划

## 目标

按已确认的设计交付可运行的身份与权限垂直切片：统一账号、多公司任职、管理员邀请、
TOTP MFA、轮换会话、集团/公司空间、Restricted 成员、目录 ACL、统一错误协议和管理界面。

## 切片一：数据与权限内核

1. 扩展 Prisma Schema：Tenant、组织层级、OrganizationMembership、Tenant 级群组、空间
   所有权、Invitation、TenantSecurityPolicy、会话令牌族和 MFA 恢复码。
2. 生成可回滚的迁移 SQL，补充跨 Tenant 约束、索引和初始系统权限数据。
3. 扩展 `@dam/contracts`：权限代码、系统角色、API 错误结构和身份 DTO。
4. 扩展 `@dam/config`：JWT、Cookie、密码哈希、TOTP 加密和登录限速配置。
5. 建立 `AuthorizationModule` 的纯策略内核，使用表驱动单元测试覆盖 RBAC、Restricted、
   继承 ACL、过期项和 DENY 优先。
6. 验证 Prisma、类型、单元测试、lint 和构建。

## 切片二：邀请、登录、MFA 与会话

1. 安装并锁定 Nest JWT、Argon2、TOTP、Fastify Cookie 和限速依赖。
2. 实现 `IdentityModule`：邀请创建/撤销/接受、密码设置、登录、MFA 挑战、恢复码、刷新、
   退出和会话撤销。
3. Access Token 仅返回响应体并由前端内存保存；Refresh Token 使用安全 Cookie，数据库
   保存哈希并执行令牌族重放检测。
4. 实现认证 Guard、当前用户上下文和管理员 MFA 强制策略。
5. 添加身份状态机、令牌轮换和重放检测单元/集成测试。
6. 添加本地开发引导命令，幂等创建首个 Tenant、公司和平台管理员。
7. 运行完整质量门禁和真实 API 冒烟验证。

## 切片三：组织、空间与 ACL 管理

1. 实现 `TenantModule`：Tenant、安全策略、组织层级、多公司任职、共享群组和成员管理。
2. 实现 `SpaceModule`：Tenant/Organization 所有权、系统角色、成员和 Restricted 成员。
3. 实现 ACL 管理接口，校验主体、资源和权限均位于同一 Tenant。
4. 接入统一授权 Guard：解析主体、检查空间角色、读取闭包表祖先 ACL、应用 DENY 优先。
5. 实现 `authorizationVersion` 缓存版本和成员/角色/ACL 变更失效。
6. 实现权限来源说明，返回空间角色、继承目录、目标 ACL 和拒绝原因的安全摘要。
7. 添加 A/B 私有空间、集团共享空间和单目录分享的集成/端到端测试。

## 切片四：前端与统一异常交互

1. 引入 Vue Router，拆分登录、安全设置、系统状态、组织管理、空间管理和权限面板页面。
2. 实现内存 Access Token、Cookie 刷新、路由守卫和并发刷新去重。
3. 实现统一 API 客户端和错误码映射：401 跳转、403 提示、404 安全消息、409 刷新、
   410 重新邀请、429 倒计时和 5xx requestId。
4. 字段错误使用行内提示，轮询错误使用状态条，主动操作错误使用消息提示或对话框。
5. 实现邀请接受、登录、MFA、会话管理、用户/任职/群组、空间成员和目录权限界面。
6. 使用桌面和移动视口验证无重叠、无横向溢出，补充前端交互测试。

## 收尾与验收

1. 更新 OpenAPI、环境样例、开发 Runbook 和进度文档。
2. 执行格式、lint、Prisma 校验、类型检查、单元/集成测试和生产构建。
3. 启动 PostgreSQL、Redis、MinIO、API 和 Web，完成邀请到登录、MFA、空间授权和拒绝访问
   的真实流程验证。
4. 将每个已通过的切片作为独立提交同步到 `D:\GitWarehouse`，GitHub 推送仍由用户决定。

## 首个实施检查点

先完成切片一。验收条件是新 Schema 和迁移可应用、系统权限目录可重复初始化、授权策略
内核具备完整矩阵测试，并且现有健康检查和生产构建不回归。
