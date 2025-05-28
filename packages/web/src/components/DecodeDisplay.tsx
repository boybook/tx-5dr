import React, { useState, useEffect } from 'react';
import type { SlotPack, FT8Frame } from '@tx5dr/contracts';
import './DecodeDisplay.css';

interface DecodeDisplayProps {
  slotPacks: SlotPack[];
}

interface DecodeEntry {
  id: string;
  time: string;
  snr: number;
  dt: number;
  freq: number;
  message: string;
  slotId: string;
  confidence: number;
}

export const DecodeDisplay: React.FC<DecodeDisplayProps> = ({ slotPacks }) => {
  const [decodes, setDecodes] = useState<DecodeEntry[]>([]);
  const [maxEntries] = useState(100); // 最多显示100条记录

  useEffect(() => {
    // 将所有SlotPack中的frames转换为DecodeEntry
    const newDecodes: DecodeEntry[] = [];
    
    slotPacks.forEach(slotPack => {
      slotPack.frames.forEach((frame: FT8Frame, index: number) => {
        const slotStartTime = new Date(slotPack.startMs);
        const utcTime = slotStartTime.toISOString().slice(11, 19); // HH:MM:SS
        
        newDecodes.push({
          id: `${slotPack.slotId}-${index}`,
          time: utcTime,
          snr: frame.snr,
          dt: frame.dt,
          freq: frame.freq,
          message: frame.message,
          slotId: slotPack.slotId,
          confidence: frame.confidence
        });
      });
    });

    // 按时间排序（最新的在前）
    newDecodes.sort((a, b) => b.time.localeCompare(a.time));
    
    // 限制条目数量
    setDecodes(newDecodes.slice(0, maxEntries));
  }, [slotPacks, maxEntries]);

  const formatSNR = (snr: number): string => {
    return snr >= 0 ? `+${snr}` : `${snr}`;
  };

  const formatDT = (dt: number): string => {
    return dt.toFixed(1);
  };

  const formatFreq = (freq: number): string => {
    return Math.round(freq).toString();
  };

  const getConfidenceColor = (confidence: number): string => {
    if (confidence >= 0.8) return '#4CAF50'; // 绿色 - 高置信度
    if (confidence >= 0.6) return '#FF9800'; // 橙色 - 中等置信度
    return '#F44336'; // 红色 - 低置信度
  };

  return (
    <div className="decode-display">
      <div className="decode-header">
        <h3>解码消息 ({decodes.length})</h3>
        <div className="decode-legend">
          <span className="legend-item">时间</span>
          <span className="legend-item">SNR</span>
          <span className="legend-item">DT</span>
          <span className="legend-item">频率</span>
          <span className="legend-item">消息</span>
        </div>
      </div>
      
      <div className="decode-list">
        {decodes.length === 0 ? (
          <div className="no-decodes">
            <p>暂无解码消息</p>
            <p className="hint">启动数字无线电引擎后，解码结果将在此显示</p>
          </div>
        ) : (
          decodes.map((decode) => (
            <div key={decode.id} className="decode-entry">
              <span className="decode-time">{decode.time}</span>
              <span className={`decode-snr ${decode.snr >= 0 ? 'positive' : 'negative'}`}>
                {formatSNR(decode.snr)}
              </span>
              <span className="decode-dt">{formatDT(decode.dt)}</span>
              <span className="decode-freq">{formatFreq(decode.freq)}</span>
              <span className="decode-separator">~</span>
              <span className="decode-message">{decode.message}</span>
              <span 
                className="decode-confidence"
                style={{ backgroundColor: getConfidenceColor(decode.confidence) }}
                title={`置信度: ${(decode.confidence * 100).toFixed(1)}%`}
              />
            </div>
          ))
        )}
      </div>
      
      {decodes.length > 0 && (
        <div className="decode-stats">
          <span>显示最近 {decodes.length} 条解码结果</span>
        </div>
      )}
    </div>
  );
}; 