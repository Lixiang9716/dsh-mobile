# runtime/

quickjs-ng 集成与平台无关的 JS 运行时垫层：

- ESM 模块加载器（宿主实现 `JS_SetModuleLoaderFunc`，从 bundle 目录读取）
- `node:` 内置模块 shim 与全局 API 垫层（清单见 docs/ARCHITECTURE.md §3）
- 字节码缓存（`JS_WriteObject`）
- runtime 串行线程模型与事件循环
