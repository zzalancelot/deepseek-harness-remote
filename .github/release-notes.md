## 中文

**0.5.14** 修复 Host 远程创建工作区时父目录不存在导致的 `ENOENT`/`realpath` 失败。所有自有包与客户端版本均为 **0.5.14**，发布 Tag 为 **v0.5.14**。Android `versionCode` / Expo iOS `buildNumber` 为 **58**。

- **Host 工作区目录预创建**：远程 `workspace/create` 转发到原生 Harness 前，先在 Host 上对目标路径执行递归 `mkdir`。此前创建 `…/MarcoAgent/<账号>` 时若父目录不存在，原生 `realpath` 会直接失败，导致 Marco 等客户端无法挂账号工作区。
- **安装提示**：Host 需安装/升级到 `ds-harness-remote@0.5.14` 并重启插件后生效；仅升级 Marco Bridge 不能消除该 ENOENT。

### 验证与待验收范围

插件侧新增「创建前建目录」单元测试；需在真实 Host 上用远程 `workspace/create`（或 Marco「重新背调」）验收账号工作区创建。完整 Android 矩阵与跨端验收不在本次补丁范围。

## English

**0.5.14** fixes Host remote workspace creation failing with `ENOENT`/`realpath` when parent directories are missing. All first-party package and client versions are **0.5.14**, matching tag **v0.5.14**. Android `versionCode` / Expo iOS `buildNumber` are **58**.

- **Host workspace directory ensure:** before forwarding remote `workspace/create` to native Harness, recursively `mkdir` the target path on the Host. Creating `…/MarcoAgent/<account>` previously failed when parents were absent because native `realpath` requires the directory to exist.
- **Install note:** Hosts must install/upgrade to `ds-harness-remote@0.5.14` and restart the plugin; upgrading only Marco Bridge does not clear this ENOENT.

### Validation and acceptance limits

Adds a unit test that missing folders are created before `workspace/create` is dispatched. Real-Host acceptance via remote workspace create (or Marco research regenerate) is still required. Full Android/matrix cross-client acceptance is out of scope for this patch.

---

[安装说明](https://github.com/liguobao/ds-harness-remote/blob/v0.5.14/README.zh.md#安装) · [Installation](https://github.com/liguobao/ds-harness-remote/blob/v0.5.14/README.md#install) · [完整改动 / Full changelog](https://github.com/liguobao/ds-harness-remote/compare/v0.5.13...v0.5.14)
