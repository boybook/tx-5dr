import { EventEmitter } from 'eventemitter3';
import { type IDecodeQueue, type DecodeRequest, type DecodeResult } from '@tx5dr/core';
export interface DecodeWorkQueueEvents {
    'decodeComplete': (result: DecodeResult) => void;
    'decodeError': (error: Error, request: DecodeRequest) => void;
    'queueEmpty': () => void;
}
/**
 * 使用 wsjtx-lib 进行解码
 */
export declare class WSJTXDecodeWorkQueue extends EventEmitter<DecodeWorkQueueEvents> implements IDecodeQueue {
    private pool;
    private queueSize;
    private maxConcurrency;
    constructor(maxConcurrency?: number);
    /**
     * 推送解码请求到队列
     */
    push(request: DecodeRequest): Promise<void>;
    /**
     * 获取队列大小
     */
    size(): number;
    /**
     * 获取工作池状态
     */
    getStatus(): {
        queueSize: number;
        maxConcurrency: number;
        activeThreads: number;
        utilization: number;
    };
    /**
     * 销毁工作池
     */
    destroy(): Promise<void>;
}
//# sourceMappingURL=WSJTXDecodeWorkQueue.d.ts.map