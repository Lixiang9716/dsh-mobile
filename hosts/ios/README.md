# hosts/ios/

iOS 宿主（M1–M3）：SwiftUI 壳 + 特权层 + 能力网关 + loopback carrier。

- QuickJS 专用串行线程，Swift↔JS 双向非阻塞，回调 dispatch 到 runtime queue
- carrier：静态文件服务 + WS↔消息总线 pump
- checkpoint 触发点：前后台切换 / 审批挂起
