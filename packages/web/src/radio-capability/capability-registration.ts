/** Generic types render automatically. Register only capability-specific behavior. */
import { registerCapabilityComponent } from './CapabilityRegistry';
import { TunerCapabilityControl } from './components/TunerCapability';

registerCapabilityComponent('tuner_switch', TunerCapabilityControl);
registerCapabilityComponent('tuner_tune', TunerCapabilityControl);
