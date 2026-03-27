/**
 * 电台能力组件注册入口
 *
 * 在应用启动时（main.tsx import）调用，将各能力的面板/工具栏组件注册到 CapabilityRegistry。
 * 新增能力时：在此文件中新增一行 registerCapabilityComponent(...)。
 */

import { registerCapabilityComponent } from './CapabilityRegistry';
import { TunerCapabilityPanel, TunerCapabilitySurface } from './components/TunerCapability';
import { NumberLevelCapabilityPanel } from './components/NumberLevelCapability';

// 天调：panel + surface（surface 在工具栏 Popover 中露出）
// TunerCapabilitySurface 是无 props 组件，不接受标准 CapabilityComponentProps，
// 因为它内部通过 Hook 直接读取 store，这是设计上的有意取舍（Popover 上下文决定了这一设计）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerCapabilityComponent('tuner_switch', TunerCapabilityPanel, TunerCapabilitySurface as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerCapabilityComponent('tuner_tune', TunerCapabilityPanel, TunerCapabilitySurface as any);

// Level 类：仅面板，不露出 surface
registerCapabilityComponent('rf_power', NumberLevelCapabilityPanel);
registerCapabilityComponent('af_gain', NumberLevelCapabilityPanel);
registerCapabilityComponent('sql', NumberLevelCapabilityPanel);
