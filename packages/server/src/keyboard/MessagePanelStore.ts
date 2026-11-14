import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { KeyboardMessagePanel, KeyboardMessageSlot, KeyboardMessageSlotUpdate } from '@tx5dr/contracts';

export const MESSAGE_PANEL_MAX_SLOTS = 12;
export const MESSAGE_PANEL_MIN_SLOTS = 3;
const DEFAULT_SLOT_COUNT = 8;
const DEFAULT_REPEAT_INTERVAL_SEC = 5;

export type MessagePanelPreset = Pick<KeyboardMessageSlot, 'label' | 'text' | 'repeatIntervalSec'>;

interface StoredManifest {
  version: 1;
  callsign: string;
  slotCount: number;
  slots: KeyboardMessageSlot[];
}

export interface MessagePanelStoreOptions {
  /**
   * Resolves the mode's data directory (e.g. `<data>/cw-keyer`). Each callsign
   * gets `<dir>/<CALL>/manifest.json`. The owning manager supplies it so that
   * the panels and the manager's own files always share one root.
   */
  getRootDir: () => Promise<string>;
  /** Default text for the first slots of a new panel. */
  presets: readonly MessagePanelPreset[];
  /** Label of a slot without a preset, e.g. `CW3`. */
  fallbackLabel: (index: number) => string;
  /** Used in error messages, e.g. `CW`. */
  modeLabel: string;
}

/**
 * Per-callsign message panels for keyboard modes.
 *
 * The on-disk format is shared by every keyboard mode and is the format CW
 * has always used; each mode keeps its own directory.
 */
export class MessagePanelStore {
  constructor(private readonly options: MessagePanelStoreOptions) {}

  static normalizeCallsign(callsign: string): string {
    return callsign.trim().toUpperCase();
  }

  static safeCallsign(callsign: string): string {
    return encodeURIComponent(MessagePanelStore.normalizeCallsign(callsign));
  }

  async getPanel(callsign: string): Promise<KeyboardMessagePanel> {
    return this.toPanel(await this.readManifest(this.requireCallsign(callsign)));
  }

