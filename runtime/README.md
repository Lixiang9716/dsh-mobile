# runtime/

quickjs-ng integration and the platform-independent JS runtime shim:

- ESM module loader (host implements `JS_SetModuleLoaderFunc`, reading from the bundle directory)
- `node:` builtin shims and global-API shims (inventory in docs/ARCHITECTURE.md §3)
- Bytecode cache (`JS_WriteObject`)
- Runtime serial-thread model and event loop
