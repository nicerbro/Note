# Floating Note

一个基于 Tauri 的轻量桌面浮空笔记应用，前端使用原生 HTML/CSS/JavaScript，桌面能力由 Tauri/Rust 提供。

## 目录说明

| 路径 | 说明 |
| --- | --- |
| `src-tauri/` | Tauri 主工程，包含 Rust 入口、窗口配置、托盘、全局快捷键、本地存储命令和构建配置。 |
| `src-tauri/src/main.rs` | Tauri 后端入口，负责数据读写、窗口置顶/隐藏、拖拽、缩放、托盘和快捷键。 |
| `src-tauri/tauri.conf.json` | Tauri 应用配置，指定前端目录、窗口属性、打包资源和应用图标。 |
| `frontend/` | 应用前端完整文件，Tauri 当前加载入口为 `frontend/index.html`。 |
| `frontend/app.js` | 笔记和任务的核心交互逻辑，包含本地状态、搜索、编辑、删除、窗口拖拽和缩放交互。 |
| `frontend/tauri-bridge.js` | 前端到 Tauri 命令的桥接层，暴露存储和桌面窗口能力。 |
| `frontend/styles.css` | 应用样式和响应式桌面布局。 |
| `frontend/assets/images/` | 前端界面使用的图片和图标资源。 |
| `assets/images/` | Tauri 原生层和打包使用的根图标资源，只保留 `app-tray.ico`、`app-icon.ico`、`app-icon.png`。 |
| `data/` | 旧版本项目数据迁移来源。Tauri 首次未读到用户数据时，会尝试从这里迁移 `notes.json`、`tasks.json`、`app-settings.json`。 |
| `tools/update-shortcut-icon.ps1` | 更新 Windows 桌面快捷方式图标的辅助脚本。 |
| `package.json` | Tauri CLI 脚本和 Node 侧开发依赖声明。 |
| `启动浮空笔记.cmd` | Windows 快捷启动脚本，进入项目目录后运行 Tauri 开发启动命令。 |
| `需求分析.md` | 项目需求记录。 |

## 运行

```powershell
npm.cmd install
npm.cmd start
```

## 检查

```powershell
npm.cmd run check
```

## 构建

```powershell
npm.cmd run build
```
