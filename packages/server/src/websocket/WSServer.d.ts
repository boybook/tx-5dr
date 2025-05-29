import type { DecodeErrorInfo, FT8Spectrum, ModeDescriptor, SlotInfo, SlotPack, SubWindowInfo, SystemStatus } from '@tx5dr/contracts';
import { WSMessageHandler } from '@tx5dr/core';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
/**
 * WebSocket连接包装器
 * 为每个客户端连接提供消息处理能力
 */
export declare class WSConnection extends WSMessageHandler {
    private ws;
    private id;
    constructor(ws: any, id: string);
    /**
     * 发送消息到客户端
     */
    send(type: string, data?: any, id?: string): void;
    /**
     * 关闭连接
     */
    close(): void;
    /**
     * 获取连接ID
     */
    getId(): string;
    /**
     * 检查连接是否活跃
     */
    get isAlive(): boolean;
}
/**
 * WebSocket服务器
 * 管理多个客户端连接和消息广播，集成业务逻辑处理
 */
export declare class WSServer extends WSMessageHandler {
    private connections;
    private connectionIdCounter;
    private digitalRadioEngine;
    constructor(digitalRadioEngine: DigitalRadioEngine);
    /**
     * 设置DigitalRadioEngine事件监听器
     */
    private setupEngineEventListeners;
    /**
     * 处理客户端命令
     */
    private handleClientCommand;
    /**
     * 处理启动引擎命令
     */
    private handleStartEngine;
    /**
     * 处理停止引擎命令
     */
    private handleStopEngine;
    /**
     * 处理获取状态命令
     */
    private handleGetStatus;
    /**
     * 处理设置模式命令
     */
    private handleSetMode;
    /**
     * 添加新的客户端连接
     */
    addConnection(ws: any): WSConnection;
    /**
     * 移除客户端连接
     */
    removeConnection(id: string): void;
    /**
     * 获取指定连接
     */
    getConnection(id: string): WSConnection | undefined;
    /**
     * 获取所有活跃连接
     */
    getActiveConnections(): WSConnection[];
    /**
     * 广播消息到所有客户端
     */
    broadcast(type: string, data?: any, id?: string): void;
    /**
     * 发送消息到指定客户端
     */
    sendToConnection(connectionId: string, type: string, data?: any, id?: string): boolean;
    /**
     * 广播模式变化事件
     */
    broadcastModeChanged(mode: ModeDescriptor): void;
    /**
     * 广播时隙开始事件
     */
    broadcastSlotStart(slotInfo: SlotInfo): void;
    /**
     * 广播子窗口事件
     */
    broadcastSubWindow(windowInfo: SubWindowInfo): void;
    /**
     * 广播时隙包更新事件
     */
    broadcastSlotPackUpdated(slotPack: SlotPack): void;
    /**
     * 广播频谱数据事件
     */
    broadcastSpectrumData(spectrumData: FT8Spectrum): void;
    /**
     * 广播解码错误事件
     */
    broadcastDecodeError(errorInfo: DecodeErrorInfo): void;
    /**
     * 广播系统状态事件
     */
    broadcastSystemStatus(status: SystemStatus): void;
    /**
     * 清理所有连接
     */
    cleanup(): void;
    /**
     * 获取连接统计信息
     */
    getStats(): {
        total: number;
        active: number;
        inactive: number;
    };
}
//# sourceMappingURL=WSServer.d.ts.map