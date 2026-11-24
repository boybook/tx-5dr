import { ConfigManager } from '../../config/config-manager.js';
import { PSKReporterReceptionService } from './PSKReporterReceptionService.js';
import { createPSKReporterReceptionTransport } from './receptionTransport.js';

export { PSKReporterReceptionService } from './PSKReporterReceptionService.js';
export type { ReceptionFollow } from './PSKReporterReceptionService.js';

let instance: PSKReporterReceptionService | null = null;

/** Process-wide reception feedback service backed by the stored Host setting. */
export function getPSKReporterReceptionService(): PSKReporterReceptionService {
  if (!instance) {
    instance = new PSKReporterReceptionService({
      transport: createPSKReporterReceptionTransport(),
      isEnabled: () => ConfigManager.getInstance().getPSKReporterReceptionConfig().enabled,
    });
  }
  return instance;
}
