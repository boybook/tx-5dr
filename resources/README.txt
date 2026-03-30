resources 目录用于承载随应用分发的便携 Node、LiveKit 服务端与运行期资源。

目录约定：

- bin/<platform-arch>/node[.exe]
- bin/<platform-arch>/livekit-server[.exe]
  例如：
  - bin/win32-x64/node.exe
  - bin/win32-x64/livekit-server.exe
  - bin/win32-arm64/node.exe
  - bin/win32-arm64/livekit-server.exe
  - bin/darwin-x64/node
  - bin/darwin-x64/livekit-server
  - bin/darwin-arm64/node
  - bin/darwin-arm64/livekit-server
  - bin/linux-x64/node
  - bin/linux-x64/livekit-server
  - bin/linux-arm64/node
  - bin/linux-arm64/livekit-server

- app/
  可选原生模块与额外资源目录（如放置 native/*.node 等）。

CI/打包：请在打包前将对应平台的 node 与 livekit-server 可执行文件放到 bin/<triplet>/ 下；
Electron 主进程会从此处定位并用子进程方式启动 LiveKit、后端与静态 web 服务。
