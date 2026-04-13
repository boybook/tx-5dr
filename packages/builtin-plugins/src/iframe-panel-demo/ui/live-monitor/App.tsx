/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

const MAX_LOG_LINES = 20;

export function App() {
  const [label, setLabel] = useState('Demo');
  const [counter, setCounter] = useState(0);
  const [signalWidth, setSignalWidth] = useState(0);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((text: string) => {
    setLogLines(prev => {
      const next = [...prev, `${new Date().toLocaleTimeString()} ${text}`];
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
  }, []);

  useEffect(() => {
    const bridge = window.tx5dr;

    bridge.invoke('getState').then((state: any) => {
      setCounter(state.counter);
      setLabel(state.label);
    }).catch(() => {});

    const onTick = (data: any) => {
      const pct = Math.max(0, Math.min(100, (data.signalStrength + 50) / 40 * 100));
      setSignalWidth(pct);
      appendLog(`Signal: ${data.signalStrength.toFixed(1)} dBm`);
    };
    const onCounterUpdated = (data: any) => setCounter(data.counter);
    const onLabelUpdated = (data: any) => setLabel(data.label);
    const onStateReset = (data: any) => { setCounter(data.counter); setLabel(data.label); };

    bridge.onPush('tick', onTick);
    bridge.onPush('counterUpdated', onCounterUpdated);
    bridge.onPush('labelUpdated', onLabelUpdated);
    bridge.onPush('stateReset', onStateReset);

    return () => {
      bridge.offPush('tick', onTick);
      bridge.offPush('counterUpdated', onCounterUpdated);
      bridge.offPush('labelUpdated', onLabelUpdated);
      bridge.offPush('stateReset', onStateReset);
    };
  }, [appendLog]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  useAutoResize();

  return (
    <div className="container">
      <div className="signal-bar">
        <div className="signal-fill" style={{ width: `${signalWidth}%` }} />
      </div>
      <div className="stats">
        <span className="label">{label}</span>
        <span className="counter">{counter}</span>
      </div>
      <div className="log" ref={logRef}>
        {logLines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  );
}
