/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useRef } from 'react';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

export function App() {
  const [counter, setCounter] = useState(0);
  const [labelValue, setLabelValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bridge = window.tx5dr;
    bridge.invoke('getState').then((state: any) => {
      setCounter(state.counter);
      setLabelValue(state.label);
    }).catch(() => {});
  }, []);

  useAutoResize();

  const handleIncrement = () => {
    window.tx5dr.invoke('increment').then((result: any) => {
      setCounter(result.counter);
    });
  };

  const handleSetLabel = () => {
    const label = labelValue.trim();
    if (label) {
      window.tx5dr.invoke('setLabel', { label });
    }
  };

  const handleReset = () => {
    window.tx5dr.invoke('reset').then((result: any) => {
      setCounter(result.counter);
      setLabelValue(result.label);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSetLabel();
  };

  return (
    <div className="container">
      <div className="control-row">
        <input
          ref={inputRef}
          type="text"
          placeholder="Label"
          value={labelValue}
          onChange={e => setLabelValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="btn btn-sm" onClick={handleSetLabel}>Set</button>
      </div>
      <div className="control-row">
        <button className="btn btn-primary" onClick={handleIncrement}>+1</button>
        <span className="value">{counter}</span>
        <button className="btn btn-danger btn-sm" onClick={handleReset}>Reset</button>
      </div>
    </div>
  );
}
