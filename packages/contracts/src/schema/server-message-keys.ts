/**
 * 服务端推送的文本消息 key 枚举
 * 前端根据 key 查找对应翻译，兜底显示 title/text 原始值
 */
export enum ServerMessageKey {
  /** 时序告警：操作员自动决策可能赶不上此发射时隙的编码 */
  TIMING_ALERT = 'timingAlert',

  /** 电台已连接 */
  RADIO_CONNECTED = 'radioConnected',

  /** QSO 已记录 */
  QSO_LOGGED = 'qsoLogged',

  /** QSO 已更新 */
  QSO_UPDATED = 'qsoUpdated',

  /** 实时语音连接异常 */
  REALTIME_CONNECTIVITY_WARNING = 'realtimeConnectivityWarning',

  /** 服务端实时语音桥接异常 */
  REALTIME_BRIDGE_DOWN = 'realtimeBridgeDown',

  /** 实时语音链路无音频数据 */
  REALTIME_NO_AUDIO = 'realtimeNoAudio',
}
