resources 目录用于承载随应用分发的便携 Node 与运行期资源。

目录约定：

- bin/<platform-arch>/node[.exe]
  例如：
  - bin/win32-x64/node.exe
  - bin/win32-arm64/node.exe
  - bin/darwin-x64/node
  - bin/darwin-arm64/node
  - bin/linux-x64/node
  - bin/linux-arm64/node

- app/
  可选原生模块与额外资源目录（如放置 native/*.node 等）。

CI/打包：请在打包前将对应平台的 node 可执行文件拷贝到 bin/<triplet>/ 下；
Electron 主进程会从此处定位并用子进程方式启动后端与静态 web 服务。

