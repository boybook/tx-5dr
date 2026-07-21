/**
 * 串口设备路径工具
 *
 * macOS 为同一物理串口设备同时提供 callout（/dev/cu.X）与
 * dialin（/dev/tty.X）两个设备节点，二者在 DCD 阻塞语义上有差异，
 * 因此路径比较/改写时需要把仅 cu/tty 前缀不同的路径视为同一设备。
 */

const DARWIN_DEVICE_PREFIX = /^\/dev\/(?:cu|tty)\./;

/**
 * 提取 macOS 串口设备名（去掉 /dev/cu. 或 /dev/tty. 前缀）。
 * 非 macOS cu/tty 形态的路径返回 null。
 */
export function darwinSerialDeviceKey(path: string): string | null {
  const match = DARWIN_DEVICE_PREFIX.exec(path);
  return match ? path.slice(match[0].length) : null;
}

/**
 * 判断两个路径是否指向同一 macOS 物理串口设备（仅 cu/tty 前缀不同）。
 */
export function isSameDarwinSerialDevice(a: string, b: string): boolean {
  const keyA = darwinSerialDeviceKey(a);
  return keyA !== null && keyA === darwinSerialDeviceKey(b);
}

/**
 * 把 /dev/tty.X dialin 路径转换为 /dev/cu.X callout 路径。
 * 非 /dev/tty. 形态的路径返回 null。
 */
export function darwinCalloutPathFromDialin(path: string): string | null {
  if (!path.startsWith('/dev/tty.')) {
    return null;
  }
  return `/dev/cu.${path.slice('/dev/tty.'.length)}`;
}

/**
 * 判断路径是否是本机串口设备形态（/dev/* 或 Windows COMn）。
 * host:port 等 network 端点、自定义路径返回 false。
 */
export function looksLikeLocalSerialDevicePath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  const trimmed = path.trim();
  return trimmed.startsWith('/dev/') || /^COM\d+$/i.test(trimmed);
}