  async updatePanel(callsign: string, slotCount: number): Promise<KeyboardMessagePanel> {
    const manifest = await this.readManifest(this.requireCallsign(callsign));
    manifest.slotCount = clampSlotCount(slotCount);
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async updateSlot(callsign: string, slotId: string, update: KeyboardMessageSlotUpdate): Promise<KeyboardMessagePanel> {
    const manifest = await this.readManifest(this.requireCallsign(callsign));
    const slot = this.requireSlot(manifest, slotId);
    if (typeof update.label === 'string') {
      slot.label = update.label.trim().slice(0, 32) || `M${slot.index}`;
    }
    if (typeof update.text === 'string') {
      slot.text = update.text.trim().slice(0, 500);
    }
    if (typeof update.repeatEnabled === 'boolean') {
      slot.repeatEnabled = update.repeatEnabled;
    }
    if (typeof update.repeatIntervalSec === 'number') {
      slot.repeatIntervalSec = Math.max(1, Math.min(300, Math.round(update.repeatIntervalSec)));
    }
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async deleteSlotText(callsign: string, slotId: string): Promise<KeyboardMessagePanel> {
    const manifest = await this.readManifest(this.requireCallsign(callsign));
    this.requireSlot(manifest, slotId).text = '';
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async swapSlots(callsign: string, slotIdA: string, slotIdB: string): Promise<KeyboardMessagePanel> {
    const manifest = await this.readManifest(this.requireCallsign(callsign));
    const slotA = this.requireSlot(manifest, slotIdA);
    const slotB = this.requireSlot(manifest, slotIdB);
    const contentA = { label: slotA.label, text: slotA.text, repeatEnabled: slotA.repeatEnabled, repeatIntervalSec: slotA.repeatIntervalSec };
    slotA.label = slotB.label;
    slotA.text = slotB.text;
    slotA.repeatEnabled = slotB.repeatEnabled;
    slotA.repeatIntervalSec = slotB.repeatIntervalSec;
    Object.assign(slotB, contentA);
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  /** Returns a slot or throws for an unknown slot id. */
  async getSlot(callsign: string, slotId: string): Promise<KeyboardMessageSlot> {
    return this.requireSlot(await this.readManifest(this.requireCallsign(callsign)), slotId);
  }

  /** Returns a slot, or null when it is unknown or the panel cannot be read. */
  async findSlot(callsign: string, slotId: string): Promise<KeyboardMessageSlot | null> {
    try {
      const manifest = await this.readManifest(this.requireCallsign(callsign));
      return manifest.slots.find((slot) => slot.id === slotId) ?? null;
    } catch {
      return null;
    }
  }

  requireCallsign(callsign: string): string {
    const normalized = MessagePanelStore.normalizeCallsign(callsign);
    if (!normalized) {
      throw new Error('Callsign is required');
    }
    return normalized;
  }

  private async getManifestPath(callsign: string): Promise<string> {
    return join(await this.options.getRootDir(), MessagePanelStore.safeCallsign(callsign), 'manifest.json');
  }

  private async readManifest(callsign: string): Promise<StoredManifest> {
    const manifestPath = await this.getManifestPath(callsign);
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return this.normalizeManifest(JSON.parse(raw), callsign);
    } catch {
      const manifest = this.createDefaultManifest(callsign);
      await this.writeManifest(manifest);
      return manifest;
    }
  }

  private async writeManifest(manifest: StoredManifest): Promise<void> {
    const manifestPath = await this.getManifestPath(manifest.callsign);
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(this.normalizeManifest(manifest, manifest.callsign), null, 2),
      'utf8',
    );
  }

  private normalizeManifest(raw: Partial<StoredManifest>, callsign: string): StoredManifest {
    const defaults = this.createDefaultManifest(callsign);
    const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
    const slots = defaults.slots.map((slot) => {
      const existing = rawSlots.find((candidate) => candidate?.id === slot.id);
      return {
        id: slot.id,
        index: slot.index,
        label: typeof existing?.label === 'string' && existing.label.trim()
          ? existing.label.trim().slice(0, 32) : slot.label,
        text: typeof existing?.text === 'string' ? existing.text.trim().slice(0, 500) : '',
        repeatEnabled: Boolean(existing?.repeatEnabled),
        repeatIntervalSec: Math.max(
          1,
          Math.min(300, Math.round(Number(existing?.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC))),
        ),
      };
    });
    return {
      version: 1,
      callsign,
      slotCount: clampSlotCount(Number(raw.slotCount ?? DEFAULT_SLOT_COUNT)),
      slots,
    };
  }

  private createDefaultManifest(callsign: string): StoredManifest {
    return {
      version: 1,
      callsign,
      slotCount: DEFAULT_SLOT_COUNT,
      slots: Array.from({ length: MESSAGE_PANEL_MAX_SLOTS }, (_, index) => {
        const preset = this.options.presets[index];
        return {
          id: String(index + 1),
          index: index + 1,
          label: preset?.label ?? this.options.fallbackLabel(index + 1),
          text: preset?.text ?? '',
          repeatEnabled: false,
          repeatIntervalSec: preset?.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC,
        };
      }),
    };
  }

  private toPanel(manifest: StoredManifest): KeyboardMessagePanel {
    return {
      callsign: manifest.callsign,
      slotCount: manifest.slotCount,
      maxSlotCount: MESSAGE_PANEL_MAX_SLOTS,
      slots: manifest.slots,
    };
  }

  private requireSlot(manifest: { slots: KeyboardMessageSlot[] }, slotId: string): KeyboardMessageSlot {
    const slot = manifest.slots.find((candidate) => candidate.id === slotId);
    if (!slot) {
      throw new Error(`Unknown ${this.options.modeLabel} message slot: ${slotId}`);
    }
    return slot;
  }
}

function clampSlotCount(value: number): number {
  return Math.max(MESSAGE_PANEL_MIN_SLOTS, Math.min(MESSAGE_PANEL_MAX_SLOTS, Math.round(Number.isFinite(value) ? value : DEFAULT_SLOT_COUNT)));
}
