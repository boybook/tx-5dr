resources 目录用于承载随应用分发的便携 Node、native runtime 与运行期资源。

预期结构：
- bin/<platform-arch>/node[.exe]
  - bin/win32-x64/node.exe
  - bin/darwin-x64/node
  - bin/darwin-arm64/node
  - bin/linux-x64/node
  - bin/linux-arm64/node
- app/ 打包后的 TX-5DR 工作区内容

实时语音由 TX-5DR server 内置 rtc-data-audio DataChannel 提供；Electron 主进程不再启动额外的实时语音子进程。
