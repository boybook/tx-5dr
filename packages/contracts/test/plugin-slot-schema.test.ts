import { describe, expect, it } from 'vitest';
import { PluginPanelDescriptorSchema, PluginPanelSlotSchema } from '../src/schema/plugin.schema';

describe('PluginPanelSlotSchema', () => {
  it('accepts every supported plugin panel slot', () => {
    expect(PluginPanelSlotSchema.parse('operator')).toBe('operator');
    expect(PluginPanelSlotSchema.parse('automation')).toBe('automation');
    expect(PluginPanelSlotSchema.parse('main-right')).toBe('main-right');
    expect(PluginPanelSlotSchema.parse('voice-left-top')).toBe('voice-left-top');
    expect(PluginPanelSlotSchema.parse('voice-right-top')).toBe('voice-right-top');
    expect(PluginPanelSlotSchema.parse('cw-right-top')).toBe('cw-right-top');
    expect(PluginPanelSlotSchema.parse('radio-control-toolbar')).toBe('radio-control-toolbar');
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

  it('validates radio control toolbar iframe panel metadata', () => {
    expect(PluginPanelDescriptorSchema.parse({
      id: 'rotator-button',
      title: 'rotatorTitle',
      component: 'iframe',
      pageId: 'rotator',
      slot: 'radio-control-toolbar',
      icon: 'brands:github',
      openMode: 'modal',
      uiSize: 'lg',
    })).toMatchObject({
      slot: 'radio-control-toolbar',
      icon: 'brands:github',
      openMode: 'modal',
      uiSize: 'lg',
    });

    expect(() => PluginPanelDescriptorSchema.parse({
      id: 'bad-toolbar',
      title: 'Bad',
      component: 'key-value',
      slot: 'radio-control-toolbar',
    })).toThrow('radio-control-toolbar panels must use iframe component');

    expect(() => PluginPanelDescriptorSchema.parse({
      id: 'missing-page',
      title: 'Missing',
      component: 'iframe',
      slot: 'radio-control-toolbar',
    })).toThrow('radio-control-toolbar panels must declare pageId');

    expect(() => PluginPanelDescriptorSchema.parse({
      id: 'bad-open-mode',
      title: 'Bad',
      component: 'iframe',
      pageId: 'rotator',
      slot: 'radio-control-toolbar',
      openMode: 'drawer',
    })).toThrow();

    expect(() => PluginPanelDescriptorSchema.parse({
      id: 'bad-size',
      title: 'Bad',
      component: 'iframe',
      pageId: 'rotator',
      slot: 'radio-control-toolbar',
      uiSize: 'xl',
    })).toThrow();
  });
});
