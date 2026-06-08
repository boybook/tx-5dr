/**
 * 电台能力组件注册入口
 *
 * 在应用启动时（main.tsx import）调用，将各能力的面板/工具栏组件注册到 CapabilityRegistry。
 * 新增能力时：在此文件中新增一行 registerCapabilityComponent(...)。
 */

import { registerCapabilityComponent } from './CapabilityRegistry';
import { TunerCapabilityPanel, TunerCapabilitySurface } from './components/TunerCapability';
import { BooleanCapabilityPanel } from './components/BooleanCapability';
import { EnumCapabilityPanel } from './components/EnumCapability';
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
registerCapabilityComponent('mic_gain', NumberLevelCapabilityPanel);
registerCapabilityComponent('compressor', BooleanCapabilityPanel);
registerCapabilityComponent('compressor_level', NumberLevelCapabilityPanel);
registerCapabilityComponent('monitor_gain', NumberLevelCapabilityPanel);
registerCapabilityComponent('monitor_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('apf_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('apf_level', NumberLevelCapabilityPanel);
registerCapabilityComponent('vox_gain', NumberLevelCapabilityPanel);
registerCapabilityComponent('anti_vox', NumberLevelCapabilityPanel);
registerCapabilityComponent('vox_delay', NumberLevelCapabilityPanel);
registerCapabilityComponent('break_in_delay', NumberLevelCapabilityPanel);
registerCapabilityComponent('nb', BooleanCapabilityPanel);
registerCapabilityComponent('nb_level', NumberLevelCapabilityPanel);
registerCapabilityComponent('nr', BooleanCapabilityPanel);
registerCapabilityComponent('nr_level', NumberLevelCapabilityPanel);
registerCapabilityComponent('rf_gain', NumberLevelCapabilityPanel);
registerCapabilityComponent('if_shift', NumberLevelCapabilityPanel);
registerCapabilityComponent('pbt_in', NumberLevelCapabilityPanel);
registerCapabilityComponent('pbt_out', NumberLevelCapabilityPanel);
registerCapabilityComponent('cw_pitch', NumberLevelCapabilityPanel);
registerCapabilityComponent('key_speed', NumberLevelCapabilityPanel);
registerCapabilityComponent('notch_raw', NumberLevelCapabilityPanel);
registerCapabilityComponent('agc_time', NumberLevelCapabilityPanel);
registerCapabilityComponent('balance', NumberLevelCapabilityPanel);
registerCapabilityComponent('drive_gain', NumberLevelCapabilityPanel);
registerCapabilityComponent('digi_sel_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('digi_sel_level', NumberLevelCapabilityPanel);
registerCapabilityComponent('lock_mode', BooleanCapabilityPanel);
registerCapabilityComponent('mute', BooleanCapabilityPanel);
registerCapabilityComponent('vox', BooleanCapabilityPanel);
registerCapabilityComponent('auto_notch', BooleanCapabilityPanel);
registerCapabilityComponent('manual_notch', BooleanCapabilityPanel);
registerCapabilityComponent('rit_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('xit_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('tone_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('tone_squelch_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('beep_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('break_in_mode', EnumCapabilityPanel);
registerCapabilityComponent('agc_mode', EnumCapabilityPanel);
registerCapabilityComponent('preamp', EnumCapabilityPanel);
registerCapabilityComponent('attenuator', EnumCapabilityPanel);
registerCapabilityComponent('radio_mode', EnumCapabilityPanel);
registerCapabilityComponent('mode_bandwidth', EnumCapabilityPanel);
registerCapabilityComponent('split_enabled', BooleanCapabilityPanel);
registerCapabilityComponent('vfo_select', EnumCapabilityPanel);
registerCapabilityComponent('audio_if_mode', EnumCapabilityPanel);
registerCapabilityComponent('rit_offset', NumberLevelCapabilityPanel);
registerCapabilityComponent('xit_offset', NumberLevelCapabilityPanel);
registerCapabilityComponent('tuning_step', EnumCapabilityPanel);
// power_state has moved out of the capability system; PowerControlButton handles it
registerCapabilityComponent('repeater_shift', EnumCapabilityPanel);
registerCapabilityComponent('repeater_offset', NumberLevelCapabilityPanel);
registerCapabilityComponent('ctcss_tone', EnumCapabilityPanel);
registerCapabilityComponent('spectrum_data_output', BooleanCapabilityPanel);
registerCapabilityComponent('spectrum_hold', BooleanCapabilityPanel);
registerCapabilityComponent('spectrum_speed', EnumCapabilityPanel);
registerCapabilityComponent('spectrum_ref', NumberLevelCapabilityPanel);
registerCapabilityComponent('spectrum_average', NumberLevelCapabilityPanel);
registerCapabilityComponent('spectrum_vbw', EnumCapabilityPanel);
registerCapabilityComponent('spectrum_rbw', EnumCapabilityPanel);
registerCapabilityComponent('spectrum_during_tx', BooleanCapabilityPanel);
registerCapabilityComponent('spectrum_center_type', EnumCapabilityPanel);
registerCapabilityComponent('dcs_code', EnumCapabilityPanel);
