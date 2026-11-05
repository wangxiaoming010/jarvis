# 构建与发布

源码仓库与桌面安装包分别验证。当前安装包流程仅验证 macOS Apple Silicon，最低 macOS 版本为 12；Windows / Linux 安装包尚未验证，当前不提供自动更新。

## 源码检查

在干净检出中执行：

```sh
npm ci
npm run format:check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run release:check
npm run release:check -- --history
```

`release:check` 扫描将提交的文件、版本一致性和文档本地链接；`--history` 还扫描所有本地分支和标签可达的 Git 历史内容。检查仅输出位置，不回显疑似密钥。它不能识别所有秘密；若凭据曾进入历史，应先撤销或轮换，再处理历史，删除当前文件并不够。

发布源码还应包含 MIT 许可、第三方来源、贡献指南和安全说明。不要用包含 `.env`、`.data` 或构建缓存的工作目录直接压缩上传；使用 GitHub 的源码归档或对已提交引用执行 `git archive`。

## 版本与说明

根目录和各工作区的 `package.json`、`package-lock.json`、Tauri 配置、`Cargo.toml` 与桌面 crate 的 `Cargo.lock` 条目应使用相同版本。版本说明放在 `docs/releases/vX.Y.Z.md`，只描述实际实现和验证过的平台。

## 本地构建

```sh
npm run tauri:build
```

构建包含前端、Node.js、后台、Bridge、SQLite 模块、迁移和依赖许可，并验证实际打包后台的独立启动、连接、持久化和退出恢复。未配置签名及公证时，只生成本地测试包。

## macOS 签名与公证

先在本机钥匙串准备目标团队的 **Developer ID Application** 证书及其私钥。确认团队一致，不能使用 Apple Development、Apple Distribution 或其他团队的证书替代。

```sh
security find-identity -v -p codesigning
xcrun notarytool store-credentials openbot-notary --team-id YOUR_TEAM_ID
```

按终端提示提供该团队的 Apple ID 和 App 专用密码；不把密码放在命令参数、文档或仓库中。

```sh
APPLE_TEAM_ID='YOUR_TEAM_ID' \
APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (YOUR_TEAM_ID)' \
APPLE_NOTARY_PROFILE='openbot-notary' npm run tauri:build
```

脚本核对签名团队，签名内置 Node.js、原生模块和应用，分别公证应用与 DMG、附加票据并执行系统安装检查。产物位于 `apps/desktop/src-tauri/target/release/bundle/dmg/`：

- `Personal-OpenBot-Group_X.Y.Z_arm64.dmg`
- `SHA256SUMS`
- `release-metadata.json`，记录签名、公证及文件摘要。

若签名包已构建完成，可使用相同环境变量运行 `npm run tauri:build -- --notarize-only`。该模式复用现有应用，仅完成公证与重新生成 DMG；应用签名必须已属于指定团队。

若公证上传遇到连接超时，可额外设置 `APPLE_NOTARY_S3_ACCELERATION=false`，切换为普通 S3 上传，再使用 `--notarize-only` 重试，无需重新编译。

若本机使用系统网络代理，上传进程可能还需要继承对应的 `HTTP_PROXY`、`HTTPS_PROXY` 及小写同名变量。仅对本次构建设置即可，不必修改系统代理。

## GitHub Release

先提交并推送已验证的代码，以确切提交创建版本标签和 Release 草稿。上传上述三个文件，用 `docs/releases/vX.Y.Z.md` 作为版本说明。

公开前核对：标签对应构建源码、上传摘要与本地一致、元数据中 `signed` 和 `notarized` 均为 `true`。挂载 DMG 检查应用签名和公证票据，并验证安装及启动。完成这些检查后公开草稿；未公证的测试包不作为正式 macOS Release 发布。
