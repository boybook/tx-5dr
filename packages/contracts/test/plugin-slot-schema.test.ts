import { describe, expect, it } from 'vitest';
import { PluginPanelDescriptorSchema, PluginPanelSlotSchema } from '../src/schema/plugin.schema';

describe('PluginPanelSlotSchema', () => {
  it('accepts every supported plugin panel slot', () => {
    expect(PluginPanelSlotSchema.parse('operator')).toBe('operator');
    expect(PluginPanelSlotSchema.parse('automation')).toBe('automation');
    expect(PluginPanelSlotSchema.parse('main-right')).toBe('main-right');
    expect(PluginPanelSlotSchema.parse('voice-left-top')).toBe('voice-left-top');
    expect(PluginPanelSlotSchema.parse('voice-right-top')).toBe('voice-right-top');
  });

  it('validates iframe panels declared in the new host slots', () => {
    expect(() => PluginPanelDescriptorSchema.parse({
      id: 'main-pane',
      title: 'mainPaneTitle',
      component: 'iframe',
      pageId: 'main-pane',
      slot: 'main-right',
    })).not.toThrow();

    expect(() => PluginPanelDescriptorSchema.parse({
      id: 'voice-top',
      title: 'voiceTopTitle',
      component: 'iframe',
      pageId: 'voice-top',
      slot: 'voice-right-top',
    })).not.toThrow();
  });
});
